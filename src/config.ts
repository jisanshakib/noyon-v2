// src/config.ts
// Validates and exports all required environment variables at startup.

import dotenv from 'dotenv';
dotenv.config();

function require_env(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function optional_env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const config = {
  GEMINI_API_KEY: require_env('GEMINI_API_KEY'),
  TELEGRAM_BOT_TOKEN: require_env('TELEGRAM_BOT_TOKEN'),
  SUPABASE_DB_URL: require_env('SUPABASE_DB_URL'),
  SUPABASE_URL: optional_env('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: optional_env('SUPABASE_SERVICE_ROLE_KEY'),
  ADMIN_ID: parseInt(require_env('ADMIN_ID'), 10),
  BSC_RPC_URL: require_env('BSC_RPC_URL'),
  LOG_LEVEL: optional_env('LOG_LEVEL', 'info'),

  // Binance Agentic Wallet deep-link base URL.
  // When left blank, the bot shows an honest "adapter not configured" message
  // rather than generating a fake/non-functional pairing link.
  // Set to your real Binance Skills / MCP pairing endpoint when available.
  BINANCE_WALLET_PAIRING_BASE_URL: optional_env('BINANCE_WALLET_PAIRING_BASE_URL', ''),

  // Session nonce TTL in seconds (default 10 minutes)
  SESSION_TTL_SECONDS: parseInt(optional_env('SESSION_TTL_SECONDS', '600'), 10),
} as const;

// Validate ADMIN_ID is a valid integer
if (isNaN(config.ADMIN_ID)) {
  throw new Error('ADMIN_ID must be a valid integer');
}
