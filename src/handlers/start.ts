// src/handlers/start.ts
// /start command handler — displays JAGER platform link, fixed referrer notice, and role-aware menu.

import { Context } from 'telegraf';
import { upsertUser } from '../db.js';
import { isAdminId } from '../config.js';
import { KB } from '../keyboards.js';
import { logger } from '../logger.js';

export async function handleStart(ctx: Context): Promise<void> {
  const user = ctx.from;
  if (!user) return;

  try {
    await upsertUser(user.id, user.username ?? null, user.first_name ?? null);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'handleStart: DB upsert failed (continuing)');
  }

  const name = user.first_name ?? user.username ?? 'there';
  const admin = isAdminId(user.id);

  // Strict Admin Role Isolation: Admins see ONLY the Admin Control Center & Treasury menu
  if (admin) {
    const adminWelcome = [
      `🛡️ Welcome, Admin ${name}!`,
      ``,
      `Admin accounts are strictly isolated to the Admin Dashboard, Auto-Payment Treasury Wallet, Withdraw Amount configuration, and Bot Control commands.`,
      `(Regular user task/execution flows are disabled for admin accounts to keep treasury & user operations separated.)`,
      ``,
      `Commands: /admin | /admin_wallet | /admin_withdraw <USDT> | /admin_resume | /admin_completed | /admin_incomplete | /admin_users | /admin_stop`,
    ].join('\n');
    await ctx.reply(adminWelcome, KB.startForAdmin);
    return;
  }

  // Plain text ensures usernames/dots never fail Telegram MarkdownV2 parsing.
  // Keep user-facing welcome strictly clean (no internal website URLs, source domains, or contract addresses).
  const welcome = [
    `👋 Welcome, ${name}!`,
    ``,
    `🚀 Automated 5-Step One-Confirm Cycle (BNB Smart Chain)`,
    `Connect your non-custodial Binance Agentic Wallet to run all 5 steps automatically after one confirmation, then submit your BEP-20 payout wallet (or skip to Agent Wallet) and claim your USDT reward.`,
    ``,
    `🔒 Security Reminder:`,
    `• We will NEVER ask for your seed phrase or private key.`,
    `• Never send USDT or BNB directly to any external address.`,
    `• Uses exact approvals only (no unlimited approvals) and LOW/MEDIUM gas settings.`,
    ``,
    `Choose an action below:`,
  ].join('\n');

  await ctx.reply(welcome, KB.start);
}

/** Escape MarkdownV2 special characters (retained for utility compatibility) */
export function escMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}
