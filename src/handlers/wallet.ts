// src/handlers/wallet.ts — /connect flow with live QR + background verification
import { Context } from 'telegraf';
import {
  bawAvailable,
  generatePairingUri,
  verifyAndBindSession,
} from '../wallet.js';
import { generateQrBuffer } from '../qr.js';
import { safeUpdateUser } from '../db.js';
import { KB } from '../keyboards.js';
import { logger } from '../logger.js';

async function safeAnswerCb(ctx: Context, text?: string): Promise<void> {
  try { if (ctx.callbackQuery) await ctx.answerCbQuery(text); } catch { /* ok */ }
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

    // Handle already-connected case
    if (session.walletAddress) {
      await ctx.reply(
        `✅ Already connected!\n\nAddress: ${session.walletAddress}\n` +
        (session.agentIdName ? `Agent ID: ${session.agentIdName}\n` : '') +
        '\nTap Complete All Process to run the cycle.',
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
      // QR generation failed — send text link
      await ctx.reply(qrCaption, KB.cancelOnly);
    }

    // Background verification — bot sends confirmation when user approves in Binance app
    verifyAndBindSession(
      userId,
      session.qrCodeId,
      async (connected) => {
        try {
          await ctx.reply(
            `✅ Wallet connected!\n\n` +
            `Address: ${connected.walletAddress}\n` +
            (connected.agentIdName ? `Agent ID: ${connected.agentIdName}\n` : '(No .ai Agent ID claimed yet)\n') +
            `\nTap Complete All Process to start the mint/sell cycle.`,
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
