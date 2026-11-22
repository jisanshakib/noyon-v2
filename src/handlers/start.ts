// src/handlers/start.ts
// /start command handler.

import { Context } from 'telegraf';
import { upsertUser } from '../db.js';
import { KB } from '../keyboards.js';
import { logger } from '../logger.js';

export async function handleStart(ctx: Context): Promise<void> {
  const user = ctx.from;
  if (!user) return;

  try {
    await upsertUser(user.id, user.username ?? null, user.first_name ?? null);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'handleStart: DB upsert failed');
  }

  const name = user.first_name ?? user.username ?? 'there';
  await ctx.reply(
    `👋 Welcome, *${escMd(name)}*\\!\n\n` +
    `This bot automates BSC token minting and selling via your Binance Agentic Wallet\\.\n\n` +
    `🔒 *Security reminder:* We will never ask for your seed phrase or private key\\.\n\n` +
    `Choose an action below:`,
    { parse_mode: 'MarkdownV2', ...KB.start },
  );
}

/** Escape MarkdownV2 special characters */
export function escMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}
