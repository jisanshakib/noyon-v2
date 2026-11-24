// src/handlers/wallet.ts — /connect flow with live QR, background verification,
// and immediate JAGER contract eligibility & 1-time-per-ID/wallet checks.

import { Context } from 'telegraf';
import {
  bawAvailable,
  generatePairingUri,
  verifyAndBindSession,
  syncAgentId,
} from '../wallet.js';
import {
  ADDR,
  checkWalletFreshness,
  JAGER_ALREADY_COMPLETED_MESSAGE,
} from '../bsc.js';
import { generateQrBuffer } from '../qr.js';
import {
  safeUpdateUser,
  hasCompletedCycleForAgent,
} from '../db.js';
import { KB } from '../keyboards.js';
import { logger } from '../logger.js';

async function safeAnswerCb(ctx: Context, text?: string): Promise<void> {
  try { if (ctx.callbackQuery) await ctx.answerCbQuery(text); } catch { /* ok */ }
}

/**
 * Authoritative on-connect eligibility check scoped strictly to the current
 * JAGER Mint Contract (`0x3643A907f875fA9B740e1C0747E91b5aA5222aB8`):
 *   1. Checks PostgreSQL for a COMPLETED JAGER execution on this `.ai` ID / wallet
 *      (ignores legacy SPACE ID / BNB rows) → blocks with clear 1-time-per-ID limit message.
 *   2. Checks on-chain `JagentMintV2` (`registrar`, `mintedCount`, `quotaOf`, `paidOnce`, `paused`)
 *      + live `jager.live/api/agent/status` → immediately blocks ineligible wallets
 *      (`NO_AGENT_ID`, `ALREADY_MINTED`, `INSUFFICIENT_QUOTA`, `MINT_PAUSED`, `CHECK_UNAVAILABLE`)
 *      with a clear bilingual "Wallet Not Eligible" notification so users cannot enter a broken cycle.
 */
async function checkConnectedWalletStatus(
  userId: number,
  walletAddress: string,
  agentIdName?: string,
): Promise<
  | { blocked: true; message: string; keyboard: typeof KB.start }
  | { blocked: false; resolvedAgentId?: string; freshnessNote: string }
> {
  const [localCompleted, freshness] = await Promise.all([
    hasCompletedCycleForAgent({
      mintContract: ADDR.MINT_CONTRACT,
      agentIdName: agentIdName ?? null,
      walletAddress,
    }),
    checkWalletFreshness(walletAddress),
  ]);

  const resolvedAgentId = freshness.agentId || agentIdName || undefined;
  if (resolvedAgentId && resolvedAgentId !== agentIdName) {
    await syncAgentId(userId, resolvedAgentId);
  }

  // Re-check DB lock using the on-chain resolved .ai Agent ID if not known before
  if (!localCompleted.completed && resolvedAgentId && resolvedAgentId !== agentIdName) {
    const resolvedCompleted = await hasCompletedCycleForAgent({
      mintContract: ADDR.MINT_CONTRACT,
      agentIdName: resolvedAgentId,
      walletAddress,
    });
    if (resolvedCompleted.completed) {
      logger.info(
        { userId, walletAddress, resolvedAgentId, matchedBy: resolvedCompleted.matchedBy },
        'Wallet connect blocked: resolved .ai Agent ID already completed JAGER cycle',
      );
      return {
        blocked: true,
        message: JAGER_ALREADY_COMPLETED_MESSAGE,
        keyboard: KB.start,
      };
    }
  }

  if (localCompleted.completed) {
    logger.info(
      { userId, walletAddress, agentIdName: resolvedAgentId, matchedBy: localCompleted.matchedBy },
      'Wallet connect blocked: Agent ID / Wallet already completed JAGER full cycle (1-time limit)',
    );
    return {
      blocked: true,
      message: JAGER_ALREADY_COMPLETED_MESSAGE,
      keyboard: KB.start,
    };
  }

  if (!freshness.fresh) {
    logger.info(
      {
        userId,
        walletAddress,
        mintContract: ADDR.MINT_CONTRACT,
        agentIdName: resolvedAgentId ?? null,
        reasonCode: freshness.reasonCode,
        minted: freshness.minted.toString(),
        remaining: freshness.remaining.toString(),
      },
      'Wallet connect blocked: wallet is not eligible on JAGER contract',
    );
    return {
      blocked: true,
      message: freshness.userMessage ?? `⛔ আপনার ওয়ালেট নট ইলিজিবল (Wallet Not Eligible)\n\n${freshness.reason ?? 'Wallet does not meet JAGER eligibility requirements.'}`,
      keyboard: KB.start,
    };
  }

  return {
    blocked: false,
    resolvedAgentId,
    freshnessNote: `Eligible ✅ (minted: ${freshness.minted.toString()}, remaining: ${freshness.remaining.toString()} | Limit: 1 cycle per ID/wallet)`,
  };
}

export async function handleConnectWallet(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  await safeAnswerCb(ctx, 'Starting pairing…');

  if (!bawAvailable()) {
    await ctx.reply(
      '❌ Binance Agentic Wallet CLI (@binance/agentic-wallet) is not installed on this server.\n\n' +
      'Ask the bot operator to run "npm ci" and restart the service.',
      KB.start,
    );
    return;
  }

  try {
    const session = await generatePairingUri(userId);

    if (!session) {
      await ctx.reply(
        '❌ Failed to start Binance Wallet pairing.\n\n' +
        'The @binance/agentic-wallet CLI could not create a pairing session.\n' +
        'Check server logs and ensure the deployment has outbound internet access.',
        KB.start,
      );
      return;
    }

    // Handle already-connected case — run immediate JAGER eligibility & 1-time limit check
    if (session.walletAddress) {
      const status = await checkConnectedWalletStatus(userId, session.walletAddress, session.agentIdName);
      if (status.blocked) {
        await ctx.reply(status.message, status.keyboard);
        return;
      }

      const displayAgent = status.resolvedAgentId ?? session.agentIdName;
      await ctx.reply(
        `✅ Already connected!\n\n` +
        `Address: ${session.walletAddress}\n` +
        (displayAgent ? `Agent ID: ${displayAgent}\n` : '') +
        `${status.freshnessNote}\n\n` +
        `Tap Complete All Process to run silent preflight checks and review the single combined JAGER preview.`,
        KB.afterConnect,
      );
      return;
    }

    await safeUpdateUser(userId, { session_link: session.urlForWeb, current_step: 'connecting' });

    const expiresMin = Math.max(1, Math.round((session.expireAt - Date.now()) / 60000));

    // Generate QR image immediately
    const qrCaption = `🔗 Open in Binance app:\n${session.urlForWeb}`;
    try {
      const qrBuf = await generateQrBuffer(session.urlForWeb);
      await ctx.replyWithPhoto(
        { source: qrBuf, filename: 'connect.png' },
        {
          caption:
            `📱 Scan with your Binance app to connect.\n\n` +
            (session.pairingCode ? `Pairing code: ${session.pairingCode}\n` : '') +
            `Expires in: ${expiresMin} min\n\n` +
            `Or open: ${session.urlForWeb}\n\n` +
            `✅ This message will update automatically when connected.`,
          ...KB.cancelOnly,
        },
      );
    } catch {
      await ctx.reply(qrCaption, KB.cancelOnly);
    }

    // Background verification — immediately checks JAGER eligibility upon binding
    verifyAndBindSession(
      userId,
      session.qrCodeId,
      async (connected) => {
        try {
          if (!connected.walletAddress) {
            await ctx.reply('❌ Connected but wallet address could not be read. Tap Connect Wallet to try again.', KB.start);
            return;
          }

          const status = await checkConnectedWalletStatus(
            userId,
            connected.walletAddress,
            connected.agentIdName,
          );
          if (status.blocked) {
            await ctx.reply(status.message, status.keyboard);
            return;
          }

          const displayAgent = status.resolvedAgentId ?? connected.agentIdName;
          await ctx.reply(
            `✅ Wallet connected!\n\n` +
            `Address: ${connected.walletAddress}\n` +
            (displayAgent ? `Agent ID: ${displayAgent}\n` : '') +
            `${status.freshnessNote}\n\n` +
            `Tap Complete All Process to run silent preflight checks and view the one-confirm JAGER preview.`,
            KB.afterConnect,
          );
        } catch (e) { logger.warn({ e, userId }, 'Could not send connected message'); }
      },
      async (reason) => {
        try {
          await ctx.reply(`❌ Pairing failed:\n${reason}\n\nTap Connect Wallet to try again.`, KB.start);
        } catch (e) { logger.warn({ e, userId }, 'Could not send failed message'); }
      },
    );
  } catch (err) {
    logger.error({ err, userId }, 'handleConnectWallet error');
    await ctx.reply('❌ Failed to start pairing. Please try again.', KB.start);
  }
}
