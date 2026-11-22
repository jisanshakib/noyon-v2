// src/index.ts — Layer 4/5: Bot entry point, commands, concurrency setup
import { Telegraf } from 'telegraf';
import { config } from './config.js';
import { initDb, pool } from './db.js';
import { logger } from './logger.js';
import http from 'http';

import { handleStart }                       from './handlers/start.js';
import { handleConnectWallet, handleGenerateQr } from './handlers/wallet.js';
import { handleCompleteProcess }             from './handlers/execute.js';
import { handleMyJobs }                      from './handlers/jobs.js';
import { handleCancel }                      from './handlers/cancel.js';
import { handleAdminUsers, handleAdminCompleted } from './handlers/admin.js';
import { handleMessage }                     from './handlers/message.js';

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

// ── Commands ─────────────────────────────────────────────────────────────────
bot.start(handleStart);
bot.command('connect', handleConnectWallet);   // /connect alias
bot.command('mint',    handleCompleteProcess); // /mint alias
bot.command('admin_users',     handleAdminUsers);
bot.command('admin_completed', handleAdminCompleted);

// ── Inline button handlers ───────────────────────────────────────────────────
bot.action('connect_wallet', handleConnectWallet);
bot.action('generate_qr',    handleGenerateQr);
bot.action('complete_process', handleCompleteProcess);
bot.action('my_jobs',  handleMyJobs);
bot.action('cancel',   handleCancel);

// ── Free-text NL routing (Gemini intent, free-tier-safe) ─────────────────────
bot.on('text', handleMessage);

// ── Global error handler ─────────────────────────────────────────────────────
bot.catch((err: unknown, ctx) => {
  logger.error({ err, updateType: ctx.updateType }, 'Telegraf error');
});

// ── Health check server (Railway / Render) ────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3000', 10);
const healthServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  } else {
    res.writeHead(404); res.end();
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  logger.info('Starting BNB Telegram Bot…');

  // DB init is non-fatal — bot starts in degraded mode if Supabase is unreachable
  try {
    await initDb();
  } catch (err) {
    const e = err as Error;
    logger.error(
      { msg: e.message, stack: e.stack, cause: (e as NodeJS.ErrnoException).code },
      'DB init failed — starting in degraded mode (no DB persistence until reconnected)',
    );
  }

  healthServer.listen(PORT, () => logger.info({ port: PORT }, 'Health server listening'));
  await bot.launch({ allowedUpdates: ['message', 'callback_query'] });
  logger.info('Bot running (long polling)');
}

function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down…');
  bot.stop(signal);
  healthServer.close(() => pool.end().then(() => { logger.info('DB closed. Bye.'); process.exit(0); }));
}

process.once('SIGINT',  () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
main().catch(err => {
  const e = err as Error;
  console.error('FATAL STARTUP ERROR:', e?.message ?? e);
  console.error('Stack:', e?.stack);
  console.error('Cause:', (e as NodeJS.ErrnoException)?.code ?? (e as Error & { cause?: unknown })?.cause);
  process.exit(1);
});
