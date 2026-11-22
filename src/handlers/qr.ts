// src/handlers/qr.ts
// "Generate QR Code" callback handler.

import { Context } from 'telegraf';
import { getSession, getSessionLinkFromDb } from '../wallet.js';
import { updateUser } from '../db.js';
import { generateQrBuffer } from '../qr.js';
import { KB } from '../keyboards.js';
import { logger } from '../logger.js';

async function safeAnswerCb(ctx: Context, text?: string): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery(text);
  } catch {
    // not a callback context — ignore
  }
}

export async function handleGenerateQr(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  await safeAnswerCb(ctx, 'Generating QR code…');

  try {
    // FIX: Never silently auto-generate a new pairing URI in the QR handler.
    // The QR code MUST encode the same URI the user was shown in "Connect Wallet".
    // Resolution order:
    //   1. In-memory session cache (fastest, same process lifetime)
    //   2. Supabase session_link (survives bot restarts)
    //   3. No link found → instruct user to click "Connect Your Binance Wallet" first

    let pairingUri: string | null = null;

    const memSession = getSession(userId);
    if (memSession?.pairingUri) {
      pairingUri = memSession.pairingUri;
    } else {
      // Fallback: read from Supabase (bot may have restarted)
      pairingUri = await getSessionLinkFromDb(userId);
    }

    if (!pairingUri) {
      await ctx.reply(
        '⚠️ No pairing link found.\n\n' +
        'Please tap Connect Your Binance Wallet first to generate a pairing link, ' +
        'then come back here to generate the QR code.',
        KB.start,
      );
      return;
    }

    const qrBuffer = await generateQrBuffer(pairingUri);
    await updateUser(userId, { qr_generated: true, current_step: 'qr_shown' });

    await ctx.replyWithPhoto(
      { source: qrBuffer, filename: 'binance_pairing.png' },
      {
        caption:
          '📱 Scan this QR code with your Binance app to connect your wallet.\n\n' +
          'After connecting in the Binance app, send:\n' +
          '  /wallet_connected 0xYourAddress YourAgent.ai\n\n' +
          'Then tap Complete All Process to start.',
        ...KB.afterQr,
      },
    );
  } catch (err) {
    logger.error({ err, userId }, 'handleGenerateQr failed');
    await ctx.reply('❌ Failed to generate QR code. Please try again.', KB.start);
  }
}
