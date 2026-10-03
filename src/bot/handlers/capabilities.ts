import { type Bot } from "grammy";
import type { BotDeps } from "../deps.js";

function clip(text: string, max = 180): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function boundedList(header: string, lines: string[], empty: string): string {
  if (!lines.length) return empty;
  const kept: string[] = [];
  let length = header.length + 2;
  for (const line of lines) {
    if (length + line.length + 1 > 3800) break;
    kept.push(line);
    length += line.length + 1;
  }
  const omitted = lines.length - kept.length;
  return `${header}\n\n${kept.join("\n")}${omitted ? `\n\n…и ещё ${omitted}.` : ""}`;
}

export function registerCapabilities(bot: Bot, deps: BotDeps): void {
  bot.command("skills", async (ctx) => {
    await ctx.replyWithChatAction("typing").catch(() => {});
    await deps.acp.refreshInventories();
    const skills = deps.acp.availableSkills.filter((s) => s.enabled !== false);
    const lines = skills.map((s) => `• ${s.name}${s.description ? ` — ${clip(s.description)}` : ""}`);
    await ctx.reply(boundedList(`📚 Навыки Codex (${lines.length})`, lines, "Codex не сообщил о включённых навыках."));
  });

  bot.command("models", async (ctx) => {
    await ctx.replyWithChatAction("typing").catch(() => {});
    await deps.acp.refreshInventories();
    const current = deps.acp.currentModelId;
    const lines = deps.acp.availableModels.map((m) => `${m.modelId === current ? "✓" : "•"} ${m.name}`);
    await ctx.reply(boundedList(`🧩 Модели Codex (${lines.length})`, lines, "Codex не сообщил о доступных моделях."));
  });

  bot.command("agents", async (ctx) => {
    await ctx.replyWithChatAction("typing").catch(() => {});
    await deps.acp.refreshInventories();
    const modes = deps.acp.availableModes.map((m) => `• ${m.name}${m.description ? ` — ${m.description}` : ""}`);
    const running = deps.acp.currentSubagents().map((a) => `• ${a.sessionName || "Дополнительный агент"} — ${statusLabel(a.status?.type)}`);
    const sections = [
      modes.length ? `Доступные режимы:\n${modes.join("\n")}` : "Нет доступных режимов совместной работы.",
      running.length ? `Активные и недавние агенты:\n${running.join("\n")}` : "В этом процессе нет дополнительных агентов.",
    ];
    await ctx.reply(boundedList("🤖 Режимы и агенты Codex", sections, "Codex не сообщил данные о режимах и агентах."));
  });
}

function statusLabel(status?: string): string {
  switch (status?.toLowerCase()) {
    case "working": case "running": return "выполняется";
    case "pending": case "queued": return "в очереди";
    case "completed": case "done": case "terminated": return "завершён";
    case "failed": case "error": return "ошибка";
    case "cancelled": case "canceled": return "отменён";
    default: return "неизвестно";
  }
}
