// src/executor.ts
// Core mint-approve-sell automation engine.
// Runs per-user with a lock to prevent concurrent executions.
// All stop conditions are enforced before any on-chain writes.

import { ethers } from 'ethers';
import {
  readCostOf,
  readAiBalance,
  runPreflightChecks,
  simulateSellOutput,
  executeMint,
  executeApprove,
  executeSell,
  readSpaceIdName,
} from './bsc.js';
import {
  buildSignerFromSession,
  // FIX #6: removed unused `getSession` import
} from './wallet.js';
import { generateExecutionSummary } from './gemini.js';
import {
  insertExecution,
  pool, // FIX #5: static import replaces dynamic import('./db.js') inside hot path
} from './db.js';
import { logger } from './logger.js';

// ─── Per-user execution lock ──────────────────────────────────────────────────

const activeLocks = new Set<number>();

export function isUserLocked(userId: number): boolean {
  return activeLocks.has(userId);
}

// Cancellation flags per userId
const cancelFlags = new Map<number, boolean>();

export function requestCancelExecution(userId: number): void {
  cancelFlags.set(userId, true);
}

function isCancelled(userId: number): boolean {
  return cancelFlags.get(userId) === true;
}

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
  partialTxHashes?: Partial<Record<'mint' | 'approve' | 'sell', string>>;
}

export type ExecutionResult = ExecutionSuccess | ExecutionFailure;

// ─── 8% loss stop threshold ───────────────────────────────────────────────────
const STOP_LOSS_THRESHOLD = 0.92; // simulated sell < 92% of mint cost → STOP

// ─── Main executor ────────────────────────────────────────────────────────────

/**
 * Runs the full mint → approve → sell pipeline for a connected user.
 * Enforces all stop conditions before committing any on-chain transaction.
 * Returns a structured result that the bot handler uses to report to the user.
 */
export async function runFullExecution(
  userId: number,
): Promise<ExecutionResult> {
  if (activeLocks.has(userId)) {
    return { ok: false, reason: 'A job is already running for your account. Please wait.' };
  }

  activeLocks.add(userId);
  cancelFlags.set(userId, false);

  const txHashes: Partial<Record<'mint' | 'approve' | 'sell', string>> = {};

  try {
    // 1. Build signer from connected wallet session
    let signer: ethers.Signer;
    try {
      signer = await buildSignerFromSession(userId);
    } catch (e: unknown) {
      return { ok: false, reason: (e as Error).message };
    }

    const walletAddress = await signer.getAddress();

    // 2. Read live mint cost
    const mintCostWei = await readCostOf(10n);

    // 3. Preflight stop-condition checks
    const preflight = await runPreflightChecks(walletAddress, mintCostWei);
    if (!preflight.ok) {
      return { ok: false, reason: preflight.reason! };
    }

    if (isCancelled(userId)) {
      return { ok: false, reason: 'Cancelled by user before execution started.' };
    }

    // FIX #7: removed dead `aiBalanceBefore` read — it was read but never used.
    // The 8% check is correctly done AFTER mint using `tokensReceived`.

    // 5. Execute MINT
    logger.info({ userId, walletAddress }, 'Starting mint');
    const { tx: mintTx, tokensReceived, mintCostWei: actualCost } = await executeMint(
      signer,
      walletAddress,
      10n,
    );
    txHashes.mint = mintTx.hash;

    if (isCancelled(userId)) {
      await logExecution(userId, walletAddress, 'CANCELLED', actualCost, tokensReceived, 0n, txHashes);
      return {
        ok: false,
        reason: `Cancelled after mint. Mint TX: \`${mintTx.hash}\` already broadcast.`,
        partialTxHashes: txHashes,
      };
    }

    // 6. Post-mint 8% stop-loss check
    const simulatedSellBnb = await simulateSellOutput(tokensReceived);
    const mintCostF = parseFloat(ethers.formatEther(actualCost));
    const simulatedSellF = parseFloat(ethers.formatEther(simulatedSellBnb));

    if (simulatedSellBnb > 0n && simulatedSellF < mintCostF * STOP_LOSS_THRESHOLD) {
      const stopReason = `Simulated sell (${simulatedSellF.toFixed(5)} BNB) is more than 8% below mint cost (${mintCostF.toFixed(5)} BNB). Stopping to protect funds.`;
      await logExecution(userId, walletAddress, 'STOPPED', actualCost, tokensReceived, 0n, txHashes, stopReason);
      return {
        ok: false,
        reason: `⛔ ${stopReason}\n\n📋 Mint TX: \`${mintTx.hash}\``,
        partialTxHashes: txHashes,
      };
    }

    // 7. Execute APPROVE
    logger.info({ userId, tokensReceived: tokensReceived.toString() }, 'Approving AI tokens');
    const approveTx = await executeApprove(signer, tokensReceived);
    txHashes.approve = approveTx.hash;

    if (isCancelled(userId)) {
      await logExecution(userId, walletAddress, 'CANCELLED', actualCost, tokensReceived, 0n, txHashes);
      return {
        ok: false,
        reason: `Cancelled after approve. Mint TX: \`${mintTx.hash}\`, Approve TX: \`${approveTx.hash}\` already broadcast.`,
        partialTxHashes: txHashes,
      };
    }

    // 8. Execute SELL
    logger.info({ userId }, 'Selling AI tokens');
    const { tx: sellTx, bnbReceived } = await executeSell(signer, walletAddress, tokensReceived);
    txHashes.sell = sellTx.hash;

    // 9. Compute P&L
    const bnbReceivedF = parseFloat(ethers.formatEther(bnbReceived));
    const pnl = bnbReceivedF - mintCostF;

    // 10. Read Agent ID
    const agentId = await readSpaceIdName(walletAddress) || walletAddress;

    // 11. Persist to DB
    await logExecution(
      userId,
      walletAddress,
      'COMPLETED',
      actualCost,
      tokensReceived,
      bnbReceived,
      txHashes,
      undefined,
      agentId,
    );

    // 12. Generate AI summary
    const summary = await generateExecutionSummary({
      agentId,
      mintCostBnb: mintCostF.toFixed(6),
      tokensReceived: ethers.formatUnits(tokensReceived, 18),
      sellBnb: bnbReceivedF.toFixed(6),
      pnlOrFee: pnl.toFixed(6),
      mintTxHash: mintTx.hash,
      approveTxHash: approveTx.hash,
      sellTxHash: sellTx.hash,
      status: 'COMPLETED',
    });

    return {
      ok: true,
      summary,
      agentId,
      mintCostBnb: mintCostF.toFixed(6),
      tokensReceived: ethers.formatUnits(tokensReceived, 18),
      sellBnb: bnbReceivedF.toFixed(6),
      pnlOrFee: pnl.toFixed(6),
      mintTxHash: mintTx.hash,
      approveTxHash: approveTx.hash,
      sellTxHash: sellTx.hash,
    };
  } catch (err: unknown) {
    const e = err as Error;
    logger.error({ userId, err: e.message }, 'Execution failed');
    await logExecution(userId, '', 'FAILED', 0n, 0n, 0n, txHashes, e.message);
    return {
      ok: false,
      reason: `❌ Execution failed: ${e.message}`,
      partialTxHashes: txHashes,
    };
  } finally {
    activeLocks.delete(userId);
    cancelFlags.delete(userId);
  }
}

// ─── DB logging helper ────────────────────────────────────────────────────────

async function logExecution(
  userId: number,
  walletAddress: string,
  status: string,
  mintCostWei: bigint,
  tokensWei: bigint,
  sellWei: bigint,
  txHashes: Partial<Record<string, string>>,
  stopReason?: string,
  agentId?: string,
): Promise<void> {
  try {
    const mintCostBnb = parseFloat(ethers.formatEther(mintCostWei));
    const tokensF = parseFloat(ethers.formatUnits(tokensWei, 18));
    const sellBnbF = parseFloat(ethers.formatEther(sellWei));
    const pnl = sellBnbF - mintCostBnb;

    // FIX #8: agentId takes priority; fall back to walletAddress only when agentId
    // is undefined or empty string; never store an empty string as agent_id_name.
    const agentIdName: string | null =
      agentId && agentId.trim() !== '' ? agentId
      : walletAddress && walletAddress.trim() !== '' ? walletAddress
      : null;

    await insertExecution({
      telegram_user_id: userId,
      agent_id_name: agentIdName,
      status,
      mint_cost_bnb: mintCostBnb !== 0 ? mintCostBnb.toFixed(8) : null,
      tokens_received: tokensF !== 0 ? tokensF.toFixed(8) : null,
      sell_bnb: sellBnbF !== 0 ? sellBnbF.toFixed(8) : null,
      pnl_or_fee: pnl.toFixed(8),
      tx_hashes: Object.keys(txHashes).length > 0 ? (txHashes as Record<string, string>) : null,
      summary: stopReason ?? null,
    });

    if (status === 'COMPLETED') {
      // FIX #5: use statically-imported `pool` — no dynamic import in hot path.
      // Also removed the dead updateUser(completed_count: undefined) no-op call.
      await pool.query(
        'UPDATE users SET completed_count = completed_count + 1, last_active_at = now() WHERE telegram_user_id = $1',
        [userId],
      );
    }
  } catch (dbErr) {
    logger.error({ dbErr }, 'Failed to persist execution log');
  }
}
