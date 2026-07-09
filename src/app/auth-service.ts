/**
 * Codex authentication control for /reauth and /accounts.
 *
 * Codex signs in two ways, both far simpler than Kiro's AWS SSO device flow:
 *   • ChatGPT  — `codex login` starts a local callback server and prints a URL
 *                to approve in a browser; we stream that URL to Telegram.
 *   • API key  — `codex login --api-key <key>` (non-interactive).
 * Credentials land in `$CODEX_HOME/auth.json`, which we can also snapshot/import.
 */
import { rm } from "node:fs/promises";
import { createLogger } from "../logger.js";
import { codexLaunchInfo, codexRun, codexSpawn } from "./codex-cli.js";
import { codexAuthPath, findImportableAuth, installAuth } from "./codex-credentials.js";

const log = createLogger("auth");

// Strip ANSI colour/cursor escapes so the Telegram transcript stays readable.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export interface LoginResult {
  ok: boolean;
  code: number | null;
  cancelled?: boolean;
  error?: string;
}

export interface LoginOptions {
  /** Extra CLI flags appended to `codex login`. */
  extraArgs?: string[];
  onOutput: (text: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class AuthService {
  constructor(private readonly codexCliPath: string) {}

  /** Run `codex logout` (non-interactive). */
  async logout(): Promise<{ ok: boolean; out: string }> {
    try {
      const { stdout, stderr } = await codexRun(this.codexCliPath, ["logout"], { timeout: 30_000 });
      return { ok: true, out: clean(`${stdout}${stderr}`) };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      const out = clean(`${err.stdout ?? ""}${err.stderr ?? ""}`) || err.message || "logout failed";
      return { ok: false, out };
    }
  }

  /** Best-effort removal of the cached `auth.json` so the next login is fresh. */
  async clearAuth(): Promise<boolean> {
    try {
      await rm(codexAuthPath(), { force: true });
      log.info(`cleared cached auth (${codexAuthPath()})`);
      return true;
    } catch (e) {
      log.debug("clearAuth failed:", (e as Error).message);
      return false;
    }
  }

  /** Import an existing Codex login already on this machine (auth.json). */
  async importExisting(): Promise<{ ok: boolean; error?: string }> {
    const found = await findImportableAuth();
    if (!found) {
      return {
        ok: false,
        error:
          "No Codex login found on this PC. Run `codex login` in a terminal on the machine hosting the bot first, then try Import again.",
      };
    }
    try {
      await installAuth(found.path);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** Sign in with an OpenAI API key (non-interactive). */
  async loginApiKey(key: string): Promise<LoginResult> {
    try {
      const { stdout, stderr } = await codexRun(this.codexCliPath, ["login", "--api-key", key], { timeout: 60_000 });
      log.info("api-key login: " + clean(`${stdout}${stderr}`).slice(0, 120));
      return { ok: true, code: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string; code?: number };
      const out = clean(`${err.stdout ?? ""}${err.stderr ?? ""}`) || err.message || "login failed";
      return { ok: false, code: err.code ?? null, error: out };
    }
  }

  /**
   * ChatGPT login via `codex login`. Streams the verification URL to `onOutput`
   * as it appears, resolving when the process exits, times out, or is aborted.
   */
  login(opts: LoginOptions): Promise<LoginResult> {
    const { extraArgs = [], onOutput, timeoutMs = 300_000, signal } = opts;
    return new Promise<LoginResult>((resolve) => {
      if (signal?.aborted) {
        resolve({ ok: false, code: null, cancelled: true });
        return;
      }
      const args = ["login", ...extraArgs];
      log.info(`spawning login: ${codexLaunchInfo(this.codexCliPath)} ${args.join(" ")}`);

      let proc;
      try {
        proc = codexSpawn(this.codexCliPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        onOutput(`error: ${(e as Error).message}`);
        resolve({ ok: false, code: null });
        return;
      }

      let cancelled = false;
      let settled = false;
      let hardKill: NodeJS.Timeout | undefined;

      const onAbort = (): void => {
        cancelled = true;
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        hardKill = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 2000);
      };

      const finish = (r: LoginResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (hardKill) clearTimeout(hardKill);
        signal?.removeEventListener("abort", onAbort);
        resolve(r);
      };

      const feed = (b: Buffer): void => {
        const t = clean(b.toString("utf-8"));
        if (t) onOutput(t);
      };
      proc.stdout.on("data", feed);
      proc.stderr.on("data", feed);

      const timer = setTimeout(() => {
        onOutput("\n\u23F1\uFE0F Timed out waiting for login to complete.");
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }, timeoutMs);

      signal?.addEventListener("abort", onAbort, { once: true });

      proc.on("error", (e: Error) => {
        onOutput(`error: ${e.message}`);
        finish({ ok: false, code: null, cancelled });
      });
      proc.on("exit", (code: number | null) => {
        finish({ ok: code === 0 && !cancelled, code, cancelled });
      });
    });
  }
}

function clean(s: string): string {
  return s.replace(ANSI_RE, "").replace(/\r/g, "");
}
