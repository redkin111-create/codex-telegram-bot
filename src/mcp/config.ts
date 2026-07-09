/**
 * MCP config store — reads and edits Codex's `config.toml` `[mcp_servers.*]`
 * tables.
 *
 * Sources, in precedence order for display (a workspace entry shadows a global
 * one with the same name):
 *   • global    → `$CODEX_HOME/config.toml`  (default `~/.codex/config.toml`)
 *   • workspace → `<cwd>/.codex/config.toml`
 *
 * Codex uses TOML, not JSON. We parse only what we need (`[mcp_servers.<name>]`
 * tables: command/args/url/env/enabled) and toggle a server by flipping an
 * `enabled = false` line, preserving everything else in the file.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { detailOf, type McpScope, type McpServer, type McpServerConfig, transportOf } from "./types.js";

const log = createLogger("mcp:config");

/** Resolved CODEX_HOME (holds config.toml). */
function codexHome(): string {
  const env = process.env.CODEX_HOME?.trim();
  return env ? env : join(homedir(), ".codex");
}

/** Absolute path of the global Codex config.toml. */
export function globalMcpPath(): string {
  return join(codexHome(), "config.toml");
}

/** Absolute path of a per-workspace Codex config.toml. */
export function workspaceMcpPath(cwd: string): string {
  return join(cwd, ".codex", "config.toml");
}

function serversFrom(path: string, scope: McpScope): McpServer[] {
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (e) {
    log.warn(`cannot read ${path}: ${(e as Error).message}`);
    return [];
  }
  const parsed = parseMcpServers(text);
  return Object.entries(parsed).map(([name, config]) => ({
    name,
    scope,
    configPath: path,
    disabled: config.disabled === true || config.enabled === false,
    transport: transportOf(config),
    detail: detailOf(config),
    config,
  }));
}

/** List all configured MCP servers (workspace shadows global), sorted by name. */
export function listMcpServers(cwd?: string): McpServer[] {
  const byName = new Map<string, McpServer>();
  for (const s of serversFrom(globalMcpPath(), "global")) byName.set(s.name, s);
  if (cwd) {
    for (const s of serversFrom(workspaceMcpPath(cwd), "workspace")) byName.set(s.name, s);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** Locate a single server by name (workspace shadows global). */
export function findMcpServer(name: string, cwd?: string): McpServer | undefined {
  return listMcpServers(cwd).find((s) => s.name === name);
}

export interface ToggleResult {
  ok: boolean;
  disabled?: boolean;
  error?: string;
}

/**
 * Enable/disable a server by editing its `[mcp_servers.<name>]` table:
 * disabling appends `enabled = false`; enabling removes any `enabled`/`disabled`
 * line. Takes effect when the agent next (re)loads (after `/restart`).
 */
export function setMcpDisabled(server: McpServer, disabled: boolean): ToggleResult {
  let text: string;
  try {
    text = readFileSync(server.configPath, "utf-8");
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const edited = editServerEnabled(text, server.name, disabled);
  if (edited === undefined) {
    return { ok: false, error: `table [mcp_servers.${server.name}] not found in ${server.configPath}` };
  }
  try {
    writeFileSync(server.configPath, edited, "utf-8");
    return { ok: true, disabled };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── minimal TOML reader (mcp_servers tables only) ────────────────────────────

/** Table header like `[mcp_servers.NAME]` or `[mcp_servers.NAME.env]`. */
const TABLE_RE = /^\s*\[\s*mcp_servers\.([^.\]]+(?:\.[^.\]]+)*)\s*\]\s*$/;

/** Parse `[mcp_servers.*]` tables into a name -> config map. */
export function parseMcpServers(text: string): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  let current: string | undefined;
  let sub: string | undefined; // e.g. "env"
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const headerAny = /^\[\s*([^\]]+)\s*\]$/.exec(line);
    const header = TABLE_RE.exec(line);
    if (headerAny && !header) {
      // Any other table ends the current mcp_servers context.
      current = undefined;
      sub = undefined;
      continue;
    }
    if (header) {
      const parts = header[1]!.split(".");
      current = parts[0];
      sub = parts.length > 1 ? parts.slice(1).join(".") : undefined;
      if (current) {
        const cfg = (out[current] ||= {});
        if (sub === "env") cfg.env ||= {};
      }
      continue;
    }
    if (!current) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    const cfg = out[current]!;
    if (sub === "env") {
      (cfg.env ||= {})[stripQuotes(key)] = stripQuotes(parseScalar(value) as string);
      continue;
    }
    assignServerKey(cfg, key, value);
  }
  return out;
}

function assignServerKey(cfg: McpServerConfig, key: string, value: string): void {
  switch (key) {
    case "command":
      cfg.command = stripQuotes(value);
      break;
    case "url":
      cfg.url = stripQuotes(value);
      break;
    case "args":
      cfg.args = parseArray(value);
      break;
    case "enabled":
      cfg.enabled = value === "true";
      break;
    case "disabled":
      cfg.disabled = value === "true";
      break;
    case "env": {
      // inline table: env = { KEY = "v", ... }
      cfg.env = parseInlineTable(value);
      break;
    }
    default:
      break;
  }
}

function parseScalar(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  const n = Number(v);
  if (v !== "" && Number.isFinite(n) && /^-?\d/.test(v)) return n;
  return stripQuotes(v);
}

function stripQuotes(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseArray(v: string): string[] {
  const t = v.trim();
  if (!t.startsWith("[")) return [];
  const inner = t.replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  return splitTopLevel(inner).map((s) => stripQuotes(s.trim())).filter((s) => s.length > 0);
}

function parseInlineTable(v: string): Record<string, string> {
  const out: Record<string, string> = {};
  const t = v.trim().replace(/^\{/, "").replace(/\}$/, "");
  for (const pair of splitTopLevel(t)) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    out[stripQuotes(pair.slice(0, eq).trim())] = stripQuotes(pair.slice(eq + 1).trim());
  }
  return out;
}

/** Split on top-level commas (ignoring commas inside quotes). */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let quote: string | undefined;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = undefined;
      buf += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === ",") {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

/**
 * Toggle `enabled` within a server's TOML table. Returns the new file text, or
 * undefined if the table isn't present. Enabling strips any enabled/disabled
 * line; disabling appends `enabled = false` to the table.
 */
function editServerEnabled(text: string, name: string, disabled: boolean): string | undefined {
  const lines = text.split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = TABLE_RE.exec(lines[i]!.trim());
    if (m && m[1] === name) {
      start = i;
      // find the end of this table (next table header or EOF)
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*\[/.test(lines[j]!)) {
          end = j;
          break;
        }
      }
      break;
    }
  }
  if (start === -1) return undefined;

  // Remove existing enabled/disabled lines in the table.
  const kept: string[] = [];
  for (let i = start; i < end; i++) {
    if (/^\s*(enabled|disabled)\s*=/.test(lines[i]!)) continue;
    kept.push(lines[i]!);
  }
  if (disabled) {
    // Insert after the header line.
    kept.splice(1, 0, "enabled = false");
  }
  return [...lines.slice(0, start), ...kept, ...lines.slice(end)].join("\n");
}
