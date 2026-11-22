// src/handlers/wallet.ts
// "Connect Your Binance Wallet" callback handler.

import { Context } from 'telegraf';
import { generatePairingUri } from '../wallet.js';
import { updateUser } from '../db.js';
import { KB } from '../keyboards.js';
import { logger } from '../logger.js';

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

    // FIX: generatePairingUri returns null when BINANCE_WALLET_PAIRING_BASE_URL
    // is not configured.  Show an honest, actionable message instead of a fake link.
    if (!session) {
      await ctx.reply(
        '⚠️ Binance Agentic Wallet adapter is not configured yet.\n\n' +
        'To enable real wallet connection:\n' +
        '  1. Install the official Binance Wallet SDK or MCP adapter.\n' +
        '  2. Set BINANCE_WALLET_PAIRING_BASE_URL in your environment variables ' +
           'to the SDK pairing endpoint (e.g. https://app.binance.com/en/wc?uri=).\n' +
        '  3. Wire the SDK session_connected event to call markSessionConnected().\n\n' +
        'The bot cannot generate a valid pairing link without this configuration.',
        KB.start,
      );
      return;
    }

    // Persist session_link to Supabase (also done inside generatePairingUri,
    // but updateUser here keeps current_step in sync).
    await updateUser(userId, { session_link: session.pairingUri, current_step: 'connecting' });

    const expiryMin = Math.round(
      (session.expiresAt.getTime() - Date.now()) / 60000,
    );

    await ctx.reply(
      '🔗 Binance Wallet Pairing\n\n' +
      'Open this link in your Binance app to connect your wallet:\n\n' +
      `${session.pairingUri}\n\n` +
      `📌 Session ID: ${session.sessionId}\n` +
      `⏰ Expires in: ${expiryMin} minutes\n\n` +
      '📱 Tap Generate QR Code below for easy scanning.\n\n' +
      'Once connected, tap Complete All Process to begin.\n\n' +
      '💡 After pairing in the Binance app, use /wallet_connected ' +
      'to confirm the connection here.',
      KB.afterConnect,
    );
  } catch (err) {
    logger.error({ err, userId }, 'handleConnectWallet failed');
    await ctx.reply('❌ Failed to generate pairing link. Please try again.', KB.start);
  }
}

/**
 * /wallet_connected command handler.
 *
 * Interim flow (until the Binance SDK fires real session_connected events):
 * The user manually confirms their wallet is connected via this command.
 * They provide their wallet address and optional *.ai Agent ID.
 *
 * Usage:  /wallet_connected 0xYourAddress YourAgentId.ai
 *
 * When the real Binance SDK is wired, this command becomes optional — the SDK
 * will call markSessionConnected() automatically on pairing.
 */
export async function handleWalletConnected(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  // Parse args from message text
  const text = (ctx.message as { text?: string } | undefined)?.text ?? '';
  const parts = text.trim().split(/\s+/);
  // parts[0] = "/wallet_connected", parts[1] = address, parts[2] = agentId (optional)
  const walletAddress = parts[1] ?? '';
  const agentIdRaw    = parts[2] ?? '';

  if (!walletAddress || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
    await ctx.reply(
      '⚠️ Please provide your wallet address.\n\n' +
      'Usage:\n' +
      '  /wallet_connected 0xYourWalletAddress\n' +
      '  /wallet_connected 0xYourWalletAddress YourAgent.ai\n\n' +
      'You can find your wallet address in the Binance app after pairing.',
    );
    return;
  }

  // Validate agentId format if provided (must end with .ai or be a hex address)
  const agentId = agentIdRaw.trim();
  if (agentId && !/^[a-zA-Z0-9._-]+\.ai$/.test(agentId) && !/^0x[0-9a-fA-F]{40}$/.test(agentId)) {
    await ctx.reply(
      '⚠️ Agent ID must be a *.ai name (e.g. yourname.ai) or a valid wallet address.\n' +
      'If you do not have an Agent ID, omit it:\n' +
      `  /wallet_connected ${walletAddress}`,
    );
    return;
  }

  try {
    // Import here to avoid circular dependency; both are in separate modules
    const { markSessionConnected } = await import('../wallet.js');
    await markSessionConnected(userId, walletAddress, agentId);

    await updateUser(userId, {
      is_wallet_connected: true,
      current_step: 'connected',
    });

    await ctx.reply(
      '✅ Wallet connected successfully!\n\n' +
      `📍 Address: ${walletAddress}\n` +
      (agentId ? `🤖 Agent ID: ${agentId}\n` : '') +
      '\nYou can now tap Complete All Process to start the mint/sell pipeline.',
      KB.afterConnect,
    );

    logger.info({ userId, walletAddress, agentId }, 'Wallet manually confirmed as connected');
  } catch (err) {
    logger.error({ err, userId }, 'handleWalletConnected failed');
    await ctx.reply('❌ Failed to record wallet connection. Please try again.');
  }
}
