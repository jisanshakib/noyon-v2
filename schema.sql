-- ============================================================
-- Binance Agentic TG Bot — Supabase / PostgreSQL Schema
-- Run this once against your Supabase project using:
--   psql "$SUPABASE_DB_URL" -f schema.sql
-- or paste it into the Supabase SQL Editor.
-- ============================================================

-- ── Users ─────────────────────────────────────────────────────────────────────
-- One row per Telegram user. Tracks wallet connection state and job count.

CREATE TABLE IF NOT EXISTS users (
  telegram_user_id    BIGINT      PRIMARY KEY,
  username            TEXT,
  first_name          TEXT,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_step        TEXT        NOT NULL DEFAULT 'start',
  -- current_step values: start | connecting | qr_shown | executing | completed | failed | cancelled
  session_link        TEXT,       -- WalletConnect pairing URI
  qr_generated        BOOLEAN     NOT NULL DEFAULT FALSE,
  is_wallet_connected BOOLEAN     NOT NULL DEFAULT FALSE,
  is_cancelled        BOOLEAN     NOT NULL DEFAULT FALSE,
  completed_count     INT         NOT NULL DEFAULT 0
);

-- Index for admin "last active" queries
CREATE INDEX IF NOT EXISTS idx_users_last_active ON users (last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_completed   ON users (completed_count DESC) WHERE completed_count > 0;

-- ── Executions ────────────────────────────────────────────────────────────────
-- One row per mint/approve/sell pipeline run (all statuses).

CREATE TABLE IF NOT EXISTS executions (
  id               BIGSERIAL   PRIMARY KEY,
  telegram_user_id BIGINT      NOT NULL REFERENCES users (telegram_user_id) ON DELETE CASCADE,
  agent_id_name    TEXT,                       -- *.ai SPACE ID name, or wallet address fallback
  status           TEXT        NOT NULL,       -- COMPLETED | STOPPED | CANCELLED | FAILED
  mint_cost_bnb    NUMERIC(30, 18),            -- BNB spent on mint (exact wei→ether)
  tokens_received  NUMERIC(30, 18),            -- AI tokens received after mint
  sell_bnb         NUMERIC(30, 18),            -- BNB received from PancakeSwap sell
  pnl_or_fee       NUMERIC(30, 18),            -- sell_bnb − mint_cost_bnb (negative = loss)
  tx_hashes        JSONB,                      -- { "mint": "0x...", "approve": "0x...", "sell": "0x..." }
  summary          TEXT,                       -- AI-generated summary or stop reason
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_executions_user    ON executions (telegram_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_status  ON executions (status);
CREATE INDEX IF NOT EXISTS idx_executions_agent   ON executions (agent_id_name) WHERE agent_id_name IS NOT NULL;
