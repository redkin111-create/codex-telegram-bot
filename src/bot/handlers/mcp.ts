/**
 * /mcp — inspect and control the Codex agent's MCP servers from Telegram.
 *
 *   • Lists configured servers plus live status/tool/resource/auth inventory
 *     reported by the running Codex app-server.
 *   • 🩺 Health-check runs a real MCP `initialize` handshake against each enabled
 *     server and reports which connected and which failed (and why).
 *   • 🔧 Enable/Disable toggles a server's `enabled` flag in config.toml. The
 *     change applies when the agent next loads servers, so a 🔄 Restart button
 *     is offered to apply it immediately.
 */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import type { BotDeps } from "../deps.js";
import { listMcpServers, setMcpDisabled } from "../../mcp/config.js";
import { probeAll } from "../../mcp/probe.js";
import type { McpProbeResult, McpServer } from "../../mcp/types.js";
import type { CodexMcpServerStatus } from "../../acp/codex-protocol.js";

const PAGE_SIZE = 10;

/** Per-chat snapshot of the last listed servers, for index-based callbacks. */
const snapshots = new Map<number, McpServer[]>();

function snapshot(chatId: number, deps: BotDeps): McpServer[] {
  const cwd = deps.registry.get(chatId).cwd;
  const list = listMcpServers(cwd);
  snapshots.set(chatId, list);
  return list;
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}

const TRANSPORT_ICON: Record<string, string> = { http: "\u{1F310}", stdio: "\u{1F5A5}\uFE0F", unknown: "\u2753" };

/** Build the main MCP panel text + keyboard. */
function mainPanel(list: McpServer[], live: CodexMcpServerStatus[]): { text: string; kb: InlineKeyboard } {
  const enabled = list.filter((s) => !s.disabled);
  const disabled = list.filter((s) => s.disabled);
  const lines = [`\u{1F9E9} MCP servers \u2014 ${list.length} total \u00B7 \u2705 ${enabled.length} enabled \u00B7 \u26D4 ${disabled.length} disabled`, ""];
  if (list.length === 0) {
    lines.push("No MCP servers configured in ~/.codex/config.toml.");
  } else {
    const LIST_CAP = 60; // keep the message well under Telegram's 4096-char limit
    for (const s of list.slice(0, LIST_CAP)) {
      const mark = s.disabled ? "\u26D4" : "\u2705";
      const ti = TRANSPORT_ICON[s.transport] ?? "";
      const scope = s.scope === "workspace" ? " \u00B7 ws" : "";
      const status = live.find((x) => x.name === s.name);
      const inventory = status
        ? ` · ${Object.keys(status.tools ?? {}).length} tools · ${(status.resources?.length ?? 0) + (status.resourceTemplates?.length ?? 0)} resources${authText(status.authStatus)}`
        : " · not loaded";
      lines.push(`${mark} ${ti} ${trunc(s.name, 28)}${scope}${inventory}`);
    }
    if (list.length > LIST_CAP) lines.push(`\u2026and ${list.length - LIST_CAP} more (use \u{1F527} Enable/Disable to browse).`);
  }
  const configNames = new Set(list.map((s) => s.name));
  for (const status of live.filter((s) => !configNames.has(s.name)).slice(0, 10)) {
    lines.push(`\u2705 \u{1F4E1} ${trunc(status.name, 28)} · app-server · ${Object.keys(status.tools ?? {}).length} tools${authText(status.authStatus)}`);
  }
  lines.push("", "\u{1F4E1} Inventory comes from Codex app-server. \u{1F9EA} Health-check independently probes enabled configs.");
  const kb = new InlineKeyboard()
    .text("\u{1F9EA} Health-check", "mcp:health")
    .text("\u{1F527} Enable/Disable", "mcp:tog:0")
    .row()
    .text("\u{1F504} Restart agent", "mcp:restart")
    .text("\u{1F501} Refresh", "mcp:refresh")
    .row()
    .text("\u2716 Close", "mcp:close");
  return { text: fitLines(lines, 3800), kb };
}

/** Build a paginated enable/disable view. */
function togglePanel(list: McpServer[], page: number): { text: string; kb: InlineKeyboard } {
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = list.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);
  const kb = new InlineKeyboard();
  slice.forEach((s) => {
    const idx = list.indexOf(s);
    const label = s.disabled ? `\u2705 Enable ${trunc(s.name, 24)}` : `\u26D4 Disable ${trunc(s.name, 24)}`;
    kb.text(label, `mcp:set:${idx}`).row();
  });
  if (pages > 1) {
    if (p > 0) kb.text("\u25C0 Prev", `mcp:tog:${p - 1}`);
    kb.text(`Page ${p + 1}/${pages}`, "mcp:noop");
    if (p < pages - 1) kb.text("Next \u25B6", `mcp:tog:${p + 1}`);
    kb.row();
  }
  kb.text("\u2B05 Back", "mcp:refresh");
  const text = `\u{1F527} Enable/Disable MCP servers (${list.length})\nTap to toggle. Changes apply after \u{1F504} Restart agent.`;
  return { text, kb };
}

export async function showMcp(ctx: Context, deps: BotDeps): Promise<void> {
  await deps.acp.refreshInventories();
  const list = snapshot(ctx.chat!.id, deps);
  const { text, kb } = mainPanel(list, deps.acp.availableMcpServers);
  await deps.ephemeral.open(ctx);
  await deps.ephemeral.reply(ctx, text, { reply_markup: kb });
}

function fmtProbe(r: McpProbeResult): string {
  if (r.ok) {
    const who = r.serverName ? ` \u00B7 ${trunc(r.serverName, 30)}` : "";
    return `\u2705 ${trunc(r.name, 26)}  ${r.ms ?? 0}ms${who}`;
  }
  return `\u274C ${trunc(r.name, 26)}  ${trunc(r.error ?? "failed", 60)}`;
}

async function runHealthCheck(ctx: Context, deps: BotDeps): Promise<void> {
  const list = snapshot(ctx.chat!.id, deps);
  const enabled = list.filter((s) => !s.disabled);
  if (enabled.length === 0) {
    await ctx.editMessageText("No enabled MCP servers to check.", {
      reply_markup: new InlineKeyboard().text("\u2B05 Back", "mcp:refresh"),
    }).catch(() => {});
    return;
  }
  const header = `\u{1F9EA} Health-check \u2014 probing ${enabled.length} enabled server(s)\u2026`;
  await ctx.editMessageText(header).catch(() => {});

  let lastEdit = 0;
  const results = await probeAll(
    enabled,
    { timeoutMs: deps.cfg.mcpProbeTimeoutMs, concurrency: deps.cfg.mcpProbeConcurrency },
    (_r, done, total) => {
      const now = Date.now();
      if (now - lastEdit < 1200 && done < total) return; // throttle progress edits
      lastEdit = now;
      void ctx.editMessageText(`${header}\n\nProgress: ${done}/${total}`).catch(() => {});
    },
  );

  const ok = results.filter((r) => r.ok).length;
  const bad = results.length - ok;
  const body = results
    .slice()
    .sort((a, b) => Number(a.ok) - Number(b.ok) || a.name.localeCompare(b.name))
    .map(fmtProbe)
    .join("\n");
  const text = `\u{1F9EA} Health-check \u2014 \u2705 ${ok} connected \u00B7 \u274C ${bad} failed\n\n${trunc(body, 3500)}`;
  const kb = new InlineKeyboard().text("\u{1F501} Re-check", "mcp:health").row().text("\u2B05 Back", "mcp:refresh");
  await ctx.editMessageText(text, { reply_markup: kb }).catch(() => {});
}

export function registerMcp(bot: Bot, deps: BotDeps): void {
  bot.command("mcp", (ctx) => showMcp(ctx, deps));

  bot.callbackQuery("mcp:noop", (ctx) => ctx.answerCallbackQuery());

  bot.callbackQuery("mcp:close", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
  });

  bot.callbackQuery("mcp:refresh", async (ctx) => {
    await ctx.answerCallbackQuery();
    await deps.acp.refreshInventories();
    const list = snapshot(ctx.chat!.id, deps);
    const { text, kb } = mainPanel(list, deps.acp.availableMcpServers);
    await ctx.editMessageText(text, { reply_markup: kb }).catch(() => {});
  });

  bot.callbackQuery("mcp:health", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Checking\u2026" });
    await runHealthCheck(ctx, deps);
  });

  bot.callbackQuery(/^mcp:tog:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const list = snapshot(ctx.chat!.id, deps);
    const { text, kb } = togglePanel(list, Number(ctx.match![1]));
    await ctx.editMessageText(text, { reply_markup: kb }).catch(() => {});
  });

  bot.callbackQuery(/^mcp:set:(\d+)$/, async (ctx) => {
    const idx = Number(ctx.match![1]);
    const cached = snapshots.get(ctx.chat!.id);
    const server = cached?.[idx];
    if (!server) {
      await ctx.answerCallbackQuery({ text: "Expired \u2014 reopen /mcp." });
      return;
    }
    const res = setMcpDisabled(server, !server.disabled);
    if (!res.ok) {
      await ctx.answerCallbackQuery({ text: `Failed: ${res.error}`, show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: res.disabled ? `Disabled ${server.name}` : `Enabled ${server.name}` });
    const page = Math.floor(idx / PAGE_SIZE);
    const list = snapshot(ctx.chat!.id, deps); // re-list to reflect the change
    const { text, kb } = togglePanel(list, page);
    await ctx.editMessageText(`${text}\n\n\u26A0\uFE0F Tap \u{1F504} Restart agent (on the main panel) to apply.`, {
      reply_markup: kb,
    }).catch(() => {});
  });

  bot.callbackQuery("mcp:restart", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Restarting agent\u2026" });
    await ctx.editMessageText("\u{1F504} Restarting the Codex agent to apply MCP changes\u2026").catch(() => {});
    try {
      await deps.acp.restart();
      await deps.acp.refreshInventories();
      const list = snapshot(ctx.chat!.id, deps);
      const { text, kb } = mainPanel(list, deps.acp.availableMcpServers);
      await ctx.editMessageText(`\u2705 Agent restarted \u2014 MCP changes applied.\n\n${text}`, {
        reply_markup: kb,
      }).catch(() => {});
    } catch (err) {
      await ctx.editMessageText(`\u274C Restart failed: ${(err as Error).message}`, {
        reply_markup: new InlineKeyboard().text("\u2B05 Back", "mcp:refresh"),
      }).catch(() => {});
    }
  });
}

function authText(status: unknown): string {
  if (status == null) return "";
  if (typeof status === "string") return ` · auth ${trunc(status, 24)}`;
  if (typeof status === "object") {
    const keys = Object.keys(status as Record<string, unknown>);
    return keys.length ? ` · auth ${trunc(keys[0]!, 24)}` : "";
  }
  return "";
}

function fitLines(lines: string[], max: number): string {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > max) {
      out.push("…more servers omitted; use Enable/Disable to browse.");
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out.join("\n");
}
