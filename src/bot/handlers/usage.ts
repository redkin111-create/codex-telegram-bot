/**
 * /usage — show account info and the current session's context usage.
 */
import type { Bot, Context } from "grammy";
import type { BotDeps } from "../deps.js";

export async function showUsage(ctx: Context, deps: BotDeps): Promise<void> {
  await ctx.replyWithChatAction("typing").catch(() => {});
  const rt = deps.registry.get(ctx.chat!.id);
  const live = await deps.usage.live();
  const acct = live.account;
  const meta = rt.contextInfo();
  const ctx100 = meta?.contextUsagePercentage;
  const savedCount = deps.accounts.list().length;

  const lines = [
    "\u{1F4CA} Usage & account",
    acct?.email ? `\u{1F464} ${acct.email}` : "",
    acct?.accountType ? `\u{1F511} ${acct.accountType}${acct.region ? ` \u00B7 ${acct.region}` : ""}` : "",
    "",
    `\u{1F9F5} Session: ${rt.sessionId ? rt.sessionId.slice(0, 8) : "none"}`,
    `\u{1F9E9} Model: ${rt.model || "default"}`,
    `\u{1F4CA} Context used: ${ctx100 !== undefined ? `${ctx100.toFixed(0)}%` : "\u2014"}`,
    `\u{1F501} Turns this session: ${rt.turns}`,
    meta?.credits !== undefined ? `\u{1FA99} Credits used: ${meta.credits.toLocaleString("en-US")}` : "",
    meta?.effort ? `\u{1F9E0} Effort: ${meta.effort}` : "",
    savedCount > 0 ? `\u{1F465} Saved accounts: ${savedCount} \u00B7 /accounts to switch` : "",
    ...live.limits.flatMap(formatLimit),
    "",
    live.limits.length === 0 ? "\u2139\uFE0F Account quota is not available from this Codex login/provider." : "",
  ].filter(Boolean);

  if (!acct) lines.splice(1, 0, "(account info unavailable \u2014 is codex logged in?)");
  await deps.ephemeral.open(ctx);
  await deps.ephemeral.reply(ctx, lines.join("\n"));
}

function formatLimit(limit: { limitName?: string | null; limitId?: string | null; primary?: { usedPercent: number; resetsAt?: number | null } | null; secondary?: { usedPercent: number; resetsAt?: number | null } | null; credits?: { unlimited: boolean; balance?: string | null } | null; rateLimitReachedType?: string | null }): string[] {
  const name = limit.limitName || limit.limitId || "Codex quota";
  const lines: string[] = [];
  if (limit.primary) lines.push(`\u23F1 ${name}: ${clampPercent(limit.primary.usedPercent)}% used${resetText(limit.primary.resetsAt)}`);
  if (limit.secondary) lines.push(`\u{1F4C5} ${name} secondary: ${clampPercent(limit.secondary.usedPercent)}% used${resetText(limit.secondary.resetsAt)}`);
  if (limit.credits && !limit.credits.unlimited) lines.push(`\u{1FA99} Credit balance: ${limit.credits.balance ?? "unavailable"}`);
  if (limit.rateLimitReachedType) lines.push(`\u26D4 Limit reached: ${limit.rateLimitReachedType.replaceAll("_", " ")}`);
  return lines;
}

function clampPercent(value: number): string {
  return Math.max(0, Math.min(100, value)).toFixed(0);
}

function resetText(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) return "";
  const date = new Date(epochSeconds * 1000);
  return Number.isNaN(date.getTime()) ? "" : ` \u00B7 resets ${date.toLocaleString()}`;
}

export function registerUsage(bot: Bot, deps: BotDeps): void {
  bot.command("usage", (ctx) => showUsage(ctx, deps));
}
