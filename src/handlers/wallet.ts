// src/handlers/wallet.ts — /connect flow with live QR + background verification
import { Context } from 'telegraf';
import { generatePairingUri, verifyAndBindSession, getSession, getSessionLinkFromDb } from '../wallet.js';
import { generateQrBuffer } from '../qr.js';
import { updateUser } from '../db.js';
import { KB } from '../keyboards.js';
import { logger } from '../logger.js';

async function safeAnswerCb(ctx: Context, text?: string): Promise<void> {
  try { if (ctx.callbackQuery) await ctx.answerCbQuery(text); } catch { /* ok */ }
}

export async function handleConnectWallet(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  await safeAnswerCb(ctx, 'Starting pairing…');

  try {
    const session = await generatePairingUri(userId);

    if (!session) {
      await ctx.reply(
        '❌ Failed to start Binance Wallet pairing.\n\n' +
        'The @binance/agentic-wallet CLI failed to reach the Binance auth endpoint.\n' +
        'Check server logs and ensure the deployment has internet access.',
        KB.start,
      );
      return;
    }

    // Handle already-connected case
    if (session.walletAddress) {
      await ctx.reply(
        `Already connected!\n\nAddress: ${session.walletAddress}\n` +
        (session.agentIdName ? `Agent ID: ${session.agentIdName}\n` : '') +
        '\nTap Complete All Process to run the cycle.',
        KB.afterConnect,
      );
      return;
    }

    await updateUser(userId, { session_link: session.urlForWeb, current_step: 'connecting' });

    const expiresMin = Math.max(1, Math.round((session.expireAt - Date.now()) / 60000));

    // Generate QR image immediately
    let qrCaption = `🔗 Open in Binance app:\n${session.urlForWeb}`;
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

export async function handleGenerateQr(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  await safeAnswerCb(ctx, 'Generating QR…');

  try {
    // Resolution: memory → Supabase → error
    let uri = getSession(userId)?.urlForWeb ?? null;
    if (!uri) uri = await getSessionLinkFromDb(userId);

    if (!uri) {
      await ctx.reply(
        '⚠️ No pairing link found.\nTap Connect Your Binance Wallet first.',
        KB.start,
      );
      return;
    }

    const qrBuf = await generateQrBuffer(uri);
    await updateUser(userId, { qr_generated: true, current_step: 'qr_shown' });
    await ctx.replyWithPhoto(
      { source: qrBuf, filename: 'connect.png' },
      { caption: '📱 Scan with your Binance app.\n\nWaiting for approval…', ...KB.afterQr },
    );
  } catch (err) {
    logger.error({ err, userId }, 'handleGenerateQr error');
    await ctx.reply('❌ Failed to generate QR. Please try again.', KB.start);
  }
}
