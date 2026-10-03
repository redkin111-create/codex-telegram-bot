/** Technical runtime identity, intentionally kept behind /diagnostics. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { type Bot, type Context, InlineKeyboard } from "grammy";
import { PROJECT_ROOT } from "../../config.js";
import type { BotDeps } from "../deps.js";

export interface RuntimeIdentity {
  version: string;
  commit: string;
  pid: number;
  source: string;
  connected: boolean;
}

export function runtimeIdentity(source = PROJECT_ROOT, pid = process.pid, connected = false): RuntimeIdentity {
  let version = "неизвестно";
  try {
    const pkg = JSON.parse(readFileSync(`${source}/package.json`, "utf8")) as { version?: string };
    if (typeof pkg.version === "string") version = pkg.version;
  } catch { /* source may be a packaged install */ }
  let commit = `версия ${version}`;
  try {
    const result = execFileSync("git", ["-C", source, "rev-parse", "--short", "HEAD"], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (/^[0-9a-f]{7,40}$/i.test(result)) commit = result;
  } catch { /* git is optional at runtime */ }
  return { version, commit, pid, source, connected };
}

export function formatDiagnostics(identity: RuntimeIdentity): string {
  const state = identity.connected ? "подключён" : "не подключён";
  return [
    "🩺 Диагностика",
    `Версия бота: ${identity.version}`,
    `Коммит: ${identity.commit}`,
    `PID: ${identity.pid}`,
    `Codex: ${state}`,
    `Сервер Codex: ${state}`,
    `Папка запуска:\n${identity.source}`,
  ].join("\n");
}

export async function showDiagnostics(ctx: Context, deps: BotDeps): Promise<void> {
  await deps.ephemeral.open(ctx);
  const identity = runtimeIdentity(PROJECT_ROOT, process.pid, deps.acp.isConnected);
  const keyboard = new InlineKeyboard()
    .text("🔄 Обновить", "m:diagnostics")
    .row()
    .text("⬅ Ещё", "ui:back")
    .text("🏠 Меню", "ui:home");
  await deps.ephemeral.reply(ctx, formatDiagnostics(identity), { reply_markup: keyboard });
}

export function registerDiagnostics(bot: Bot, deps: BotDeps): void {
  bot.command("diagnostics", (ctx) => showDiagnostics(ctx, deps));
}
