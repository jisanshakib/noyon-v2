// src/handlers/wallet.ts
// "Connect Your Binance Wallet" callback handler.

import { Context } from 'telegraf';
import { generatePairingUri } from '../wallet.js';
import { updateUser } from '../db.js';
import { KB } from '../keyboards.js';
import { logger } from '../logger.js';

// FIX #11: answerCbQuery guard — safe when reached via text message routing.
async function safeAnswerCb(ctx: Context, text?: string): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery(text);
  } catch {
    // not a callback context — ignore
  }
}

export async function handleConnectWallet(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  await safeAnswerCb(ctx, 'Generating pairing link…');

  try {
    const session = await generatePairingUri(userId);
    await updateUser(userId, { session_link: session.pairingUri, current_step: 'connecting' });

    // FIX #9: plain text — session ID and URI may contain chars that break MarkdownV2.
    await ctx.reply(
      `🔗 Binance Wallet Pairing\n\n` +
      `Open this link in your Binance app to connect:\n\n` +
      `${session.pairingUri.slice(0, 120)}${session.pairingUri.length > 120 ? '…' : ''}\n\n` +
      `📌 Session ID: ${session.sessionId}\n\n` +
      `📱 Tap Generate QR Code below for easy scanning.\n\n` +
      `After connecting, tap Complete All Process to begin.`,
      KB.afterConnect,
    );
  } catch (err) {
    logger.error({ err, userId }, 'handleConnectWallet failed');
    await ctx.reply('❌ Failed to generate pairing link. Please try again.', KB.start);
  }
}
