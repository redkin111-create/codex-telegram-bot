/**
 * Single-instance guard, keyed per bot token (NOT per folder), so the same bot
 * can't run twice no matter which directory it's started from.
 *
 * Telegram allows only ONE long-polling consumer per token — a second instance
 * triggers 409 Conflict and, worse, a leftover "ghost" process started from an
 * old folder keeps answering with a stale `.env`. On startup we take an
 * exclusive lock: if a still-alive **Codex** instance holds it, we terminate
 * that process so the fresh one (with current config) becomes the only consumer.
 *
 * The guard only terminates a process positively identified as this Codex bot;
 * unknown or PID-reused processes are never killed.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { PROJECT_ROOT } from "../config.js";
import { createLogger } from "../logger.js";
import { killPid } from "../sessions/process.js";
import { isPidAlive } from "../sessions/store.js";

const log = createLogger("lock");

interface LockData {
  pid: number;
  startedAt: number;
  /** True when the holder runs under a supervisor (systemd/launchd/Task). */
  supervised: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class InstanceLock {
  private readonly file: string;
  private held = false;

  constructor(
    token: string,
    locksDir: string,
    private readonly supervised: boolean,
  ) {
    const hash = createHash("sha256").update(token).digest("hex").slice(0, 16);
    this.file = join(locksDir, `${hash}.lock`);
  }

  async acquire(): Promise<boolean> {
    // Take over from a previous Codex instance holding our own lock.
    const existing = this.read();
    if (existing && existing.pid !== process.pid && isPidAlive(existing.pid)) {
      if (existing.supervised && !this.supervised) {
        log.warn(`a supervised Codex service instance is already running (pid ${existing.pid}); not starting a duplicate`);
        return false;
      }
      if (isCodexInstance(existing.pid)) {
        log.warn(`another Codex bot instance is running (pid ${existing.pid}); terminating it to take over`);
        killPid(existing.pid);
        for (let i = 0; i < 20 && isPidAlive(existing.pid); i++) await sleep(150); // up to ~3s
        if (isPidAlive(existing.pid)) log.warn(`previous instance ${existing.pid} still alive after kill; continuing anyway`);
      } else {
        // The locked PID was recycled to a non-Codex (or unidentifiable)
        // process — do NOT kill it; just reclaim the stale lock. This is what
        // guarantees we never terminate an unrelated process.
        log.warn(`lock pid ${existing.pid} is not a Codex bot; reclaiming stale lock without killing it`);
      }
    }
    this.write();
    this.held = true;
    return true;
  }

  /** Release the lock if (and only if) we still own it. */
  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      const cur = this.read();
      if (cur?.pid === process.pid) rmSync(this.file, { force: true });
    } catch {
      /* best-effort */
    }
  }

  private write(): void {
    const data: LockData = { pid: process.pid, startedAt: Date.now(), supervised: this.supervised };
    try {
      mkdirSync(join(this.file, ".."), { recursive: true });
      writeFileSync(this.file, JSON.stringify(data), "utf-8");
    } catch (e) {
      log.warn(`could not write lock file ${this.file}: ${(e as Error).message}`);
    }
  }

  private read(): LockData | undefined {
    try {
      const d = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<LockData>;
      if (typeof d.pid === "number" && d.pid > 0) {
        return { pid: d.pid, startedAt: Number(d.startedAt) || 0, supervised: Boolean(d.supervised) };
      }
    } catch {
      /* no/invalid lock */
    }
    return undefined;
  }
}

/**
 * Positively identify a PID as THIS Codex bot before it may be killed. Returns
 * true ONLY when the process's command line clearly belongs to a Codex bot:
 *   • it references this exact install directory (our own ghost), OR
 *   • it looks like a Codex Telegram bot launcher,
 *
 * If the command line can't be read, we return FALSE — we would rather leave a
 * ghost (a harmless 409 the fresh process wins on retry) than risk killing a
 * unrelated process.
 */
function isCodexInstance(pid: number): boolean {
  const cmd = processCommandLine(pid);
  if (!cmd) return false;
  return isCodexCommandLine(cmd, PROJECT_ROOT);
}

/**
 * Pure classifier (exported for tests): is this command line a Codex bot that
 * we may terminate? True only when it references our install or a Codex bot
 * launcher. Empty/unknown ⇒ false (don't kill).
 */
export function isCodexCommandLine(cmd: string, projectRoot: string): boolean {
  if (!cmd) return false;
  const norm = cmd.replace(/\\/g, "/").toLowerCase();
  const root = projectRoot.replace(/\\/g, "/").toLowerCase();
  if (root && norm.includes(root)) return true; // our exact install's ghost
  return /codex[-_ ]?telegram|[/\\]\.codex[/\\]|codex-tg/i.test(cmd);
}

/** Best-effort full command line of a PID (cross-platform), or undefined. */
function processCommandLine(pid: number): string | undefined {
  try {
    if (process.platform === "win32") {
      // CIM gives the full command line (tasklist does not). A single-quoted
      // filter avoids embedded double quotes (which are fragile through argv).
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
        ],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
      );
      const s = out.trim();
      return s || undefined;
    }
    const out = execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    const s = out.trim();
    return s || undefined;
  } catch {
    return undefined;
  }
}
