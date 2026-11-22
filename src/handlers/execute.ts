// src/handlers/execute.ts
// "Complete All Process" callback handler — runs the mint/approve/sell pipeline.

import { Context } from 'telegraf';
import { isSessionConnectedDb } from '../wallet.js';
import { isUserLocked, requestCancelExecution, runFullExecution } from '../executor.js';
import { getUser, updateUser } from '../db.js';
import { KB } from '../keyboards.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { escMd } from './start.js';

// FIX #11/#12: safe wrapper — answerCbQuery is only valid on callback_query updates.
// When this handler is reached via free-text message routing, there is no
// callback query to answer, so calling ctx.answerCbQuery() would throw.
async function safeAnswerCb(ctx: Context, text?: string): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery(text);
  } catch {
    // not a callback query context — silently ignore
  }
}

export async function handleCompleteProcess(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  await safeAnswerCb(ctx, 'Starting…');

  // Guard: wallet must be connected — check Supabase (authoritative source of truth).
  // isSessionConnectedDb() survives bot restarts; the in-memory check would
  // incorrectly block users whose connection was set before the last restart.
  const connected = await isSessionConnectedDb(userId);
  if (!connected) {
    // FIX #9: removed incorrect double-escaping. escMd() is NOT called here because
    // the string literals already contain no special MarkdownV2 chars that need
    // escaping beyond what we explicitly write. Use plain text for safety-critical
    // messages so they always render, even if Telegram MarkdownV2 parsing tightens.
    await ctx.reply(
      '⚠️ Your Binance Wallet is not connected yet.\n\n' +
      'Steps to connect:\n' +
      '  1. Tap Connect Your Binance Wallet to get a pairing link.\n' +
      '  2. Scan the QR code with your Binance app.\n' +
      '  3. After pairing, send /wallet_connected 0xYourAddress YourAgent.ai\n' +
      '  4. Then tap Complete All Process.',
      KB.start,
    );
    return;
  }

  // Guard: prevent double execution
  if (isUserLocked(userId)) {
    await ctx.reply(
      '⏳ A job is already running for your account. Please wait until it completes.',
      KB.cancelOnly,
    );
    return;
  }

  // Confirm started — spec requires: immediately reply "Work has started. Please wait..."
  await ctx.reply(
    '⚙️ Work has started. Please wait until all steps are completed.\n\n' +
    'Steps:\n1. 🔄 Mint (Buy) AI tokens\n2. ✅ Approve AI → PancakeSwap\n3. 💱 Sell AI for BNB\n\n' +
    'You can tap Cancel to abort before or between steps.',
    KB.cancelOnly,
  );

  await updateUser(userId, { current_step: 'executing' });

  // Run asynchronously so the bot remains responsive
  runFullExecution(userId)
    .then(async (result) => {
      if (result.ok) {
        await updateUser(userId, { current_step: 'completed' });

        // Notify admin
        await notifyAdmin(ctx, userId, result.agentId);

        // FIX #9: Gemini-generated summary may contain MarkdownV2 special chars;
        // send as plain text to avoid parse failures breaking delivery.
        await ctx.reply(result.summary, KB.postExecution);
      } else {
        await updateUser(userId, { current_step: 'failed' });

        const partialInfo = result.partialTxHashes
          ? Object.entries(result.partialTxHashes)
              .map(([k, v]) => `  • ${k}: ${v}`)
              .join('\n')
          : '';

        const msg =
          `❌ Process stopped\n\n${result.reason}` +
          (partialInfo ? `\n\n📋 Broadcast TXs:\n${partialInfo}` : '');

        await ctx.reply(msg, KB.postExecution);
      }
    })
    .catch(async (err: Error) => {
      logger.error({ err, userId }, 'Unexpected error in runFullExecution');
      await ctx.reply(
        `❌ Unexpected error: ${err.message}`,
        KB.postExecution,
      );
    });
}

async function notifyAdmin(
  ctx: Context,
  userId: number,
  agentId: string,
): Promise<void> {
  try {
    const user = await getUser(userId);
    const name = user?.first_name ?? user?.username ?? String(userId);
    // Send plain text to admin — avoids MarkdownV2 parse failures on special chars in names/IDs
    await ctx.telegram.sendMessage(
      config.ADMIN_ID,
      `🎉 Job Completed\n\n` +
      `👤 User: ${name} (ID: ${userId})\n` +
      `🤖 Agent ID: ${agentId}\n` +
      `✅ Total completed: ${(user?.completed_count ?? 0) + 1}`,
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to notify admin');
  }
}
