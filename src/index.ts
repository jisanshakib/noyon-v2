// src/index.ts
// Application entry point.
// Sets up Telegraf bot, registers all handlers, starts the bot, and handles graceful shutdown.

import { Telegraf } from 'telegraf';
import { config } from './config.js';
import { initDb, pool } from './db.js';
import { logger } from './logger.js';

import { handleStart } from './handlers/start.js';
import { handleConnectWallet } from './handlers/wallet.js';
import { handleGenerateQr } from './handlers/qr.js';
import { handleCompleteProcess } from './handlers/execute.js';
import { handleMyJobs } from './handlers/jobs.js';
import { handleCancel } from './handlers/cancel.js';
import { handleAdminUsers, handleAdminCompleted } from './handlers/admin.js';
import { handleMessage } from './handlers/message.js';

// ─── Bot setup ────────────────────────────────────────────────────────────────

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

// ─── Commands ────────────────────────────────────────────────────────────────

bot.start(handleStart);
bot.command('admin_users', handleAdminUsers);
bot.command('admin_completed', handleAdminCompleted);

// ─── Callback query (inline button) handlers ──────────────────────────────────

bot.action('connect_wallet', handleConnectWallet);
bot.action('generate_qr', handleGenerateQr);
bot.action('complete_process', handleCompleteProcess);
bot.action('my_jobs', handleMyJobs);
bot.action('cancel', handleCancel);

// ─── Free-text message handler ───────────────────────────────────────────────

bot.on('text', handleMessage);

// ─── Error handler ───────────────────────────────────────────────────────────

bot.catch((err: unknown, ctx) => {
  logger.error({ err, updateType: ctx.updateType }, 'Telegraf error');
});

// ─── Health check endpoint (for Railway / Render) ─────────────────────────────

import http from 'http';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// ─── Startup ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info('Starting BNB Telegram Bot…');

  // Validate env + init DB
  await initDb();

  // Start health server
  healthServer.listen(PORT, () => {
    logger.info({ port: PORT }, 'Health check server listening');
  });

  // Launch bot (long polling)
  await bot.launch({
    allowedUpdates: ['message', 'callback_query'],
  });

  logger.info('Bot is running (long polling)');
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down…');
  bot.stop(signal);
  healthServer.close(() => {
    pool.end().then(() => {
      logger.info('DB pool closed. Goodbye.');
      process.exit(0);
    });
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
