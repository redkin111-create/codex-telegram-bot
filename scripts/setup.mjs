#!/usr/bin/env node
/**
 * Easy setup: creates/updates the bot's .env, auto-detects the codex binary
 * and optionally writes the bot token / user id. Project roots stay opt-in:
 * only folders the user explicitly enters in PROJECT_ROOTS are browseable.
 *
 *   node scripts/setup.mjs [--path] [--instance <dir>] [<TELEGRAM_BOT_TOKEN> [ALLOWED_USER_ID]]
 *
 * By default the .env lives in the canonical, path-independent home
 * `~/.codex/tg/.env`, so the bot loads the SAME config no matter where it's
 * started from. A `.env` already present in the current folder (an explicit
 * per-folder checkout) is used instead. `--path` just prints the resolved .env
 * path and exits (nothing is written).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const examplePath = join(root, ".env.example");
const CANONICAL_DIR = join(homedir(), ".codex", "tg");

function expandHome(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/** Mirror of config.ts resolveInstanceDir() so setup writes EXACTLY where the
 *  bot will read from. Keep the two in sync. */
function resolveInstanceDir() {
  const flag = process.argv.indexOf("--instance");
  if (flag !== -1 && process.argv[flag + 1]) return resolve(process.argv[flag + 1]);
  const envDir = (process.env.CODEX_TG_DIR || process.env.CODEX_TG_CWD || "").trim();
  if (envDir) return resolve(expandHome(envDir));
  if (existsSync(join(process.cwd(), ".env"))) return process.cwd();
  return CANONICAL_DIR;
}

// Parse args: flags (--path, --instance <dir>) vs positional token/user.
const argv = process.argv.slice(2);
let pathOnly = false;
const positionals = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--path") pathOnly = true;
  else if (a === "--instance") i++; // value consumed by resolveInstanceDir()
  else positionals.push(a);
}
const [tokenArg, userArg] = positionals;

const instanceDir = resolveInstanceDir();
const envPath = join(instanceDir, ".env");

if (pathOnly) {
  console.log(envPath);
  process.exit(0);
}

mkdirSync(instanceDir, { recursive: true });

function whichCodex() {
  const win = process.platform === "win32";
  try {
    const out = execFileSync(win ? "where" : "which", ["codex"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length === 0) return "";
    if (!win) return lines[0];
    const pick = (re) => lines.find((l) => re.test(l));
    return pick(/\.exe$/i) || pick(/\.cmd$/i) || pick(/\.bat$/i) || lines.find((l) => /\.[a-z0-9]+$/i.test(l)) || "";
  } catch {
    return "";
  }
}

function detectCodex() {
  const onPath = whichCodex();
  if (onPath) return onPath;
  const win = process.platform === "win32";
  const nodeDir = dirname(process.execPath);
  const candidates = win
    ? [
        join(nodeDir, "codex.cmd"),
        join(nodeDir, "codex.exe"),
        join(homedir(), "AppData", "Local", "Programs", "codex", "codex.exe"),
        join(homedir(), ".codex", "bin", "codex.exe"),
      ]
    : [
        join(nodeDir, "codex"),
        join(homedir(), ".local", "bin", "codex"),
        "/usr/local/bin/codex",
        "/opt/homebrew/bin/codex",
      ];
  return candidates.find((p) => existsSync(p)) || "";
}

let env = existsSync(envPath)
  ? readFileSync(envPath, "utf-8")
  : readFileSync(examplePath, "utf-8");

function setVar(key, value) {
  if (value === undefined || value === "") return;
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  env = re.test(env) ? env.replace(re, line) : `${env.trimEnd()}\n${line}\n`;
}

const codex = detectCodex();
if (codex) {
  setVar("CODEX_CLI_PATH", codex);
  console.log(`✓ Found codex: ${codex}`);
} else {
  console.log("! codex not auto-detected — set CODEX_CLI_PATH in .env or ensure it's on PATH.");
}

if (tokenArg) {
  setVar("TELEGRAM_BOT_TOKEN", tokenArg);
  console.log("✓ Wrote TELEGRAM_BOT_TOKEN");
}
if (userArg) {
  setVar("ALLOWED_USERS", userArg);
  console.log(`✓ Wrote ALLOWED_USERS=${userArg}`);
}

writeFileSync(envPath, env, "utf-8");
console.log(`\n✓ .env written to ${envPath}`);
console.log("  (loaded from here no matter which folder you start the bot in)");

if (!/^TELEGRAM_BOT_TOKEN=.+/m.test(env)) {
  console.log("\nNext: open .env and paste your bot token from @BotFather, then run `codex-tg run` (or `npm start`).");
} else {
  console.log("\nReady! Run `codex-tg run` (or `npm start`).");
}
