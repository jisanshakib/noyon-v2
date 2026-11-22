// src/handlers/execute.ts — Layer 4: /mint handler with live single-message updates
import { Context } from 'telegraf';
import { isSessionConnectedDb, getSession } from '../wallet.js';
import { isUserLocked, requestCancelExecution, runFullExecution } from '../executor.js';
import { updateUser, getUser } from '../db.js';
import { KB } from '../keyboards.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

async function safeAnswerCb(ctx: Context, text?: string): Promise<void> {
  try { if (ctx.callbackQuery) await ctx.answerCbQuery(text); } catch { /* ok */ }
}

export async function handleCompleteProcess(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  await safeAnswerCb(ctx, 'Starting…');

  // Guard: wallet must be connected — check Supabase (survives restarts)
  const { connected } = await isSessionConnectedDb(userId);
  if (!connected) {
    await ctx.reply(
      '⚠️ Wallet not connected.\n\n' +
      'Steps:\n1. Tap Connect Your Binance Wallet\n2. Scan the QR code in the Binance app\n' +
      '3. Wait for confirmation, then tap Complete All Process.',
      KB.start,
    );
    return;
  }

  if (isUserLocked(userId)) {
    await ctx.reply('⏳ A job is already running. Please wait or tap Cancel.', KB.cancelOnly);
    return;
  }

  // Send the SINGLE status message we will edit throughout the cycle
  const statusMsg = await ctx.reply(
    '⚙️ Work has started. Please wait until all steps are completed.\n\n' +
    '🔍 Verifying wallet connection…',
    KB.cancelOnly,
  );

  const chatId    = statusMsg.chat.id;
  const messageId = statusMsg.message_id;

  /** Edits the single live-status message in place */
  const onStatus = async (text: string): Promise<void> => {
    try {
      await ctx.telegram.editMessageText(chatId, messageId, undefined, text, {
        reply_markup: KB.cancelOnly.reply_markup,
      });
    } catch { /* message may already be deleted or identical — ignore */ }
  };

  await updateUser(userId, { current_step: 'executing' });

  // Run asynchronously so the bot stays responsive
  runFullExecution(userId, onStatus)
    .then(async (result) => {
      if (result.ok) {
        await updateUser(userId, { current_step: 'completed' });
        await notifyAdmin(ctx, userId, result.agentId, result);
        // Replace live status with final clean report
        await ctx.telegram.editMessageText(chatId, messageId, undefined, result.summary, {
          reply_markup: KB.postExecution.reply_markup,
        });
      } else {
        await updateUser(userId, { current_step: result.isSessionExpired ? 'connecting' : 'failed' });

        const partialInfo = result.partialTxHashes
          ? Object.entries(result.partialTxHashes).map(([k, v]) => `  ${k}: ${v}`).join('\n')
          : '';
        const msg =
          `❌ Process stopped\n\n${result.reason}` +
          (partialInfo ? `\n\nBroadcast TXs:\n${partialInfo}` : '') +
          (result.isSessionExpired
            ? '\n\nTap Connect Your Binance Wallet to reconnect.' : '');

        await ctx.telegram.editMessageText(chatId, messageId, undefined, msg, {
          reply_markup: (result.isSessionExpired ? KB.start : KB.postExecution).reply_markup,
        });
      }
    })
    .catch(async (err: Error) => {
      logger.error({ err, userId }, 'Unexpected error in runFullExecution');
      await ctx.telegram.editMessageText(chatId, messageId, undefined,
        `❌ Unexpected error: ${err.message}`, { reply_markup: KB.postExecution.reply_markup });
    });
}

async function notifyAdmin(
  ctx: Context,
  userId: number,
  agentId: string,
  result: { mintCostBnb: string; sellBnb: string; pnlOrFee: string; mintTxHash: string },
): Promise<void> {
  try {
    const user = await getUser(userId);
    const name = user?.first_name ?? user?.username ?? String(userId);
    await ctx.telegram.sendMessage(
      config.ADMIN_ID,
      `Job Completed\n\nUser: ${name} (ID: ${userId})\nAgent ID: ${agentId}\n` +
      `Mint cost: ${result.mintCostBnb} BNB\nSell: ${result.sellBnb} BNB\n` +
      `PnL: ${result.pnlOrFee} BNB\nMint TX: ${result.mintTxHash}\n` +
      `Total completed: ${(user?.completed_count ?? 0) + 1}`,
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to notify admin');
  }
}
