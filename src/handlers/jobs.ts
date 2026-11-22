// src/handlers/jobs.ts
// "My Completed Jobs & Agent IDs" callback handler.

import { Context } from 'telegraf';
import { getUserExecutions, getUser } from '../db.js';
import { KB } from '../keyboards.js';

// FIX #11: answerCbQuery is only valid when there is an active callback query.
// When reached via free-text NL routing, ctx.callbackQuery is undefined.
async function safeAnswerCb(ctx: Context, text?: string): Promise<void> {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery(text);
  } catch {
    // not a callback context — ignore
  }
}

export async function handleMyJobs(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  await safeAnswerCb(ctx, 'Loading your jobs…');

  const [user, executions] = await Promise.all([
    getUser(userId),
    getUserExecutions(userId),
  ]);

  const completed = executions.filter((e) => e.status === 'COMPLETED');

  if (completed.length === 0) {
    await ctx.reply(
      '📋 You have no completed jobs yet.\n\nTap Complete All Process to run your first job!',
      KB.postExecution,
    );
    return;
  }

  const agentIds = [
    ...new Set(completed.map((e) => e.agent_id_name).filter(Boolean)),
  ] as string[];

  // FIX #10: use plain text replies — avoids MarkdownV2 parse failures on
  // agent IDs or names that contain MarkdownV2 special chars (e.g. dots in *.ai).
  const lines = [
    `📊 Your Completed Jobs`,
    ``,
    `✅ Total completed: ${completed.length}`,
    ``,
    `🤖 Agent IDs used:`,
    ...agentIds.map((id) => `  • ${id}`),
    ``,
    `📋 Recent jobs (last 5):`,
    ...completed.slice(0, 5).map((e, i) => {
      const date = e.created_at
        ? new Date(e.created_at).toISOString().slice(0, 10)
        : '?';
      return (
        `${i + 1}. ${e.agent_id_name ?? '?'} — ` +
        `${e.mint_cost_bnb ?? '?'} BNB → ` +
        `${e.sell_bnb ?? '?'} BNB (${date})`
      );
    }),
  ];

  await ctx.reply(lines.join('\n'), KB.postExecution);
}
