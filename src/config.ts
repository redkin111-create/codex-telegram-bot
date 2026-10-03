/**
 * Configuration: loads .env, validates required values, resolves paths.
 */
import { config as loadDotenv } from "dotenv";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the installed bot code (one level above src/). For a global
 *  npm install this lives inside node_modules — code lives here, never user data. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Canonical, path-independent home for this bot's `.env`, `logs/`, `data/` and
 *  single-instance locks: `~/.codex/tg`. */
export const CANONICAL_DIR = join(homedir(), ".codex", "tg");

/**
 * Directory holding THIS instance's `.env`, `logs/` and `data/`. Resolution
 * (first match wins):
 *   1. `--instance <dir>` argv — set by the installed background service,
 *   2. `CODEX_TG_DIR` env — an explicit override,
 *   3. `CODEX_TG_CWD` env — the launcher variable,
 *   4. the current folder, IF it already contains a `.env` (an explicit
 *      per-folder bot — keeps cloned/zip checkouts working in place),
 *   5. the canonical `~/.codex/tg` home — the path-independent default, so a
 *      `.env` created once is loaded no matter where the bot is started from.
 *
 * Only the documented `CODEX_TG_*` variables are consulted.
 */
export const INSTANCE_DIR = resolveInstanceDir();

/** Absolute path to the `.env` this instance loads (and that `setup` writes). */
export const ENV_PATH = join(INSTANCE_DIR, ".env");

function resolveInstanceDir(): string {
  const flag = process.argv.indexOf("--instance");
  if (flag !== -1 && process.argv[flag + 1]) return resolve(process.argv[flag + 1]!);
  // Only honour this bot's CODEX_TG_* environment variables.
  const envDir = process.env.CODEX_TG_DIR?.trim() || process.env.CODEX_TG_CWD?.trim();
  if (envDir) return resolve(expandHome(envDir));
  if (existsSync(join(process.cwd(), ".env"))) return process.cwd();
  return CANONICAL_DIR;
}

// Load .env from the resolved instance directory. dotenv does NOT override
// variables already present in the environment (the launcher/service env wins).
loadDotenv({ path: ENV_PATH });

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Like num() but allows 0 (e.g. to disable retries). Rejects negatives. */
function nonNegNum(v: string | undefined, def: number): number {
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function list(v: string | undefined): string[] {
  return (v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface AppConfig {
  token: string;
  allowedUsers: Set<string>;
  codexCliPath: string;
  /** Resolved CODEX_HOME (holds sessions/, auth.json, config.toml). */
  codexHome: string;
  workspace: string;
  agent?: string;
  trustAllTools: boolean;
  projectRoots: string[];
  streamThrottleMs: number;
  /** Debounce window (ms) for coalescing rapid consecutive text messages
   *  (e.g. a long message Telegram split at 4096 chars) into one prompt. */
  messageBatchMs: number;
  showToolCalls: boolean;
  showEditDiffs: boolean;
  diffMaxLines: number;
  sendAgentImages: boolean;
  agentImagesMax: number;
  /** Max characters of a text document inlined into a prompt (0 = unlimited). */
  docMaxChars: number;
  logLevel: string;
  sessionsDir: string;
  projectRoot: string;
  logsDir: string;
  logFile: string;
  acpAutoRestart: boolean;
  dataDir: string;
  promptIdleMs: number;
  quietNotifications: boolean;
  promptRetryAttempts: number;
  /** After transient prompt errors are exhausted, fork the session into a fresh
   *  primed continuation and retry once (recovers throttled/exhausted/stuck
   *  sessions automatically). */
  autoForkOnError: boolean;
  /** When a prompt fails transiently and this session's last-known context
   *  usage is at/above this percentage (0 disables), skip the retry backoff and
   *  auto-fork immediately — a context-exhausted session won't recover by
   *  retrying the same oversized prompt. Requires `autoForkOnError`. */
  autoForkContextPct: number;
  /** When a transient error (throttle / internal error) strikes AFTER the turn
   *  already started streaming — so the pre-stream retry/fork/rotate paths are
   *  skipped to avoid re-running tools — ask the SAME session to CONTINUE from
   *  where it stopped (with backoff), instead of surfacing a hard failure. */
  resumeOnStreamError: boolean;
  sttApiUrl?: string;
  sttApiKey?: string;
  sttModel: string;
  sttLanguage?: string;
  /** Per-server timeout for the /mcp live health probe. */
  mcpProbeTimeoutMs: number;
  /** How many MCP health probes run concurrently. */
  mcpProbeConcurrency: number;
  /** Show subagent (crew) activity while the main agent waits on them. */
  showSubagents: boolean;
  /** Ask the agent to emit a `{progress: N%}` marker and render it as a bar. */
  showProgress: boolean;
  /** When the agent emits no `{progress}` marker, show a bot-computed fallback
   *  bar derived from real activity (tool calls, streamed output, elapsed). */
  progressFallback: boolean;
  /** Deliver a turn's "Done" summary to the chat even when that session is in
   *  the background (you've switched to another session). */
  notifyOtherSessions: boolean;
  /** Check npm hourly and auto-update when idle (announces in chat). */
  autoUpdate: boolean;
  /** How often to check npm for a newer version (ms). */
  updateCheckMs: number;
  /** Enforce a single running instance per bot token: on startup, a still-alive
   *  ghost/duplicate holding the lock is terminated so the fresh process (with
   *  the current `.env`) is the only Telegram getUpdates consumer. */
  singleInstance: boolean;
}

export function loadConfig(): AppConfig {
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is missing. Copy .env.example to .env and set it (run `npm run setup`).",
    );
  }

  const workspaceRaw = process.env.CODEX_WORKSPACE?.trim() || process.cwd();
  const workspace = resolve(expandHome(workspaceRaw));

  // Default project roots: the workspace parent + home directory.
  const roots = list(process.env.PROJECT_ROOTS).map((p) => resolve(expandHome(p)));
  if (roots.length === 0) {
    roots.push(dirname(workspace), homedir());
  }

  const codexHome = process.env.CODEX_HOME?.trim()
    ? resolve(expandHome(process.env.CODEX_HOME.trim()))
    : join(homedir(), ".codex");
  const sessionsDir = join(codexHome, "sessions");
  const logsDir = process.env.LOG_DIR?.trim()
    ? resolve(expandHome(process.env.LOG_DIR.trim()))
    : join(INSTANCE_DIR, "logs");
  const logFile = process.env.LOG_FILE?.trim()
    ? resolve(expandHome(process.env.LOG_FILE.trim()))
    : join(logsDir, "codex-telegram-bot.log");

  const cfg: AppConfig = {
    token,
    allowedUsers: new Set(list(process.env.ALLOWED_USERS)),
    codexCliPath: resolveCodexPath(process.env.CODEX_CLI_PATH?.trim()),
    codexHome,
    workspace,
    agent: process.env.CODEX_AGENT?.trim() || undefined,
    trustAllTools: bool(process.env.CODEX_TRUST_ALL_TOOLS, false),
    projectRoots: [...new Set(roots)],
    streamThrottleMs: num(process.env.STREAM_THROTTLE_MS, 1500),
    messageBatchMs: nonNegNum(process.env.MESSAGE_BATCH_MS, 800),
    showToolCalls: bool(process.env.SHOW_TOOL_CALLS, true),
    showEditDiffs: bool(process.env.SHOW_EDIT_DIFFS, true),
    diffMaxLines: num(process.env.DIFF_MAX_LINES, 120),
    sendAgentImages: bool(process.env.SEND_AGENT_IMAGES, true),
    agentImagesMax: num(process.env.AGENT_IMAGES_MAX, 8),
    docMaxChars: nonNegNum(process.env.DOC_MAX_CHARS, 100_000),
    logLevel: process.env.LOG_LEVEL?.trim() || "info",
    sessionsDir,
    projectRoot: PROJECT_ROOT,
    logsDir,
    logFile,
    acpAutoRestart: bool(process.env.ACP_AUTO_RESTART, true),
    promptIdleMs: num(process.env.PROMPT_IDLE_TIMEOUT_MS, 900_000),
    quietNotifications: bool(process.env.QUIET_NOTIFICATIONS, true),
    promptRetryAttempts: nonNegNum(process.env.PROMPT_RETRY_ATTEMPTS, 5),
    autoForkOnError: bool(process.env.AUTO_FORK_ON_ERROR, true),
    autoForkContextPct: nonNegNum(process.env.AUTO_FORK_CONTEXT_PCT, 85),
    resumeOnStreamError: bool(process.env.RESUME_ON_STREAM_ERROR, true),
    dataDir: process.env.DATA_DIR?.trim()
      ? resolve(expandHome(process.env.DATA_DIR.trim()))
      : join(INSTANCE_DIR, "data"),
    sttApiUrl: process.env.STT_API_URL?.trim() || undefined,
    sttApiKey: process.env.STT_API_KEY?.trim() || undefined,
    sttModel: process.env.STT_MODEL?.trim() || "whisper-1",
    sttLanguage: process.env.STT_LANGUAGE?.trim() || undefined,
    mcpProbeTimeoutMs: num(process.env.MCP_PROBE_TIMEOUT_MS, 8000),
    mcpProbeConcurrency: num(process.env.MCP_PROBE_CONCURRENCY, 6),
    showSubagents: bool(process.env.SHOW_SUBAGENTS, true),
    showProgress: bool(process.env.SHOW_PROGRESS, true),
    progressFallback: bool(process.env.PROGRESS_FALLBACK, true),
    notifyOtherSessions: bool(process.env.NOTIFY_OTHER_SESSIONS, true),
    autoUpdate: bool(process.env.AUTO_UPDATE, true),
    updateCheckMs: num(process.env.UPDATE_CHECK_MS, 3_600_000),
    singleInstance: bool(process.env.CODEX_TG_SINGLE_INSTANCE, true),
  };

  return cfg;
}

/** Resolve the codex binary path across platforms.
 *
 * Order: explicit override → `where`/`which codex` on PATH → common install
 * dirs (incl. the npm-global bin next to node) → bare `codex`. On Windows an
 * npm install exposes a `codex.cmd` shim (the native `codex.exe` is buried in a
 * vendor dir), so a bare `spawn("codex")` fails with ENOENT — resolving the
 * real path here (and launching via a shell, see {@link codexLaunch}) fixes it. */
function resolveCodexPath(explicit?: string): string {
  if (explicit) return expandHome(explicit);

  const onPath = whichCodex();
  if (onPath) return onPath;

  const win = process.platform === "win32";
  const nodeDir = dirname(process.execPath); // nvm/npm often place shims next to node
  const appData = process.env.APPDATA;
  const candidates = win
    ? [
        join(nodeDir, "codex.cmd"),
        join(nodeDir, "codex.exe"),
        join(nodeDir, "codex"),
        ...(appData ? [join(appData, "npm", "codex.cmd"), join(appData, "npm", "codex.exe")] : []),
        join(homedir(), "AppData", "Local", "Programs", "codex", "codex.exe"),
        join(homedir(), ".codex", "bin", "codex.exe"),
      ]
    : [
        join(nodeDir, "codex"),
        join(homedir(), ".local", "bin", "codex"),
        join(homedir(), ".npm-global", "bin", "codex"),
        "/usr/local/bin/codex",
        "/opt/homebrew/bin/codex",
        "/usr/bin/codex",
      ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "codex"; // last resort — PATH lookup at spawn time
}

/** Locate `codex` on PATH via the OS resolver (respects Windows PATHEXT). */
function whichCodex(): string | undefined {
  const win = process.platform === "win32";
  const finder = win ? "where" : "which";
  try {
    const out = execFileSync(finder, ["codex"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length === 0) return undefined;
    if (!win) return lines[0];
    // On Windows prefer a directly-runnable file. `where` also lists the
    // extensionless `codex` sh-shim, which cmd.exe CANNOT execute — never pick
    // it. Order: native .exe → .cmd → .bat (all runnable via cmd).
    const pick = (re: RegExp): string | undefined => lines.find((l) => re.test(l));
    return pick(/\.exe$/i) || pick(/\.cmd$/i) || pick(/\.bat$/i) || lines.find((l) => /\.[a-z0-9]+$/i.test(l));
  } catch {
    return undefined; // not found / resolver unavailable
  }
}

/**
 * How to launch the resolved codex binary on this platform. On Windows a
 * `.cmd`/`.bat`/`.ps1` shim (or a bare name) must be run through a shell so
 * `cmd.exe` applies PATHEXT and executes the batch shim; a native `.exe` (or any
 * POSIX binary) is spawned directly for a clean process tree. When a shell is
 * used, a path containing spaces is quoted.
 */
export function codexLaunch(codexPath: string): { file: string; shell: boolean } {
  const shell = process.platform === "win32" && !/\.exe$/i.test(codexPath);
  const file = shell && /\s/.test(codexPath) && !codexPath.startsWith('"') ? `"${codexPath}"` : codexPath;
  return { file, shell };
}

export function isAbsolutePath(p: string): boolean {
  return isAbsolute(p);
}
