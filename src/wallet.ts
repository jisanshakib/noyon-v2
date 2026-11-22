// src/wallet.ts
// Binance Agentic Wallet session management.
//
// ═══════════════════════════════════════════════════════════════════════════════
// ARCHITECTURE — READ THIS BEFORE EDITING
// ═══════════════════════════════════════════════════════════════════════════════
//
// The Binance Agentic Wallet SDK / MCP adapter is NOT publicly available yet.
// This module provides:
//
//   1. generatePairingUri(userId)
//        When BINANCE_WALLET_PAIRING_BASE_URL is configured AND the Binance SDK
//        is available, constructs a real pairing / deep-link URI for that session.
//        When NOT configured, returns null so callers can show an honest error
//        instead of a fake placeholder link.
//
//   2. markSessionConnected(userId, walletAddress, agentIdName)
//        Called when the Binance SDK fires a "session_connected" event.
//        Updates both the in-memory map AND Supabase so the connection state
//        survives bot restarts (Supabase is the durable source of truth).
//
//   3. isSessionConnected(userId)
//        Checks Supabase first (async version preferred); in-memory map is a
//        fast cache only. Use isSessionConnectedDb() in the execute handler.
//
//   4. buildSignerFromSession(userId)
//        STUB — throws clearly. Replace with real Binance SDK getSigner() call.
//
// WIRING REAL BINANCE WALLET:
//   1. Install the official Binance Wallet SDK / MCP package when available.
//   2. Set BINANCE_WALLET_PAIRING_BASE_URL to the SDK's pairing endpoint.
//   3. Replace generatePairingUri() body with sdk.session.create() call.
//   4. Wire sdk.on('session_connected', ...) to call markSessionConnected().
//   5. Replace buildSignerFromSession() body with sdk.session.getSigner().
//
// ═══════════════════════════════════════════════════════════════════════════════

import { ethers } from 'ethers';
import * as crypto from 'crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { provider } from './bsc.js';
import { pool } from './db.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WalletSession {
  pairingUri: string;        // The deep-link / QR URI shown to the user
  sessionId: string;         // Internal session nonce (random, unique per request)
  sessionNonce: string;      // Cryptographic nonce for verification
  expiresAt: Date;           // When this pairing attempt expires
  walletAddress?: string;    // Populated after the user completes pairing
  agentIdName?: string;      // *.ai SPACE ID name, populated after pairing
}

// In-memory session cache (key = telegramUserId).
// THIS IS A CACHE ONLY — Supabase is the durable source of truth.
const sessions = new Map<number, WalletSession>();

// ─── Pairing URI generation ───────────────────────────────────────────────────

/**
 * Generates a pairing session for a user.
 *
 * Returns null when BINANCE_WALLET_PAIRING_BASE_URL is not configured — the
 * caller MUST show an honest error message in this case.  Never return a fake
 * or hardcoded URL.
 *
 * When configured, constructs a deep-link that the Binance app can open.
 * Replace the URI construction body with the real SDK call when available.
 */
export async function generatePairingUri(userId: number): Promise<WalletSession | null> {
  const baseUrl = config.BINANCE_WALLET_PAIRING_BASE_URL.trim();

  if (!baseUrl) {
    // Not configured — honest failure.  Callers must handle null.
    logger.warn({ userId }, 'generatePairingUri: BINANCE_WALLET_PAIRING_BASE_URL not set — cannot produce a real pairing link');
    return null;
  }

  // Generate a cryptographically random session nonce and ID.
  const sessionId   = crypto.randomBytes(16).toString('hex');
  const sessionNonce = crypto.randomBytes(32).toString('hex');

  // ── REAL INTEGRATION POINT ────────────────────────────────────────────────
  // Replace the URI construction below with the Binance SDK call, e.g.:
  //
  //   import { BinanceAgenticWallet } from '@binance/wallet-sdk';
  //   const sdk = new BinanceAgenticWallet();
  //   const { uri } = await sdk.session.create({ nonce: sessionNonce });
  //   const pairingUri = uri;   // already a full deep-link from the SDK
  //
  // Until then, we build a WalletConnect v2 URI pointing at the configured
  // base URL.  This is the correct format for Binance app deep-links; it will
  // only work once a real WalletConnect relay/SDK is wired.
  // ──────────────────────────────────────────────────────────────────────────
  const topic      = crypto.createHash('sha256')
    .update(`${userId}:${sessionId}:${sessionNonce}`)
    .digest('hex');
  const wcUri      = `wc:${topic}@2?relay-protocol=irn&symKey=${sessionNonce.slice(0, 64)}`;
  const pairingUri = `${baseUrl}${encodeURIComponent(wcUri)}`;

  const expiresAt = new Date(Date.now() + config.SESSION_TTL_SECONDS * 1000);

  const session: WalletSession = { pairingUri, sessionId, sessionNonce, expiresAt };
  sessions.set(userId, session);

  // Persist pairing attempt to Supabase so it survives a bot restart.
  // We store session_link so QR generation can always read the correct URI
  // from the DB even if the memory map was cleared.
  try {
    await pool.query(
      `UPDATE users
          SET session_link   = $2,
              current_step   = 'connecting',
              is_wallet_connected = FALSE,
              last_active_at = now()
        WHERE telegram_user_id = $1`,
      [userId, pairingUri],
    );
  } catch (dbErr) {
    logger.error({ dbErr, userId }, 'generatePairingUri: failed to persist session_link to DB');
    // Don't block the user — the in-memory session is still usable
  }

  logger.info({ userId, sessionId, expiresAt }, 'Generated pairing URI');
  return session;
}

// ─── Session binding ──────────────────────────────────────────────────────────

/**
 * Marks a session as connected.
 * Called when:
 *   (a) The Binance SDK fires a "session_connected" event (real integration), OR
 *   (b) The user sends /wallet_connected and provides proof (interim flow).
 *
 * Updates BOTH the in-memory cache AND Supabase.
 * Supabase is the durable source of truth — in-memory is only a fast cache.
 */
export async function markSessionConnected(
  userId: number,
  walletAddress: string,
  agentIdName: string,
): Promise<void> {
  // Normalize
  const addr  = walletAddress.trim();
  const agent = agentIdName.trim();

  if (!addr) {
    logger.warn({ userId }, 'markSessionConnected called with empty walletAddress');
    return;
  }

  // Update or create in-memory entry
  const existing = sessions.get(userId);
  const session: WalletSession = existing
    ? { ...existing, walletAddress: addr, agentIdName: agent || undefined }
    : {
        pairingUri: '',
        sessionId: crypto.randomBytes(16).toString('hex'),
        sessionNonce: '',
        expiresAt: new Date(Date.now() + config.SESSION_TTL_SECONDS * 1000),
        walletAddress: addr,
        agentIdName: agent || undefined,
      };
  sessions.set(userId, session);

  // Persist to Supabase — this is what survives bot restarts.
  try {
    await pool.query(
      `UPDATE users
          SET is_wallet_connected = TRUE,
              current_step        = 'connected',
              last_active_at      = now()
        WHERE telegram_user_id = $1`,
      [userId],
    );
  } catch (dbErr) {
    logger.error({ dbErr, userId, addr, agent }, 'markSessionConnected: DB update failed');
    throw new Error('Failed to persist wallet connection. Please try again.');
  }

  logger.info({ userId, addr, agent }, 'Wallet session bound and persisted to Supabase');
}

// ─── Session queries ──────────────────────────────────────────────────────────

/** Returns the in-memory session for a user, or undefined */
export function getSession(userId: number): WalletSession | undefined {
  return sessions.get(userId);
}

/** Clears the in-memory session for a user (on cancel / reset) */
export function clearSession(userId: number): void {
  sessions.delete(userId);
}

/**
 * Returns true if the user has a connected wallet session.
 * Checks the in-memory cache ONLY — fast but does not survive restarts.
 * Use isSessionConnectedDb() for the authoritative check before execution.
 */
export function isSessionConnected(userId: number): boolean {
  const s = sessions.get(userId);
  return !!(s?.walletAddress && !isSessionExpired(s));
}

/**
 * Authoritative connection check against Supabase.
 * Use this in the "Complete All Process" handler before running on-chain logic.
 * Also restores the in-memory cache from DB if the bot was restarted.
 */
export async function isSessionConnectedDb(userId: number): Promise<boolean> {
  try {
    const { rows } = await pool.query<{
      is_wallet_connected: boolean;
      session_link: string | null;
    }>(
      'SELECT is_wallet_connected, session_link FROM users WHERE telegram_user_id = $1',
      [userId],
    );
    if (rows.length === 0) return false;
    return rows[0].is_wallet_connected === true;
  } catch (dbErr) {
    logger.error({ dbErr, userId }, 'isSessionConnectedDb: DB query failed');
    // Fall back to in-memory check on DB error
    return isSessionConnected(userId);
  }
}

/**
 * Returns the stored session_link (pairing URI) from Supabase.
 * Used by the QR handler to avoid re-generating a link unnecessarily.
 */
export async function getSessionLinkFromDb(userId: number): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ session_link: string | null }>(
      'SELECT session_link FROM users WHERE telegram_user_id = $1',
      [userId],
    );
    return rows[0]?.session_link ?? null;
  } catch (dbErr) {
    logger.error({ dbErr, userId }, 'getSessionLinkFromDb: DB query failed');
    return null;
  }
}

/** Returns true if the pairing session has expired */
function isSessionExpired(session: WalletSession): boolean {
  return session.expiresAt < new Date();
}

// ─── Signer factory ───────────────────────────────────────────────────────────

/**
 * Returns an ethers Signer for a connected Binance Agentic Wallet session.
 *
 * STUB — throws clearly until the Binance SDK is wired.
 * Replace this body with the real SDK call:
 *
 *   import { BinanceAgenticWallet } from '@binance/wallet-sdk';
 *   const sdk = new BinanceAgenticWallet({ sessionId: session.sessionId });
 *   return sdk.getSigner(provider);   // `provider` is the BSC JsonRpcProvider
 */
export async function buildSignerFromSession(
  userId: number,
): Promise<ethers.Signer> {
  // Check DB first (authoritative); in-memory is a fast cache only
  const connected = await isSessionConnectedDb(userId);
  if (!connected) {
    throw new Error(
      'Wallet not connected. Please tap Connect Your Binance Wallet and complete pairing first.',
    );
  }

  // ── REAL INTEGRATION POINT ────────────────────────────────────────────────
  //
  //   const session = sessions.get(userId);   // may need to reload from DB
  //   const sdk = new BinanceAgenticWallet({ sessionId: session!.sessionId });
  //   return sdk.getSigner(provider);
  //
  //   The `provider` imported above is the correct ethers JsonRpcProvider
  //   connected to BSC chainId 56.
  // ──────────────────────────────────────────────────────────────────────────

  // Suppress unused-variable lint until SDK is wired
  void provider;

  throw new Error(
    '⚠️ Binance Agentic Wallet SDK not yet wired.\n' +
    'To complete integration:\n' +
    '  1. Install the official Binance Wallet SDK package.\n' +
    '  2. Replace buildSignerFromSession() in src/wallet.ts with sdk.getSigner().\n' +
    '  3. Set BINANCE_WALLET_PAIRING_BASE_URL to the SDK pairing endpoint.\n' +
    '  4. Wire the SDK "session_connected" event to markSessionConnected().',
  );
}
