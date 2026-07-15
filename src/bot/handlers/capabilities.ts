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
  return `${header}\n\n${kept.join("\n")}${omitted ? `\n\n…and ${omitted} more.` : ""}`;
}

export function registerCapabilities(bot: Bot, deps: BotDeps): void {
  bot.command("skills", async (ctx) => {
    await ctx.replyWithChatAction("typing").catch(() => {});
    await deps.acp.refreshInventories();
    const skills = deps.acp.availableSkills.filter((s) => s.enabled !== false);
    const lines = skills.map((s) => `• ${s.name}${s.description ? ` — ${clip(s.description)}` : ""}`);
    await ctx.reply(boundedList(`📚 Codex skills (${lines.length})`, lines, "No enabled skills were reported by Codex."));
  });

  bot.command("models", async (ctx) => {
    await ctx.replyWithChatAction("typing").catch(() => {});
    await deps.acp.refreshInventories();
    const current = deps.acp.currentModelId;
    const lines = deps.acp.availableModels.map((m) => `${m.modelId === current ? "✓" : "•"} ${m.name} (${m.modelId})`);
    await ctx.reply(boundedList(`🧩 Codex models (${lines.length})`, lines, "No models were reported by Codex."));
  });

  bot.command("agents", async (ctx) => {
    await ctx.replyWithChatAction("typing").catch(() => {});
    await deps.acp.refreshInventories();
    const modes = deps.acp.availableModes.map((m) => `• ${m.name}${m.description ? ` — ${m.description}` : ""}`);
    const running = deps.acp.currentSubagents().map((a) => `• ${a.sessionName || a.sessionId.slice(0, 8)} — ${a.status?.type || "unknown"}`);
    const sections = [
      modes.length ? `Selectable collaboration modes:\n${modes.join("\n")}` : "No selectable collaboration modes reported.",
      running.length ? `Active/recent subagents:\n${running.join("\n")}` : "No subagents reported in the current process.",
    ];
    await ctx.reply(boundedList("🤖 Codex agents", sections, "No agent data was reported by Codex."));
  });
}
