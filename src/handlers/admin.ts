// src/handlers/admin.ts
// Admin-only commands: /admin_users and /admin_completed.
// Only accessible by ADMIN_ID.

import { Context } from 'telegraf';
import { getAllStartedUsers, getCompletedUsers } from '../db.js';
import { config } from '../config.js';

function isAdmin(ctx: Context): boolean {
  return ctx.from?.id === config.ADMIN_ID;
}

/** /admin_users — list all users who ever sent /start */
export async function handleAdminUsers(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.reply('⛔ Unauthorized.');
    return;
  }

  const users = await getAllStartedUsers();
  if (users.length === 0) {
    await ctx.reply('No users yet.');
    return;
  }

  // FIX #9: plain text — user names may contain MarkdownV2 special characters
  // (dots, underscores, brackets etc.) that would cause Telegram to reject the
  // message with a 400 Bad Request if parse_mode: 'MarkdownV2' is used.
  const lines = users.slice(0, 50).map((u, i) => {
    const name = u.first_name ?? u.username ?? String(u.telegram_user_id);
    const date = new Date(u.started_at).toISOString().slice(0, 10);
    return `${i + 1}. ${name} (ID: ${u.telegram_user_id}) — joined ${date}`;
  });

  await ctx.reply(
    `👥 All Users (${users.length} total)\n\n${lines.join('\n')}` +
    (users.length > 50 ? `\n\n... and ${users.length - 50} more` : ''),
  );
}

/** /admin_completed — list all users with completed jobs + their Agent IDs */
export async function handleAdminCompleted(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.reply('⛔ Unauthorized.');
    return;
  }

  const users = await getCompletedUsers();
  if (users.length === 0) {
    await ctx.reply('No completed users yet.');
    return;
  }

  // FIX #9: plain text — agent IDs (*.ai names) contain dots which are
  // special characters in MarkdownV2 and must be escaped; using plain text
  // is simpler and more reliable for admin-facing diagnostic output.
  const lines = users.slice(0, 30).map((u, i) => {
    const name = u.first_name ?? u.username ?? String(u.telegram_user_id);
    const agents = u.agent_ids.length > 0 ? u.agent_ids.join(', ') : 'none';
    return (
      `${i + 1}. ${name} (${u.telegram_user_id})\n` +
      `    ✅ ${u.completed_count} job(s)\n` +
      `    🤖 ${agents}`
    );
  });

  await ctx.reply(
    `🏆 Completed Users (${users.length})\n\n${lines.join('\n\n')}`,
  );
}
