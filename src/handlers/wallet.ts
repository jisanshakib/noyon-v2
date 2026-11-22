// src/handlers/wallet.ts
import { Context } from 'telegraf';
import { generatePairingUri, verifyAndBindSession } from '../wallet.js';
import { updateUser } from '../db.js';
import { KB } from '../keyboards.js';
import { logger } from '../logger.js';

async function safeAnswerCb(ctx: Context, text?: string): Promise<void> {
  try { if (ctx.callbackQuery) await ctx.answerCbQuery(text); } catch { /* ignore */ }
}

export async function handleConnectWallet(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  await safeAnswerCb(ctx, 'Generating pairing link…');

  try {
    const session = await generatePairingUri(userId);

    if (!session) {
      await ctx.reply(
        '❌ Failed to start Binance Wallet pairing.\n\n' +
        'Make sure @binance/agentic-wallet is installed and the deployment ' +
        'server can reach Binance\'s authentication endpoint.\n\n' +
        'Check the server logs for details.',
        KB.start,
      );
      return;
    }

    await updateUser(userId, { session_link: session.urlForWeb, current_step: 'connecting' });

    const expiresInMin = Math.max(1, Math.round((session.expireAt - Date.now()) / 60000));

    await ctx.reply(
      '🔗 Binance Wallet Pairing\n\n' +
      'Open this link in your Binance app to connect:\n\n' +
      `${session.urlForWeb}\n\n` +
      (session.pairingCode ? `🔢 Pairing code: ${session.pairingCode}\n` : '') +
      `⏰ Expires in: ${expiresInMin} min\n\n` +
      '📱 Or tap Generate QR Code to scan instead.\n\n' +
      '✅ Once you approve in the Binance app, this bot will confirm automatically.',
      KB.afterConnect,
    );

    // Start background verification — fires onConnected/onFailed when user approves
    verifyAndBindSession(
      userId,
      session.qrCodeId,
      async (connected) => {
        try {
          const addr    = connected.walletAddress ?? '';
          const agentId = connected.agentIdName   ?? '';
          await ctx.reply(
            '✅ Wallet connected!\n\n' +
            `📍 Address: ${addr}\n` +
            (agentId ? `🤖 Agent ID: ${agentId}\n` : '(No .ai Agent ID claimed yet)\n') +
            '\nTap Complete All Process to start the mint/sell pipeline.',
            KB.afterConnect,
          );
        } catch (e) {
          logger.warn({ e, userId }, 'Could not send wallet-connected message');
        }
      },
      async (reason) => {
        try {
          await ctx.reply(`❌ Wallet pairing failed:\n${reason}`, KB.start);
        } catch (e) {
          logger.warn({ e, userId }, 'Could not send wallet-failed message');
        }
      },
    ).catch((e) => logger.error({ e, userId }, 'verifyAndBindSession threw unexpectedly'));

  } catch (err) {
    logger.error({ err, userId }, 'handleConnectWallet failed');
    await ctx.reply('❌ Failed to start pairing. Please try again.', KB.start);
  }
}
