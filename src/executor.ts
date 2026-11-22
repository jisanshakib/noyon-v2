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
  readCostOf, readBnbBalance, readAiBalance,
  runPreflightChecks, simulateSellOutput,
  buildMintCalldata, buildApproveCalldata, buildSellCalldata,
  isMintRaceError, ADDR,
} from './bsc.js';
import {
  isSessionConnectedDb, executeContractCall, getSession,
} from './wallet.js';
import { generateExecutionSummary } from './gemini.js';
import { insertExecution, pool } from './db.js';
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

  try {
    // ── 1. Verify wallet session (Supabase-authoritative) ─────────────────────
    await onStatus('🔍 Verifying wallet connection…');

    const { connected, address: walletAddress } = await isSessionConnectedDb(userId);
    if (!connected || !walletAddress) {
      return { ok: false, reason: 'Wallet not connected. Tap Connect Wallet and complete pairing first.' };
    }

    const session = getSession(userId);
    const agentId = session?.agentIdName ?? walletAddress;

    // ── 2. Read live mint cost ────────────────────────────────────────────────
    await onStatus('📡 Reading live mint cost from chain…');
    const mintCostWei = await readCostOf(10n);

    // ── 3. Preflight stop-condition checks ───────────────────────────────────
    await onStatus('🛡 Running preflight checks…');
    const preflight = await runPreflightChecks(walletAddress, mintCostWei);
    if (!preflight.ok) {
      return { ok: false, reason: `⛔ ${preflight.reason!}` };
    }

    if (isCancelled(userId)) {
      return { ok: false, reason: 'Cancelled by user before execution started.' };
    }

    // ── 4. MINT (with race retry) ─────────────────────────────────────────────
    let mintTxHash = '';
    let tokensReceived = 0n;
    let actualMintCost = mintCostWei;
    let mintAttempt = 0;

    while (mintAttempt < MAX_MINT_RETRIES) {
      mintAttempt++;
      await onStatus(
        `🔄 Minting (attempt ${mintAttempt}/${MAX_MINT_RETRIES})…\n` +
        `Mint cost: ${ethers.formatEther(actualMintCost)} BNB`,
      );

      try {
        const { inputData, value, maxCost } = await buildMintCalldata(10n);
        actualMintCost = maxCost;

        const result = await executeContractCall({
          userId,
          walletAddress,
          to:        ADDR.MINT_CONTRACT,
          inputData,
          value,
          gasLimit:  300_000,
        });

        mintTxHash = result.txHash;
        txHashes.mint = mintTxHash;

        // Read actual tokens received after mint lands
        await onStatus(`⏳ Mint submitted (${mintTxHash.slice(0, 10)}…). Waiting for confirmation…`);
        // baw execute blocks until confirmed; now read balance
        tokensReceived = await readAiBalance(walletAddress);

        logger.info({ userId, mintTxHash, tokensReceived: tokensReceived.toString() }, 'Mint confirmed');
        break; // success

      } catch (err) {
        const e = err as Error & { isSessionExpired?: boolean };
        if (e.isSessionExpired) {
          return { ok: false, isSessionExpired: true,
            reason: 'Binance Wallet session expired during mint. Please reconnect.',
            partialTxHashes: txHashes };
        }
        if (isMintRaceError(err)) {
          logger.warn({ userId, attempt: mintAttempt }, 'Mint race (expectedStart mismatch) — retrying');
          if (mintAttempt < MAX_MINT_RETRIES) {
            await onStatus(`⚡ Mint race detected — retrying (${mintAttempt}/${MAX_MINT_RETRIES})…`);
            continue;
          }
          return { ok: false, reason: `Mint failed after ${MAX_MINT_RETRIES} attempts due to chain congestion. Please try again.`, partialTxHashes: txHashes };
        }
        throw err; // other errors bubble up
      }
    }

    if (isCancelled(userId)) {
      await logExecution(userId, walletAddress, 'CANCELLED', actualMintCost, tokensReceived, 0n, txHashes, agentId);
      return { ok: false, reason: `Cancelled after mint. Mint TX: ${mintTxHash} already broadcast.`, partialTxHashes: txHashes };
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

    // ── 6. APPROVE ────────────────────────────────────────────────────────────
    await onStatus(`✅ Mint confirmed — ${ethers.formatUnits(tokensReceived, 18)} AI tokens received.\n🔐 Approving AI → PancakeSwap Router…`);

    const approveData   = buildApproveCalldata(tokensReceived);
    const approveResult = await executeContractCall({
      userId, walletAddress,
      to: ADDR.AI_TOKEN, inputData: approveData, value: 0n, gasLimit: 100_000,
    }).catch((e: Error & { isSessionExpired?: boolean }) => {
      if (e.isSessionExpired) throw Object.assign(e, { step: 'approve' });
      throw e;
    });
    txHashes.approve = approveResult.txHash;

    if (isCancelled(userId)) {
      await logExecution(userId, walletAddress, 'CANCELLED', actualMintCost, tokensReceived, 0n, txHashes, agentId);
      return { ok: false, reason: `Cancelled after approve. Mint: ${mintTxHash}, Approve: ${approveResult.txHash}`, partialTxHashes: txHashes };
    }

    // ── 7. SELL ───────────────────────────────────────────────────────────────
    await onStatus(`💱 Selling ${ethers.formatUnits(tokensReceived, 18)} AI tokens on PancakeSwap V2…`);

    const bnbBefore  = await readBnbBalance(walletAddress);
    const sellData   = buildSellCalldata(tokensReceived, walletAddress);
    const sellResult = await executeContractCall({
      userId, walletAddress,
      to: ADDR.PANCAKE_ROUTER, inputData: sellData, value: 0n, gasLimit: 300_000,
    }).catch((e: Error & { isSessionExpired?: boolean }) => {
      if (e.isSessionExpired) throw Object.assign(e, { step: 'sell' });
      throw e;
    });
    txHashes.sell = sellResult.txHash;

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
      approveTxHash:  approveResult.txHash,
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
      approveTxHash:  approveResult.txHash,
      sellTxHash:     sellResult.txHash,
    };

  } catch (err: unknown) {
    const e   = err as Error & { isSessionExpired?: boolean; step?: string };
    const msg = e.message ?? String(err);
    logger.error({ userId, err: msg }, 'Execution failed');
    if (e.isSessionExpired) {
      return { ok: false, isSessionExpired: true,
        reason: `Binance Wallet session expired during ${e.step ?? 'execution'}. Please reconnect and try again.`,
        partialTxHashes: txHashes };
    }
    await logExecution(userId, '', 'FAILED', 0n, 0n, 0n, txHashes, '').catch(() => {});
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
