// src/executor.ts
// ═══════════════════════════════════════════════════════════════════════
// LAYER 3: Cycle Engine — deterministic mint → approve → sell pipeline
//
// Runs automatically without step-by-step confirmations.
// Live status updates are pushed via the `onStatus` callback so the
// Telegram handler can edit a single message rather than spam new ones.
//
// Stop conditions (checked before ANY on-chain write):
//   - No .ai Agent ID on wallet
//   - Insufficient BNB (< mintCost + 0.01 BNB gas buffer)
//   - Developer mode not enabled
//   - Mint quota exhausted
//   - Simulated sell < 92% of mint cost (8% stop-loss)
//
// Retry logic:
//   - Mint race (0x5fb01790 / expectedStart mismatch): re-read totalMinted
//     and retry up to MAX_MINT_RETRIES times before aborting.
//   - baw SESSION_EXPIRED: propagates immediately so caller can re-pair.
// ═══════════════════════════════════════════════════════════════════════

import { ethers } from 'ethers';
import {
  readCostOf, readBnbBalance, readAiBalance, readAiAllowance,
  readTxValueWei, waitForTxConfirmation, normalizeAddress,
  runPreflightChecks, simulateSellOutput, simulateContractCall, isValidAiAgentId,
  buildMintCalldata, buildApproveCalldata, buildSellCalldata,
  isMintRaceError, isMintPriceMismatchError, GAS_BUFFER, ADDR,
} from './bsc.js';
import {
  isSessionConnectedDb, executeContractCall, getSession, fetchBawAgentId, getBawWalletSettings, syncAgentId,
} from './wallet.js';
import { generateExecutionSummary } from './gemini.js';
import { insertExecution, getLatestUnfinishedMint, pool } from './db.js';
import { logger } from './logger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_MINT_RETRIES   = 5;
const STOP_LOSS_RATIO    = 0.92; // stop if simulated sell < 92% of mint cost

// ─── Per-user execution lock ──────────────────────────────────────────────────

const activeLocks  = new Set<number>();
const cancelFlags  = new Map<number, boolean>();

export function isUserLocked(userId: number): boolean { return activeLocks.has(userId); }
export function requestCancelExecution(userId: number): void { cancelFlags.set(userId, true); }
function isCancelled(userId: number): boolean { return cancelFlags.get(userId) === true; }

// ─── Result types ─────────────────────────────────────────────────────────────

export interface ExecutionSuccess {
  ok: true;
  summary: string;
  agentId: string;
  mintCostBnb: string;
  tokensReceived: string;
  sellBnb: string;
  pnlOrFee: string;
  mintTxHash: string;
  approveTxHash: string;
  sellTxHash: string;
}

export interface ExecutionFailure {
  ok: false;
  reason: string;
  isSessionExpired?: boolean;
  partialTxHashes?: Partial<Record<'mint' | 'approve' | 'sell', string>>;
}

export type ExecutionResult = ExecutionSuccess | ExecutionFailure;

/** Called by the handler to edit the live status message. */
export type StatusUpdater = (text: string) => Promise<void>;

// ─── Main cycle engine ────────────────────────────────────────────────────────

export async function runFullExecution(
  userId: number,
  onStatus: StatusUpdater,
): Promise<ExecutionResult> {

  if (activeLocks.has(userId)) {
    return { ok: false, reason: 'A job is already running for your account. Please wait.' };
  }

  activeLocks.add(userId);
  cancelFlags.set(userId, false);

  const txHashes: Partial<Record<'mint' | 'approve' | 'sell', string>> = {};
  let resolvedWallet = '';
  let resolvedAgentId = '';
  let trackedMintCostWei = 0n;
  let trackedTokensWei   = 0n;

  try {
    // ── 1. Verify wallet session (Supabase-authoritative) ─────────────────────
    await onStatus('🔍 Verifying wallet connection…');

    const { connected, address: rawWalletAddress, dbAgentId } = await isSessionConnectedDb(userId);
    if (!connected || !rawWalletAddress) {
      return { ok: false, reason: 'Wallet not connected. Tap Connect Wallet and complete pairing first.' };
    }

    const walletAddress = normalizeAddress(rawWalletAddress, 'executor.walletAddress');
    resolvedWallet = walletAddress;
    const session = getSession(userId);
    const sessionAgentId = session?.agentIdName?.trim() || '';
    const persistedAgentId = dbAgentId?.trim() || '';

    // If neither memory session nor DB has a valid *.ai Agent ID, re-query `baw wallet agent-id`
    let bawAgentId = '';
    if (!isValidAiAgentId(sessionAgentId) && !isValidAiAgentId(persistedAgentId)) {
      bawAgentId = (await fetchBawAgentId(userId))?.trim() || '';
    }

    let agentId =
      (isValidAiAgentId(sessionAgentId) ? sessionAgentId : '') ||
      (isValidAiAgentId(persistedAgentId) ? persistedAgentId : '') ||
      (isValidAiAgentId(bawAgentId) ? bawAgentId : '') ||
      walletAddress;
    resolvedAgentId = agentId;

    // ── 2. Read live mint cost, wallet settings, & check for existing unsold mint ──
    await onStatus('📡 Reading live mint cost, AI balance & wallet settings…');
    const [mintCostWei, bawSettingsRes, existingAiBalance, unfinishedMint] = await Promise.all([
      readCostOf(10n),
      getBawWalletSettings(userId),
      readAiBalance(walletAddress),
      getLatestUnfinishedMint(userId),
    ]);

    const resumingExistingMint = existingAiBalance > 0n;
    const priorMintTxHash = unfinishedMint?.tx_hashes?.mint ?? '';

    if (resumingExistingMint) {
      logger.info(
        {
          userId,
          walletAddress,
          existingAiBalance: ethers.formatUnits(existingAiBalance, 18),
          priorMintTxHash: priorMintTxHash || null,
          priorExecId: unfinishedMint?.id ?? null,
        },
        'Detected unsold AI tokens on-chain — will skip mint and resume Approve → Sell',
      );
    }

    // ── 3. Preflight stop-condition checks ───────────────────────────────────
    await onStatus('🛡 Running preflight checks…');
    const preflight = await runPreflightChecks(walletAddress, mintCostWei, {
      sessionAgentId: sessionAgentId || null,
      dbAgentId: persistedAgentId || null,
      bawAgentId: bawAgentId || null,
      bawSettings: bawSettingsRes.ok ? bawSettingsRes.settings : null,
      bawSettingsError: bawSettingsRes.ok ? null : bawSettingsRes.error,
      skipMintCostBalanceCheck: resumingExistingMint,
    });
    if (preflight.resolvedAgentId) {
      agentId = preflight.resolvedAgentId;
      resolvedAgentId = agentId;
      await syncAgentId(userId, agentId);
    }
    if (!preflight.ok) {
      const reason = preflight.reason ?? 'Preflight check failed.';
      await logExecution(userId, walletAddress, 'STOPPED', 0n, 0n, 0n, txHashes, agentId, reason);
      return { ok: false, reason: `⛔ ${reason}` };
    }

    if (isCancelled(userId)) {
      const cancelReason = 'Cancelled by user before execution started.';
      await logExecution(userId, walletAddress, 'CANCELLED', 0n, 0n, 0n, txHashes, agentId, cancelReason);
      return { ok: false, reason: cancelReason };
    }

    // ── 4. MINT (or RESUME from already-broadcast mint with unsold AI tokens) ──
    let mintTxHash = '';
    let tokensReceived = 0n;
    let actualMintCost = 0n;

    if (resumingExistingMint) {
      tokensReceived   = existingAiBalance;
      trackedTokensWei = tokensReceived;
      mintTxHash       = priorMintTxHash || 'resumed-onchain-balance';
      if (priorMintTxHash) txHashes.mint = priorMintTxHash;

      // Recover exact BNB spent on the prior mint TX (DB record → on-chain tx.value → live cost benchmark)
      if (unfinishedMint?.mint_cost_bnb && parseFloat(unfinishedMint.mint_cost_bnb) > 0) {
        try {
          actualMintCost = ethers.parseEther(unfinishedMint.mint_cost_bnb);
        } catch { /* fallback below */ }
      }
      if (actualMintCost === 0n && priorMintTxHash) {
        const onChainVal = await readTxValueWei(priorMintTxHash);
        if (onChainVal != null && onChainVal > 0n) actualMintCost = onChainVal;
      }
      if (actualMintCost === 0n) {
        actualMintCost = mintCostWei;
      }
      trackedMintCostWei = actualMintCost;

      await onStatus(
        `♻️ Found existing unsold AI tokens (${ethers.formatUnits(tokensReceived, 18)} AI)` +
        (priorMintTxHash ? ` from Mint TX ${priorMintTxHash.slice(0, 12)}…` : '') +
        `.\nSkipping re-mint and resuming Approve → Sell…`,
      );
      logger.info(
        {
          userId,
          step: 'resume_from_mint',
          mintTxHash,
          recoveredMintCostBnb: ethers.formatEther(actualMintCost),
          tokensReceived: ethers.formatUnits(tokensReceived, 18),
        },
        'Resuming cycle after already-broadcast mint',
      );
    } else {
      let mintAttempt = 0;

      while (mintAttempt < MAX_MINT_RETRIES) {
        mintAttempt++;

        try {
          // Always resolve the LIVE on-chain mint price & totalMinted right before each attempt
          // (never reuse stale preflight or previous-attempt cost as share prices rise over time).
          const [{ inputData, value, maxCost, expectedStart }, liveBnbBal] = await Promise.all([
            buildMintCalldata(10n),
            readBnbBalance(walletAddress),
          ]);
          actualMintCost     = maxCost;
          trackedMintCostWei = maxCost;

          const liveCostBnb = ethers.formatEther(maxCost);
          const neededBnb   = maxCost + GAS_BUFFER;

          await onStatus(
            `🔄 Minting (attempt ${mintAttempt}/${MAX_MINT_RETRIES})…\n` +
            `Live mint cost: ${liveCostBnb} BNB`,
          );

          logger.info(
            {
              userId,
              step: 'mint',
              attempt: mintAttempt,
              to: ADDR.MINT_CONTRACT,
              shares: '10',
              referrer: ADDR.REFERRER,
              preflightCostBnb: ethers.formatEther(mintCostWei),
              liveMintCostBnb: liveCostBnb,
              priceMovedSincePreflight: maxCost !== mintCostWei,
              liveBnbBalance: ethers.formatEther(liveBnbBal),
              expectedStart: expectedStart.toString(),
            },
            'Prepared live mint calldata',
          );

          // Re-check balance against the fresh live mint cost right before executing
          if (liveBnbBal < neededBnb) {
            const balReason =
              `Insufficient BNB for live mint price. Need ≥ ${ethers.formatEther(neededBnb)} BNB ` +
              `(live mint cost ${liveCostBnb} BNB + gas buffer), have ${ethers.formatEther(liveBnbBal)} BNB.`;
            await logExecution(userId, walletAddress, 'STOPPED', 0n, 0n, 0n, txHashes, agentId, balReason);
            return { ok: false, reason: `⛔ ${balReason}`, partialTxHashes: txHashes };
          }

          // Read-only BSC RPC simulation: estimates dynamic gas and catches contract reverts
          // (including 0x5fb01790 expectedStart race or live price increase) before broadcast.
          const mintSim = await simulateContractCall({
            step:  'mint',
            from:  walletAddress,
            to:    ADDR.MINT_CONTRACT,
            data:  inputData,
            value,
          });

          if (!mintSim.ok && mintSim.isRevert) {
            const simErr = { data: mintSim.revertData, message: mintSim.revertReason ?? mintSim.error };
            if (isMintRaceError(simErr) || isMintPriceMismatchError(simErr)) {
              throw Object.assign(
                new Error(`Mint state changed during RPC simulation (${mintSim.revertReason ?? '0x5fb01790'})`),
                { data: mintSim.revertData },
              );
            }
            const revertMsg =
              `Mint contract simulation reverted before broadcast` +
              (mintSim.revertReason ? `: ${mintSim.revertReason}` : '') +
              (mintSim.revertData ? ` (data: ${mintSim.revertData.slice(0, 18)})` : '') +
              `. Check wallet eligibility, mint quota, or contract parameters.`;
            await logExecution(userId, walletAddress, 'FAILED', 0n, 0n, 0n, txHashes, agentId, revertMsg);
            return { ok: false, reason: `⛔ ${revertMsg}`, partialTxHashes: txHashes };
          }

          // Dynamic gasLimit = estimateGas * 1.4 (or 900k fallback ceiling if RPC estimate unavailable),
          // with automatic single retry at a higher buffer if baw preview returns 351805.
          const result = await executeContractCall({
            userId,
            step:             'mint',
            walletAddress,
            to:               ADDR.MINT_CONTRACT,
            inputData,
            value,
            rpcEstimatedGas:  mintSim.estimatedGas,
            fallbackGasLimit: 900_000,
          });

          mintTxHash = result.txHash;
          txHashes.mint = mintTxHash;

          // Wait for BSC confirmation so readAiBalance sees the newly minted tokens reliably
          await onStatus(`⏳ Mint submitted (${mintTxHash.slice(0, 10)}…). Waiting for confirmation…`);
          await waitForTxConfirmation(mintTxHash, 30_000);

          for (let poll = 0; poll < 4; poll++) {
            tokensReceived = await readAiBalance(walletAddress);
            if (tokensReceived > 0n) break;
            await new Promise((r) => setTimeout(r, 1500));
          }
          trackedTokensWei = tokensReceived;

          if (tokensReceived === 0n) {
            const zeroReason = `Mint TX ${mintTxHash} broadcast, but AI token balance is still 0. Tap Complete All Process again once confirmed to resume Approve → Sell.`;
            await logExecution(userId, walletAddress, 'FAILED', actualMintCost, 0n, 0n, txHashes, agentId, zeroReason);
            return { ok: false, reason: `⚠️ ${zeroReason}`, partialTxHashes: txHashes };
          }

          logger.info(
            {
              userId,
              step: 'mint',
              mintTxHash,
              liveMintCostBnb: liveCostBnb,
              appliedGasLimit: result.appliedGasLimit,
              tokensReceived: tokensReceived.toString(),
            },
            'Mint confirmed',
          );
          break; // success

        } catch (err) {
          const e = err as Error & { isSessionExpired?: boolean };
          if (e.isSessionExpired) {
            const expReason = 'Binance Wallet session expired during mint. Please reconnect.';
            await logExecution(userId, walletAddress, 'FAILED', 0n, 0n, 0n, txHashes, agentId, expReason);
            return { ok: false, isSessionExpired: true,
              reason: expReason,
              partialTxHashes: txHashes };
          }
          if (isMintRaceError(err) || isMintPriceMismatchError(err)) {
            logger.warn(
              { userId, attempt: mintAttempt, err: e.message.slice(0, 200) },
              'Mint race / live price change detected — refreshing live cost & totalMinted',
            );
            if (mintAttempt < MAX_MINT_RETRIES) {
              await onStatus(`⚡ Mint price/state moved — refreshing live cost & retrying (${mintAttempt}/${MAX_MINT_RETRIES})…`);
              continue;
            }
            const raceReason = `Mint failed after ${MAX_MINT_RETRIES} attempts due to chain congestion or price movement. Please try again.`;
            await logExecution(userId, walletAddress, 'FAILED', 0n, 0n, 0n, txHashes, agentId, raceReason);
            return { ok: false, reason: raceReason, partialTxHashes: txHashes };
          }
          throw err; // other errors bubble up
        }
      }
    }

    if (isCancelled(userId)) {
      const cancelReason = `Cancelled after mint. Mint TX: ${mintTxHash} already broadcast.`;
      await logExecution(userId, walletAddress, 'CANCELLED', actualMintCost, tokensReceived, 0n, txHashes, agentId, cancelReason);
      return { ok: false, reason: cancelReason, partialTxHashes: txHashes };
    }

    // ── 5. Post-mint 8% stop-loss check ──────────────────────────────────────
    await onStatus('📊 Simulating sell output (stop-loss check)…');
    const simulatedSellWei  = await simulateSellOutput(tokensReceived);
    const mintCostF         = parseFloat(ethers.formatEther(actualMintCost));
    const simulatedSellF    = parseFloat(ethers.formatEther(simulatedSellWei));

    if (simulatedSellWei > 0n && simulatedSellF < mintCostF * STOP_LOSS_RATIO) {
      const stopReason =
        `Simulated sell (${simulatedSellF.toFixed(5)} BNB) is more than 8% ` +
        `below mint cost (${mintCostF.toFixed(5)} BNB). Stopping to protect funds.`;
      await logExecution(userId, walletAddress, 'STOPPED', actualMintCost, tokensReceived, 0n, txHashes, agentId, stopReason);
      return {
        ok: false,
        reason: `⛔ ${stopReason}\n\nMint TX: ${mintTxHash}`,
        partialTxHashes: txHashes,
      };
    }

    // ── 6. APPROVE (exact amount, skips only if exact/sufficient allowance already set) ──
    const currentAllowance = await readAiAllowance(walletAddress, ADDR.PANCAKE_ROUTER);
    let approveTxHash = unfinishedMint?.tx_hashes?.approve ?? '';

    if (currentAllowance >= tokensReceived) {
      if (!approveTxHash) approveTxHash = 'already-approved';
      else txHashes.approve = approveTxHash;
      logger.info(
        {
          userId,
          step: 'approve',
          token: ADDR.AI_TOKEN,
          spender: ADDR.PANCAKE_ROUTER,
          currentAllowance: currentAllowance.toString(),
          tokensReceived: tokensReceived.toString(),
        },
        'Sufficient AI allowance already present — skipping approve tx',
      );
      await onStatus(`✅ Allowance already active for ${ethers.formatUnits(tokensReceived, 18)} AI tokens.\nProceeding to sell…`);
    } else {
      await onStatus(
        `${resumingExistingMint ? '♻️ Resuming' : '✅ Mint confirmed'} — ${ethers.formatUnits(tokensReceived, 18)} AI tokens.\n` +
        `🔐 Approving exact AI amount → PancakeSwap Router…`,
      );

      logger.info(
        {
          userId,
          step: 'approve',
          token: ADDR.AI_TOKEN,
          spender: ADDR.PANCAKE_ROUTER,
          walletAddress,
          amount: tokensReceived.toString(),
        },
        'Prepared approve calldata with normalized addresses',
      );

      const approveData   = buildApproveCalldata(tokensReceived);
      const approveSim    = await simulateContractCall({
        step: 'approve', from: walletAddress, to: ADDR.AI_TOKEN, data: approveData, value: 0n,
      });
      const approveResult = await executeContractCall({
        userId,
        step: 'approve',
        walletAddress,
        to: ADDR.AI_TOKEN,
        inputData: approveData,
        value: 0n,
        rpcEstimatedGas: approveSim.estimatedGas,
        fallbackGasLimit: 180_000,
      }).catch((e: Error & { isSessionExpired?: boolean }) => {
        if (e.isSessionExpired) throw Object.assign(e, { step: 'approve' });
        throw e;
      });
      approveTxHash    = approveResult.txHash;
      txHashes.approve = approveTxHash;

      await onStatus(`⏳ Approve submitted (${approveTxHash.slice(0, 10)}…). Waiting for confirmation…`);
      await waitForTxConfirmation(approveTxHash, 30_000);
    }

    if (isCancelled(userId)) {
      const cancelReason = `Cancelled after approve. Mint: ${mintTxHash}, Approve: ${approveTxHash}`;
      await logExecution(userId, walletAddress, 'CANCELLED', actualMintCost, tokensReceived, 0n, txHashes, agentId, cancelReason);
      return { ok: false, reason: cancelReason, partialTxHashes: txHashes };
    }

    // ── 7. SELL ───────────────────────────────────────────────────────────────
    await onStatus(`💱 Selling ${ethers.formatUnits(tokensReceived, 18)} AI tokens on PancakeSwap V2…`);

    logger.info(
      {
        userId,
        step: 'sell',
        router: ADDR.PANCAKE_ROUTER,
        tokenIn: ADDR.AI_TOKEN,
        tokenOut: ADDR.WBNB,
        recipient: walletAddress,
        amountIn: tokensReceived.toString(),
      },
      'Prepared sell calldata with normalized addresses',
    );

    const bnbBefore  = await readBnbBalance(walletAddress);
    const sellData   = buildSellCalldata(tokensReceived, walletAddress);
    const sellSim    = await simulateContractCall({
      step: 'sell', from: walletAddress, to: ADDR.PANCAKE_ROUTER, data: sellData, value: 0n,
    });
    const sellResult = await executeContractCall({
      userId,
      step: 'sell',
      walletAddress,
      to: ADDR.PANCAKE_ROUTER,
      inputData: sellData,
      value: 0n,
      rpcEstimatedGas: sellSim.estimatedGas,
      fallbackGasLimit: 650_000,
    }).catch((e: Error & { isSessionExpired?: boolean }) => {
      if (e.isSessionExpired) throw Object.assign(e, { step: 'sell' });
      throw e;
    });
    txHashes.sell = sellResult.txHash;

    await onStatus(`⏳ Sell submitted (${sellResult.txHash.slice(0, 10)}…). Confirming proceeds…`);
    await waitForTxConfirmation(sellResult.txHash, 30_000);

    // ── 8. Compute actual BNB received ────────────────────────────────────────
    const bnbAfter   = await readBnbBalance(walletAddress);
    const bnbReceived = bnbAfter > bnbBefore ? bnbAfter - bnbBefore : 0n;
    const bnbReceivedF = parseFloat(ethers.formatEther(bnbReceived));
    const pnl          = bnbReceivedF - mintCostF;

    // ── 9. Persist to DB ──────────────────────────────────────────────────────
    await logExecution(userId, walletAddress, 'COMPLETED', actualMintCost, tokensReceived, bnbReceived, txHashes, agentId);

    // ── 10. Gemini summary (single call, free-tier-safe) ─────────────────────
    await onStatus('✍️ Generating summary…');
    const summary = await generateExecutionSummary({
      agentId,
      mintCostBnb:    mintCostF.toFixed(6),
      tokensReceived: ethers.formatUnits(tokensReceived, 18),
      sellBnb:        bnbReceivedF.toFixed(6),
      pnlOrFee:       pnl.toFixed(6),
      mintTxHash:     mintTxHash,
      approveTxHash:  approveTxHash,
      sellTxHash:     sellResult.txHash,
      status:         'COMPLETED',
    });

    return {
      ok: true,
      summary,
      agentId,
      mintCostBnb:    mintCostF.toFixed(6),
      tokensReceived: ethers.formatUnits(tokensReceived, 18),
      sellBnb:        bnbReceivedF.toFixed(6),
      pnlOrFee:       pnl.toFixed(6),
      mintTxHash,
      approveTxHash,
      sellTxHash:     sellResult.txHash,
    };

  } catch (err: unknown) {
    const e   = err as Error & { isSessionExpired?: boolean; step?: string };
    const msg = e.message ?? String(err);
    logger.error({ userId, err: msg, txHashes }, 'Execution failed');
    if (e.isSessionExpired) {
      const expReason = `Binance Wallet session expired during ${e.step ?? 'execution'}. Please reconnect and try again.`;
      await logExecution(userId, resolvedWallet, 'FAILED', trackedMintCostWei, trackedTokensWei, 0n, txHashes, resolvedAgentId, expReason).catch(() => {});
      return { ok: false, isSessionExpired: true,
        reason: expReason,
        partialTxHashes: txHashes };
    }
    await logExecution(userId, resolvedWallet, 'FAILED', trackedMintCostWei, trackedTokensWei, 0n, txHashes, resolvedAgentId, msg.slice(0, 300)).catch(() => {});
    return { ok: false, reason: `Execution failed: ${msg}`, partialTxHashes: txHashes };

  } finally {
    activeLocks.delete(userId);
    cancelFlags.delete(userId);
  }
}

// ─── DB persistence ───────────────────────────────────────────────────────────

async function logExecution(
  userId: number,
  walletAddress: string,
  status: string,
  mintCostWei: bigint,
  tokensWei: bigint,
  sellWei: bigint,
  txHashes: Partial<Record<string, string>>,
  agentId: string,
  stopReason?: string,
): Promise<void> {
  try {
    const mintCostBnb = parseFloat(ethers.formatEther(mintCostWei));
    const tokensF     = parseFloat(ethers.formatUnits(tokensWei, 18));
    const sellBnbF    = parseFloat(ethers.formatEther(sellWei));
    const pnl         = sellBnbF - mintCostBnb;

    const agentIdName: string | null =
      agentId?.trim() ? agentId.trim()
      : walletAddress?.trim() ? walletAddress.trim()
      : null;

    await insertExecution({
      telegram_user_id: userId,
      agent_id_name:    agentIdName,
      status,
      mint_cost_bnb:    mintCostBnb !== 0 ? mintCostBnb.toFixed(8) : null,
      tokens_received:  tokensF     !== 0 ? tokensF.toFixed(8)     : null,
      sell_bnb:         sellBnbF    !== 0 ? sellBnbF.toFixed(8)    : null,
      pnl_or_fee:       pnl.toFixed(8),
      tx_hashes: Object.keys(txHashes).length > 0
        ? (txHashes as Record<string, string>) : null,
      summary: stopReason ?? null,
    });

    if (status === 'COMPLETED') {
      await pool.query(
        'UPDATE users SET completed_count = completed_count + 1, last_active_at = now() WHERE telegram_user_id = $1',
        [userId],
      );
    }
  } catch (dbErr) {
    logger.error({ dbErr }, 'logExecution: DB write failed');
  }
}
