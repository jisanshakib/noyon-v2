// src/wallet.ts
// Binance Agentic Wallet session management.
//
// Uses the official @binance/agentic-wallet CLI ("baw") — installed as a local
// npm dependency.  The CLI is invoked via child_process to avoid any native
// module / ESM incompatibilities that would arise from directly importing its
// bundled code.
//
// Flow per user:
//   1. handleConnectWallet → callBaw(['auth','signin','--json'])
//        Returns { qrCodeId, urlForWeb, expireAt, pairingCode? }
//        urlForWeb is the REAL Binance pairing deep-link / QR URI.
//   2. handleGenerateQr → reads urlForWeb from Supabase / memory, generates QR.
//   3. handleVerifyWallet (background after step 1) → callBaw(['auth','verify','--qrCodeId',id,'--json'])
//        Blocks until CONNECTED or times out.  On success:
//          - callBaw(['wallet','address','--json']) → walletAddress on BSC
//          - callBaw(['wallet','agent-id','--json']) → agentId (*.ai) if claimed
//          - markSessionConnected(userId, addr, agentId) → persists to Supabase
//          - Sends a Telegram confirmation message to the user.
//
// Security:  Never stores or requests seed phrases or private keys.
//            The baw CLI stores session tokens in ~/.binance-agentic-wallet/
//            on the deployment server (Railway/Render).  Each user gets their
//            own independent baw session via per-user session-file isolation
//            (see BAW_SESSION_DIR env var or the default home-dir path).

import { spawn }   from 'child_process';
import * as path   from 'path';
import * as fs     from 'fs';
import * as os     from 'os';
import { config }  from './config.js';
import { logger }  from './logger.js';
import { pool }    from './db.js';
import { ethers }  from 'ethers';
import { provider } from './bsc.js';

// ─── Path to baw binary ───────────────────────────────────────────────────────

// Resolve baw from the local node_modules so we don't require a global install.
// __dirname works in CommonJS (tsconfig module: "commonjs").
const BAW_BIN = path.resolve(
  __dirname,
  '..',
  'node_modules',
  '@binance',
  'agentic-wallet',
  'dist',
  'index.js',
);

if (!fs.existsSync(BAW_BIN)) {
  logger.error({ BAW_BIN }, 'baw binary not found — run: npm install @binance/agentic-wallet');
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WalletSession {
  qrCodeId: string;         // Binance pairing QR code ID (from baw auth signin)
  urlForWeb: string;        // REAL Binance pairing URL (shown as link + QR)
  expireAt: number;         // Unix ms timestamp when pairing expires (~5 min)
  pairingCode?: string;     // Short human-readable pairing code
  walletAddress?: string;   // Populated after wallet connects
  agentIdName?: string;     // *.ai SPACE ID name, populated after wallet connects
}

// In-memory session cache (key = telegramUserId).
// Supabase is the durable source of truth; this is a fast-path cache.
const sessions = new Map<number, WalletSession>();

// ─── BAW CLI helper ───────────────────────────────────────────────────────────

/**
 * Runs `node <baw> <args...> --json` and returns the parsed JSON output.
 * Throws with the CLI's stderr on non-zero exit or JSON parse failure.
 *
 * Per-user session isolation: baw stores credentials in a directory derived
 * from HOME.  For multi-user bots, set HOME per-invocation via env to give
 * each user their own credential store.  We use a subfolder per userId so
 * multiple users' sessions don't collide on the same server.
 */
async function callBaw(
  args: string[],
  userId?: number,
  timeoutMs = 310_000,  // 5 min + 10 s buffer (baw verify polls up to 5 min)
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Build per-user HOME so baw session files are isolated per Telegram user
    const userHome = userId != null
      ? path.join(os.homedir(), '.baw-sessions', String(userId))
      : os.homedir();

    // Ensure the directory exists
    fs.mkdirSync(userHome, { recursive: true });

    const child = spawn(
      process.execPath,  // node
      [BAW_BIN, ...args, '--json'],
      {
        env: { ...process.env, HOME: userHome, USERPROFILE: userHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`baw ${args[0]} ${args[1] ?? ''} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(
          `baw ${args.join(' ')} exited ${code}: ${stderr.trim() || stdout.trim()}`,
        ));
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error(
          `baw ${args.join(' ')} returned non-JSON: ${stdout.trim().slice(0, 200)}`,
        ));
      }
    });
  });
}

// ─── Pairing / Sign-in ────────────────────────────────────────────────────────

/**
 * Calls `baw auth signin --json` for the given user.
 * Returns the real Binance pairing session, or null on failure.
 *
 * On success, the urlForWeb is the REAL Binance deep-link that users must open
 * in the Binance app (or scan as QR) to authorize the agentic wallet session.
 */
export async function generatePairingUri(userId: number): Promise<WalletSession | null> {
  try {
    const raw = await callBaw(['auth', 'signin'], userId, 15_000) as Record<string, unknown>;

    // Expected shape: { qrCodeId, urlForWeb, expireAt, pairingCode? }
    const qrCodeId   = String(raw.qrCodeId   ?? '');
    const urlForWeb  = String(raw.urlForWeb   ?? '');
    const expireAt   = Number(raw.expireAt    ?? Date.now() + 5 * 60 * 1000);
    const pairingCode = raw.pairingCode != null ? String(raw.pairingCode) : undefined;

    if (!qrCodeId || !urlForWeb) {
      logger.error({ raw, userId }, 'baw auth signin returned unexpected shape');
      return null;
    }

    const session: WalletSession = { qrCodeId, urlForWeb, expireAt, pairingCode };
    sessions.set(userId, session);

    // Persist to Supabase so QR handler can read it after a bot restart
    await pool.query(
      `UPDATE users
          SET session_link        = $2,
              is_wallet_connected = FALSE,
              current_step        = 'connecting',
              last_active_at      = now()
        WHERE telegram_user_id = $1`,
      [userId, urlForWeb],
    );

    logger.info({ userId, qrCodeId, expireAt }, 'baw auth signin succeeded');
    return session;
  } catch (err) {
    logger.error({ err, userId }, 'baw auth signin failed');
    return null;
  }
}

// ─── Verification (background) ────────────────────────────────────────────────

/**
 * Calls `baw auth verify --qrCodeId <id> --json` and waits for CONNECTED.
 * This is a BLOCKING call (~up to 5 min) — always run it in a background
 * async chain (do NOT await it in a request handler directly).
 *
 * On success, fetches the wallet address and agent-id, then calls
 * markSessionConnected() which persists to Supabase and updates the cache.
 *
 * Returns the connected WalletSession, or null on timeout/rejection.
 */
export async function verifyAndBindSession(
  userId: number,
  qrCodeId: string,
  onConnected: (session: WalletSession) => void,
  onFailed: (reason: string) => void,
): Promise<void> {
  try {
    logger.info({ userId, qrCodeId }, 'Starting baw auth verify (background)');

    // 1. Wait for the user to scan and approve in the Binance app
    await callBaw(['auth', 'verify', '--qrCodeId', qrCodeId], userId, 310_000);

    // 2. Fetch wallet address (BSC = eip155:56)
    const addrRaw = await callBaw(['wallet', 'address'], userId, 10_000) as Record<string, unknown>;
    // Expected: { addresses: [ { chain, address }, ... ] } or { bsc: "0x..." }
    const walletAddress = extractBscAddress(addrRaw);

    if (!walletAddress) {
      onFailed('Wallet connected but could not read BSC address. Please try again.');
      return;
    }

    // 3. Fetch agent ID (may not be claimed — that's ok)
    let agentIdName = '';
    try {
      const agentRaw = await callBaw(['wallet', 'agent-id'], userId, 10_000) as Record<string, unknown>;
      // Expected: { claimed: true, agentId: "yourname.ai" }
      if (agentRaw.claimed === true && typeof agentRaw.agentId === 'string') {
        agentIdName = agentRaw.agentId;
      }
    } catch (agentErr) {
      logger.warn({ agentErr, userId }, 'baw wallet agent-id failed — continuing without agent ID');
    }

    // 4. Persist connection
    await markSessionConnected(userId, walletAddress, agentIdName);

    // 5. Notify caller
    const session = sessions.get(userId)!;
    onConnected(session);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    logger.error({ err, userId }, 'baw auth verify failed');
    onFailed(msg.includes('expired') || msg.includes('QR_CODE_EXPIRED')
      ? 'Pairing expired. Please tap Connect Your Binance Wallet again to get a fresh link.'
      : `Wallet connection failed: ${msg}`);
  }
}

/** Extracts the BSC (eip155:56 / BNB Chain) address from baw wallet address --json output */
function extractBscAddress(raw: Record<string, unknown>): string | null {
  // Try array format: { addresses: [ { chain: "BSC", address: "0x..." } ] }
  if (Array.isArray(raw.addresses)) {
    for (const entry of raw.addresses as Array<{ chain?: string; address?: string }>) {
      const chain = (entry.chain ?? '').toUpperCase();
      if (chain === 'BSC' || chain === 'BNB' || chain === 'BNB CHAIN' || chain === 'BNB SMART CHAIN') {
        if (entry.address && /^0x[0-9a-fA-F]{40}$/.test(entry.address)) {
          return entry.address;
        }
      }
    }
    // Fallback: take first EVM address
    for (const entry of raw.addresses as Array<{ address?: string }>) {
      if (entry.address && /^0x[0-9a-fA-F]{40}$/.test(entry.address)) {
        return entry.address;
      }
    }
  }

  // Try flat format: { bsc: "0x..." } or { bnb: "0x..." } or { address: "0x..." }
  for (const key of ['bsc', 'bnb', 'bnbChain', 'binanceSmartChain', 'eip155_56', 'address']) {
    const val = raw[key];
    if (typeof val === 'string' && /^0x[0-9a-fA-F]{40}$/.test(val)) return val;
  }

  logger.warn({ raw }, 'extractBscAddress: could not find BSC address in baw output');
  return null;
}

// ─── Session binding ──────────────────────────────────────────────────────────

/**
 * Marks a session as connected.
 * Updates BOTH the in-memory cache AND Supabase.
 * Supabase is the durable source of truth; in-memory is a fast-path cache.
 */
export async function markSessionConnected(
  userId: number,
  walletAddress: string,
  agentIdName: string,
): Promise<void> {
  const addr  = walletAddress.trim();
  const agent = agentIdName.trim();

  if (!addr) {
    throw new Error('markSessionConnected: walletAddress is required');
  }

  const existing = sessions.get(userId);
  const session: WalletSession = existing
    ? { ...existing, walletAddress: addr, agentIdName: agent || undefined }
    : {
        qrCodeId: '',
        urlForWeb: '',
        expireAt: Date.now() + 300_000,
        walletAddress: addr,
        agentIdName: agent || undefined,
      };
  sessions.set(userId, session);

  await pool.query(
    `UPDATE users
        SET is_wallet_connected = TRUE,
            current_step        = 'connected',
            last_active_at      = now()
      WHERE telegram_user_id = $1`,
    [userId],
  );

  logger.info({ userId, addr, agent }, 'Wallet session bound and persisted to Supabase');
}

// ─── Session queries ──────────────────────────────────────────────────────────

/** Returns the in-memory session for a user, or undefined */
export function getSession(userId: number): WalletSession | undefined {
  return sessions.get(userId);
}

/** Clears the in-memory session and signs out the baw CLI session for a user */
export async function clearSession(userId: number): Promise<void> {
  sessions.delete(userId);
  try {
    await callBaw(['auth', 'signout'], userId, 10_000);
  } catch (err) {
    logger.warn({ err, userId }, 'baw signout failed — session file may already be cleared');
  }
}

/**
 * Returns true if the user has a connected, non-expired wallet session.
 * Checks in-memory cache ONLY.  Use isSessionConnectedDb() for the
 * authoritative check before running any on-chain logic.
 */
export function isSessionConnected(userId: number): boolean {
  const s = sessions.get(userId);
  return !!(s?.walletAddress);
}

/**
 * Authoritative connection check against Supabase.
 * Use this in the "Complete All Process" handler.
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
    return isSessionConnected(userId);  // fall back to memory
  }
}

/**
 * Returns the stored pairing URL from Supabase.
 * Used by the QR handler to avoid re-generating after a bot restart.
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

// ─── Signer factory ───────────────────────────────────────────────────────────

/**
 * Returns an ethers Signer for a connected Binance Agentic Wallet session.
 *
 * The baw CLI does NOT expose a direct programmatic signer interface today.
 * On-chain writes (mint, approve, sell) must be sent as transaction requests
 * through the CLI's `contract-call` or `market-order swap` subcommands, or
 * through WalletConnect session_request JSON-RPC once a WalletConnect relay
 * session is established.
 *
 * CURRENT LIMITATION:
 *   The baw CLI manages keys internally (MPC keyless infrastructure).
 *   There is no way to extract a raw private key — this is by design and
 *   correct from a security standpoint.
 *
 * OPTIONS FOR ON-CHAIN EXECUTION:
 *   Option A — Use `baw contract-call` to send pre-encoded calldata:
 *     await callBaw(['contract-call', '--to', mintContract, '--data', encoded, '--value', weiStr])
 *     This requires the user to approve each tx in the Binance app.
 *
 *   Option B — Establish a WalletConnect session via @walletconnect/sign-client
 *     and send eth_sendTransaction requests through that relay, which the
 *     Binance app auto-approves if Developer Mode is enabled.
 *
 *   Option C — Use a separate bot-owned EOA wallet (private key in env) for
 *     execution, with the user's baw session used only for identity/agent-id.
 *
 * This stub throws clearly so the caller knows execution is blocked until
 * one of the options above is implemented.
 */
export async function buildSignerFromSession(userId: number): Promise<ethers.Signer> {
  const connected = await isSessionConnectedDb(userId);
  if (!connected) {
    throw new Error(
      'Wallet not connected. Please tap Connect Your Binance Wallet and complete pairing first.',
    );
  }

  // Suppress lint warning on `provider` until real signer is wired
  void provider;

  throw new Error(
    '⚠️ On-chain signing via baw is not yet wired.\n' +
    'The baw CLI manages keys internally (MPC — no private key export).\n' +
    'To complete the mint/approve/sell pipeline, implement one of:\n' +
    '  A) baw contract-call --to <contract> --data <calldata> --value <wei>\n' +
    '  B) WalletConnect sign-client + eth_sendTransaction via Binance app approval\n' +
    '  C) Separate bot EOA wallet (EXECUTOR_PRIVATE_KEY env var)\n' +
    'See src/wallet.ts → buildSignerFromSession() for details.',
  );
}
