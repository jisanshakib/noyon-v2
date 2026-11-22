// src/wallet.ts
// Binance Agentic Wallet / WalletConnect session-pairing adapter.
//
// ARCHITECTURE NOTE:
//   Full Binance Agentic Wallet integration requires a Binance Skills/MCP
//   adapter that provides real-time pairing, Agent IDs (*.ai), and signing.
//   Until that adapter is wired, this module:
//     - Generates a deterministic WalletConnect-style deep-link (pairing URI).
//     - Tracks connection state in Supabase per user.
//     - Exposes a stub signer factory that callers must replace with real
//       session keys once the Binance SDK is available.
//
// WIRING REAL BINANCE WALLET:
//   1. Install the official Binance Wallet SDK / MCP package.
//   2. Replace `generatePairingUri()` with the SDK's session.create() call.
//   3. Replace `buildSignerFromSession()` with the SDK's session.getSigner()
//      (providing the statically-imported `provider` from bsc.ts).
//   4. Set BINANCE_WALLET_PAIRING_BASE_URL in .env if the SDK needs it.

// FIX #14: moved ethers + provider import to the TOP of the file.
// The original had these imports mid-file (after the crypto imports), which
// is valid JS/TS but creates a circular-import footgun and misleads readers
// into thinking the signer section is a separate optional module.
import { ethers } from 'ethers';
import * as crypto from 'crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { provider } from './bsc.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WalletSession {
  pairingUri: string;    // WalletConnect / deep-link URI shown to user
  sessionId: string;     // internal session identifier
  walletAddress?: string; // populated after wallet connects
  agentIdName?: string;  // *.ai name, populated after wallet connects
}

// In-memory session store (key = telegramUserId)
// In production you would persist this to Redis or Supabase.
const sessions = new Map<number, WalletSession>();

// ─── Pairing URI generation ───────────────────────────────────────────────────

/**
 * Generates a WalletConnect-style pairing URI and deep-link for Binance Wallet.
 * Returns a session object to be persisted in Supabase session_link.
 *
 * STUB: Replace the URI construction with the real Binance SDK call when available.
 */
export async function generatePairingUri(userId: number): Promise<WalletSession> {
  const sessionId = crypto.randomBytes(16).toString('hex');
  // Deterministic topic for this session
  const topic = crypto.createHash('sha256').update(`${userId}:${sessionId}`).digest('hex');

  // WalletConnect v2 URI format (stub — replace with real SDK)
  const wcUri = `wc:${topic}@2?relay-protocol=irn&symKey=${sessionId}`;
  const pairingUri = config.BINANCE_WALLET_PAIRING_BASE_URL
    ? `${config.BINANCE_WALLET_PAIRING_BASE_URL}${encodeURIComponent(wcUri)}`
    : wcUri;

  const session: WalletSession = { pairingUri, sessionId };
  sessions.set(userId, session);

  logger.info({ userId, sessionId }, 'Generated pairing URI');
  return session;
}

/**
 * Marks a session as connected with a wallet address and agent ID.
 * Called when the Binance SDK fires a "session_connected" event.
 *
 * STUB: Wire this to the real SDK callback.
 */
export function markSessionConnected(
  userId: number,
  walletAddress: string,
  agentIdName: string,
): void {
  const session = sessions.get(userId);
  if (!session) {
    logger.warn({ userId }, 'markSessionConnected: no session found');
    return;
  }
  session.walletAddress = walletAddress;
  session.agentIdName = agentIdName;
  sessions.set(userId, session);
  logger.info({ userId, walletAddress, agentIdName }, 'Session connected');
}

/** Returns the current session for a user, or undefined */
export function getSession(userId: number): WalletSession | undefined {
  return sessions.get(userId);
}

/** Clears the session for a user (on cancel / reset) */
export function clearSession(userId: number): void {
  sessions.delete(userId);
}

/** Returns true if the user has a connected wallet session */
export function isSessionConnected(userId: number): boolean {
  const s = sessions.get(userId);
  return !!(s?.walletAddress);
}

// ─── Signer factory ───────────────────────────────────────────────────────────

/**
 * Returns an ethers Signer for a connected Binance Agentic Wallet session.
 *
 * STUB IMPLEMENTATION:
 *   The real implementation would retrieve the session signing key / JSON-RPC
 *   provider from the Binance SDK and return a connected RemoteSigner.
 *
 *   This stub throws clearly so callers know the wallet is not fully wired.
 *   Replace the body of this function with real SDK integration.
 */
export async function buildSignerFromSession(
  userId: number,
): Promise<ethers.Signer> {
  const session = sessions.get(userId);
  if (!session?.walletAddress) {
    throw new Error(
      'Wallet not connected. Please connect your Binance Wallet first.',
    );
  }

  // ── REAL INTEGRATION POINT ──────────────────────────────────────────────
  // Replace this block with Binance SDK signer:
  //
  //   import { BinanceAgenticWallet } from '@binance/wallet-sdk';
  //   const sdk = new BinanceAgenticWallet({ sessionId: session.sessionId });
  //   return sdk.getSigner(provider);
  //
  // The `provider` imported at the top of this file (from bsc.ts) is the
  // correct ethers JsonRpcProvider connected to BSC chainId 56.
  // ────────────────────────────────────────────────────────────────────────

  // Suppress unused-variable lint warning on `provider` until SDK is wired:
  void provider;

  throw new Error(
    '⚠️ Binance Agentic Wallet SDK not yet wired. ' +
    'Replace buildSignerFromSession() in src/wallet.ts with real SDK integration. ' +
    `Session ID: ${session.sessionId}, Wallet: ${session.walletAddress}`,
  );
}
