// src/handlers/qr.ts
// "Generate QR Code" callback handler.

import { Context } from 'telegraf';
import { getSession, generatePairingUri } from '../wallet.js';
import { updateUser } from '../db.js';
import { generateQrBuffer } from '../qr.js';
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

export async function handleGenerateQr(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  await safeAnswerCb(ctx, 'Generating QR code…');

  try {
    // Ensure there is a pairing URI (generate one if none exists)
    let session = getSession(userId);
    if (!session) {
      session = await generatePairingUri(userId);
      await updateUser(userId, { session_link: session.pairingUri });
    }

    const qrBuffer = await generateQrBuffer(session.pairingUri);
    await updateUser(userId, { qr_generated: true, current_step: 'qr_shown' });

    await ctx.replyWithPhoto(
      { source: qrBuffer, filename: 'binance_pairing.png' },
      {
        caption:
          '📱 Scan this QR code with your Binance app to connect your wallet.\n\n' +
          'After connecting, tap Complete All Process to start.',
        // FIX #9: plain text caption — avoids MarkdownV2 parse failure
        ...KB.afterQr,
      },
    );
  } catch (err) {
    logger.error({ err, userId }, 'handleGenerateQr failed');
    await ctx.reply('❌ Failed to generate QR code. Please try again.', KB.start);
  }
}
