// src/db.ts
// Supabase / PostgreSQL client and schema bootstrap.

import { Pool } from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

export const pool = new Pool({ connectionString: config.SUPABASE_DB_URL });

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected DB pool error');
});

// ─── Schema Bootstrap ───────────────────────────────────────────────────────

export async function initDb(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_user_id  BIGINT PRIMARY KEY,
        username          TEXT,
        first_name        TEXT,
        started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_active_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        current_step      TEXT NOT NULL DEFAULT 'start',
        session_link      TEXT,
        qr_generated      BOOLEAN NOT NULL DEFAULT FALSE,
        is_wallet_connected BOOLEAN NOT NULL DEFAULT FALSE,
        is_cancelled      BOOLEAN NOT NULL DEFAULT FALSE,
        completed_count   INT NOT NULL DEFAULT 0
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS executions (
        id               BIGSERIAL PRIMARY KEY,
        telegram_user_id BIGINT NOT NULL REFERENCES users(telegram_user_id),
        agent_id_name    TEXT,
        status           TEXT NOT NULL,
        mint_cost_bnb    NUMERIC,
        tokens_received  NUMERIC,
        sell_bnb         NUMERIC,
        pnl_or_fee       NUMERIC,
        tx_hashes        JSONB,
        summary          TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // Safe migrations — add columns that may not exist on older deployments
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS session_link TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS qr_generated BOOLEAN NOT NULL DEFAULT FALSE`);

    logger.info('Database schema ready');
  } finally {
    client.release();
  }
}

// ─── User helpers ────────────────────────────────────────────────────────────

export interface DbUser {
  telegram_user_id: number;
  username: string | null;
  first_name: string | null;
  started_at: Date;
  last_active_at: Date;
  current_step: string;
  session_link: string | null;
  qr_generated: boolean;
  is_wallet_connected: boolean;
  is_cancelled: boolean;
  completed_count: number;
}

export async function upsertUser(
  userId: number,
  username: string | null,
  firstName: string | null,
): Promise<DbUser> {
  const { rows } = await pool.query<DbUser>(
    `INSERT INTO users (telegram_user_id, username, first_name, last_active_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (telegram_user_id) DO UPDATE
       SET username        = EXCLUDED.username,
           first_name      = EXCLUDED.first_name,
           last_active_at  = now(),
           is_cancelled    = FALSE
     RETURNING *`,
    [userId, username, firstName],
  );
  return rows[0];
}

export async function getUser(userId: number): Promise<DbUser | null> {
  const { rows } = await pool.query<DbUser>(
    'SELECT * FROM users WHERE telegram_user_id = $1',
    [userId],
  );
  return rows[0] ?? null;
}

export async function updateUser(
  userId: number,
  fields: Partial<Omit<DbUser, 'telegram_user_id' | 'started_at'>>,
): Promise<void> {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (keys.length === 0) return;
  const setClause = keys
    .map((k, i) => `${k} = $${i + 2}`)
    .join(', ');
  await pool.query(
    `UPDATE users SET ${setClause}, last_active_at = now() WHERE telegram_user_id = $1`,
    [userId, ...keys.map((k) => fields[k])],
  );
}

export async function cancelUser(userId: number): Promise<void> {
  await pool.query(
    `UPDATE users SET is_cancelled = TRUE, current_step = 'cancelled', last_active_at = now()
     WHERE telegram_user_id = $1`,
    [userId],
  );
}

// ─── Execution helpers ───────────────────────────────────────────────────────

export interface DbExecution {
  id: number;
  telegram_user_id: number;
  agent_id_name: string | null;
  status: string;
  mint_cost_bnb: string | null;
  tokens_received: string | null;
  sell_bnb: string | null;
  pnl_or_fee: string | null;
  tx_hashes: Record<string, string> | null;
  summary: string | null;
  created_at: Date;
}

export async function insertExecution(
  data: Omit<DbExecution, 'id' | 'created_at'>,
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO executions
       (telegram_user_id, agent_id_name, status, mint_cost_bnb, tokens_received,
        sell_bnb, pnl_or_fee, tx_hashes, summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      data.telegram_user_id,
      data.agent_id_name,
      data.status,
      data.mint_cost_bnb,
      data.tokens_received,
      data.sell_bnb,
      data.pnl_or_fee,
      data.tx_hashes ? JSON.stringify(data.tx_hashes) : null,
      data.summary,
    ],
  );
  return rows[0].id;
}

export async function getUserExecutions(
  userId: number,
): Promise<DbExecution[]> {
  const { rows } = await pool.query<DbExecution>(
    `SELECT * FROM executions WHERE telegram_user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

// ─── Admin helpers ───────────────────────────────────────────────────────────

export async function getAllStartedUsers(): Promise<DbUser[]> {
  const { rows } = await pool.query<DbUser>(
    'SELECT * FROM users ORDER BY started_at DESC',
  );
  return rows;
}

export async function getCompletedUsers(): Promise<
  Array<DbUser & { agent_ids: string[] }>
> {
  const { rows } = await pool.query<DbUser & { agent_ids: string[] }>(
    `SELECT u.*, COALESCE(
       array_agg(e.agent_id_name ORDER BY e.created_at DESC) FILTER (WHERE e.agent_id_name IS NOT NULL),
       '{}'
     ) AS agent_ids
     FROM users u
     LEFT JOIN executions e ON e.telegram_user_id = u.telegram_user_id
       AND e.status = 'COMPLETED'
     WHERE u.completed_count > 0
     GROUP BY u.telegram_user_id
     ORDER BY u.completed_count DESC`,
  );
  return rows;
}
