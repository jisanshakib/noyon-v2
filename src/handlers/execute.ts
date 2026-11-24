// src/handlers/execute.ts — Layer 4: JAGER One-Confirm Full Cycle preview & live execution handlers

import { Context } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/types';
import { isSessionConnectedDb, getSession } from '../wallet.js';
import { ADDR } from '../bsc.js';
import {
  isUserLocked,
  isPreviewInProgress,
  prepareCyclePreview,
  reserveExecutionFromPreview,
  releaseReservedExecutionLock,
  clearPendingPreview,
  runFullExecution,
  ALREADY_COMPLETED_MESSAGE,
  CLAIM_MAX_ATTEMPTS,
  ExecutionSuccess,
} from '../executor.js';
import {
  safeUpdateUser,
  hasCompletedCycleForAgent,
} from '../db.js';
import { KB } from '../keyboards.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const TELEGRAM_SAFE_MAX_LEN = 3900;

function truncateForTelegram(text: string): string {
  if (text.length <= TELEGRAM_SAFE_MAX_LEN) return text;
  return `${text.slice(0, TELEGRAM_SAFE_MAX_LEN - 16)}\n…(truncated)`;
}

async function safeAnswerCb(ctx: Context, text?: string): Promise<void> {
  try { if (ctx.callbackQuery) await ctx.answerCbQuery(text); } catch { /* ok */ }
}

/**
 * Edits the tracked status message in place, falling back to sending a fresh message
 * if the original message was deleted or cannot be edited (never throws unhandled rejections).
 */
async function safeEditOrSend(
  ctx: Context,
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<void> {
  const safeText = truncateForTelegram(text);
  try {
    await ctx.telegram.editMessageText(chatId, messageId, undefined, safeText, {
      reply_markup: replyMarkup,
    });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err ?? '');
    if (/message is not modified/i.test(msg)) return;
    try {
      await ctx.telegram.sendMessage(chatId, safeText, {
        reply_markup: replyMarkup,
      });
    } catch (sendErr) {
      logger.warn({ err: sendErr, chatId }, 'safeEditOrSend fallback sendMessage failed');
    }
  }
}

/**
 * Step 1: Triggered by `/mint` or `🚀 Complete All Process`.
 * Runs silent preflight checks (fresh wallet, live jager.live/api/stats price,
 * USDT & BNB balances, Developer Mode ON, PancakeSwap V2 sell quote within 8%)
 * and presents ONE combined preview with `✅ Confirm & Execute Full Cycle` / `❌ Cancel`.
 */
export async function handleCompleteProcess(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  if (isUserLocked(userId)) {
    await safeAnswerCb(ctx, 'Job already running');
    await ctx.reply('⏳ A job is already running. Please wait or tap Cancel.', KB.cancelOnly);
    return;
  }

  if (isPreviewInProgress(userId)) {
    await safeAnswerCb(ctx, 'Already preparing preview…');
    return;
  }

  await safeAnswerCb(ctx, 'Preparing live preview…');

  // Guard 1: wallet must be connected
  const { connected, address, dbAgentId } = await isSessionConnectedDb(userId);
  if (!connected) {
    await ctx.reply(
      '⚠️ Wallet not connected.\n\n' +
      'Steps:\n1. Tap Connect Your Binance Wallet\n2. Scan the QR code in the Binance app\n' +
      '3. Wait for confirmation, then tap Complete All Process.',
      KB.start,
    );
    return;
  }

  // Guard 2: One-time completed lock strictly scoped to JAGER Mint Contract (Agent ID / Wallet)
  const memSession = getSession(userId);
  const knownAgentId = memSession?.agentIdName ?? dbAgentId ?? null;
  const completedCheck = await hasCompletedCycleForAgent({
    mintContract: ADDR.MINT_CONTRACT,
    agentIdName: knownAgentId,
    walletAddress: address ?? null,
  });
  if (completedCheck.completed) {
    logger.info(
      { userId, mintContract: ADDR.MINT_CONTRACT, matchedBy: completedCheck.matchedBy, knownAgentId, address: address ?? null },
      'Blocked Complete All Process: Agent ID / Wallet already completed JAGER full cycle',
    );
    await ctx.reply(ALREADY_COMPLETED_MESSAGE, KB.start);
    return;
  }

  const loadingMsg = await ctx.reply(
    '🔍 Running silent preflight checks & fetching live JAGER price from jager.live/api/stats…',
  );
  const chatId    = loadingMsg.chat.id;
  const messageId = loadingMsg.message_id;

  try {
    const previewRes = await prepareCyclePreview(userId);

    if (!previewRes.ok) {
      if (previewRes.alreadyCompleted) {
        await safeUpdateUser(userId, { current_step: 'completed' });
        await safeEditOrSend(ctx, chatId, messageId, ALREADY_COMPLETED_MESSAGE, KB.start.reply_markup);
        return;
      }

      await safeUpdateUser(userId, { current_step: previewRes.isSessionExpired ? 'connecting' : 'failed' });
      const msg =
        (previewRes.notEligible
          ? previewRes.reason
          : `❌ Preflight stopped\n\n${previewRes.reason}`) +
        (previewRes.isSessionExpired ? '\n\nTap Connect Your Binance Wallet to reconnect.' : '');

      await safeEditOrSend(
        ctx,
        chatId,
        messageId,
        msg,
        (previewRes.isSessionExpired || previewRes.notEligible ? KB.start : KB.postExecution).reply_markup,
      );
      return;
    }

    await safeUpdateUser(userId, { current_step: 'previewing' });
    await safeEditOrSend(ctx, chatId, messageId, previewRes.text, KB.confirmCycle.reply_markup);
  } catch (err) {
    logger.error({ err, userId }, 'handleCompleteProcess preview error');
    await safeEditOrSend(
      ctx,
      chatId,
      messageId,
      `❌ Failed to prepare preview: ${(err as Error)?.message ?? String(err)}`,
      KB.postExecution.reply_markup,
    );
  }
}

/**
 * Cancels only the pending cycle preview without disconnecting the user's wallet.
 */
export async function handleCancelPreview(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  await safeAnswerCb(ctx, 'Preview cancelled');
  clearPendingPreview(userId);
  await safeUpdateUser(userId, { current_step: 'connected' });

  const text = '❌ Full cycle cancelled before execution. Your wallet remains connected.\n\nTap Complete All Process anytime for a fresh live preview.';
  try {
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageText(text, { reply_markup: KB.afterConnect.reply_markup });
      return;
    }
  } catch { /* fall back to reply */ }
  await ctx.reply(text, KB.afterConnect);
}

/**
 * Step 2: Triggered ONCE when user clicks `✅ Confirm & Execute Full Cycle`.
 * Atomically reserves the preview & execution lock BEFORE any await to prevent
 * double-tap races, then runs Steps A → B → C → D → E back-to-back with zero further prompts.
 */
export async function handleConfirmExecuteCycle(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  // Synchronous atomic reservation before any await (prevents double-tap race)
  const reserved = reserveExecutionFromPreview(userId);
  if (!reserved.ok) {
    if (reserved.reason === 'locked') {
      await safeAnswerCb(ctx, 'Already running…');
      await ctx.reply('⏳ Your JAGER full cycle is already running. Please wait or tap Cancel.', KB.cancelOnly);
    } else {
      await safeAnswerCb(ctx, 'Preview expired');
      await ctx.reply(
        '⏰ That preview expired or was already used.\n\nTap Complete All Process to generate a fresh live preview.',
        KB.afterConnect,
      );
    }
    return;
  }

  let chatId: number;
  let messageId: number;

  try {
    await safeAnswerCb(ctx, 'Confirmed! Starting full cycle…');

    const initialText =
      '⚙️ Confirmed! Running JAGER One-Confirm Full Cycle (Steps A → E) back-to-back.\n\n' +
      '🔍 Re-verifying live price & preflight guards…';

    try {
      if (ctx.callbackQuery?.message) {
        chatId = ctx.callbackQuery.message.chat.id;
        messageId = ctx.callbackQuery.message.message_id;
        await ctx.telegram.editMessageText(chatId, messageId, undefined, initialText, {
          reply_markup: KB.cancelOnly.reply_markup,
        });
      } else {
        const m = await ctx.reply(initialText, KB.cancelOnly);
        chatId = m.chat.id;
        messageId = m.message_id;
      }
    } catch {
      const m = await ctx.reply(initialText, KB.cancelOnly);
      chatId = m.chat.id;
      messageId = m.message_id;
    }

    await safeUpdateUser(userId, { current_step: 'executing' });
  } catch (setupErr) {
    releaseReservedExecutionLock(userId);
    logger.error({ err: setupErr, userId }, 'handleConfirmExecuteCycle setup failed before runFullExecution');
    return;
  }

  /** Edits the single live-status message in place (never crashes on Telegram rate/identical errors) */
  const onStatus = async (text: string): Promise<void> => {
    try {
      await ctx.telegram.editMessageText(chatId, messageId, undefined, truncateForTelegram(text), {
        reply_markup: KB.cancelOnly.reply_markup,
      });
    } catch { /* message may already be deleted or identical — ignore */ }
  };

  // Run asynchronously so the bot stays responsive to other users & Cancel button
  runFullExecution(userId, onStatus, reserved.preview)
    .then(async (result) => {
      if (result.ok) {
        const userDisplayName = ctx.from?.first_name ?? ctx.from?.username ?? String(userId);
        await Promise.all([
          safeEditOrSend(ctx, chatId, messageId, result.summary, KB.postExecution.reply_markup),
          notifyAdmin(ctx, userId, userDisplayName, result),
        ]);
      } else if (result.alreadyCompleted) {
        await safeUpdateUser(userId, { current_step: 'completed' });
        await safeEditOrSend(ctx, chatId, messageId, ALREADY_COMPLETED_MESSAGE, KB.postExecution.reply_markup);
      } else {
        await safeUpdateUser(userId, { current_step: result.isSessionExpired ? 'connecting' : 'failed' });

        const partialInfo = result.partialTxHashes
          ? Object.entries(result.partialTxHashes).map(([k, v]) => `  • ${k}: ${v}`).join('\n')
          : '';
        const msg =
          `❌ JAGER Cycle Stopped\n\n${result.reason}` +
          (partialInfo ? `\n\nBroadcast TXs:\n${partialInfo}` : '') +
          (result.isSessionExpired ? '\n\nTap Connect Your Binance Wallet to reconnect.' : '');

        await safeEditOrSend(
          ctx,
          chatId,
          messageId,
          msg,
          (result.isSessionExpired ? KB.start : KB.postExecution).reply_markup,
        );
      }
    })
    .catch(async (err: Error) => {
      logger.error({ err, userId }, 'Unexpected error in runFullExecution');
      await safeEditOrSend(
        ctx,
        chatId,
        messageId,
        `❌ Unexpected error: ${err.message}`,
        KB.postExecution.reply_markup,
      );
    });
}

async function notifyAdmin(
  ctx: Context,
  userId: number,
  userDisplayName: string,
  result: ExecutionSuccess,
): Promise<void> {
  const lines = [
    `✅ JAGER Cycle Completed`,
    ``,
    `User: ${userDisplayName} (ID: ${userId})`,
    `Agent ID: ${result.agentId}`,
    `Wallet: ${result.walletAddress}`,
    `Mint cost: ${result.mintCostUsdt} USDT`,
    `Sell received: ${result.sellUsdt} USDT`,
    `Net Loss / Fees: ${result.netLossOrFeeUsdt} USDT`,
    ...(result.inviteRewardUsdt ? [`Invite Reward: +${result.inviteRewardUsdt} USDT`] : []),
    ``,
    `approve: ${result.approveTxHash}`,
    `mint: ${result.mintTxHash}`,
    ...(result.sellApproveTxHash ? [`sell_approve: ${result.sellApproveTxHash}`] : []),
    `sell: ${result.sellTxHash}`,
    `revoke: ${result.revokeTxHash}`,
    `claim: ${result.claimTxHash}`,
    `claim_attempts: ${result.claimAttempts}/${CLAIM_MAX_ATTEMPTS}${result.claimStatusNote ? ` (${result.claimStatusNote})` : ''}`,
    ``,
    `Total completed by user: ${result.completedCount}`,
  ];
  const text = truncateForTelegram(lines.join('\n'));

  await Promise.all(
    config.ADMIN_IDS.map((adminId) =>
      ctx.telegram.sendMessage(adminId, text).catch((err) => {
        logger.warn({ err, adminId }, 'Failed to notify admin');
      }),
    ),
  );
}
