/**
 * Windows service controller — runs the bot at logon. Preferred mechanism is a
 * hidden ONLOGON Scheduled Task, but registering a logon-triggered task needs
 * admin, so from a normal (non-elevated) terminal we fall back to a launcher in
 * the per-user Startup folder — both run a small .vbs that starts node with no
 * console window; the app logs to a file. Stop precisely targets our node
 * process by command line, so it works regardless of how it was launched.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSafe } from "./platform.js";
import { actionFromTaskXml, sameWindowsCheckout, sourceFromTaskAction, staleTargetMessage } from "./windows-target.js";
import type { LaunchSpec, ServiceController, ServiceResult } from "./types.js";

const TASK = "CodexTelegramBot";
/** Launcher dropped in the per-user Startup folder when no admin is available. */
const STARTUP_VBS = "CodexTelegramBot.vbs";

/** The per-user Startup folder (runs at logon for the current user, no admin).
 *  Undefined only if APPDATA is unset (e.g. running with no roaming profile). */
function startupDir(): string | undefined {
  const appData = process.env.APPDATA;
  return appData ? join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup") : undefined;
}

function startupVbsPath(): string | undefined {
  const dir = startupDir();
  return dir ? join(dir, STARTUP_VBS) : undefined;
}

/** Remove a leftover Startup-folder launcher (e.g. from an earlier non-elevated
 *  install) so a task-based install never double-launches the bot at logon. */
function removeStartupLauncher(): void {
  const p = startupVbsPath();
  if (p) rmSync(p, { force: true });
}

/** Canonical launcher in the bot folder (the Scheduled Task points at it). */
function vbsPath(spec: LaunchSpec): string {
  return join(spec.cwd, "run-service.vbs");
}

/** True when our hidden Scheduled Task is registered. */
function taskInstalled(): boolean {
  return runSafe("schtasks", ["/Query", "/TN", TASK]).ok;
}

/** True when a bot process matching this spec is currently running. Launch
 *  paths use this to avoid starting a second instance — two pollers on one
 *  bot token make Telegram return 409 Conflict. */
function isRunning(spec: LaunchSpec): boolean {
  const proc = runSafe("powershell", ["-NoProfile", "-Command", countScript(entryOf(spec))]);
  return proc.ok && /[1-9]\d*/.test(proc.out.trim());
}

export const windowsController: ServiceController = {
  platform: "windows",

  async install(spec) {
    const previousTask = taskSource();
    const previousStartup = startupSource();
    if (previousTask.exists && !previousTask.source) return fail(staleTargetMessage(spec.cwd, undefined));
    if (previousStartup.entry && !previousStartup.source) return fail(staleTargetMessage(spec.cwd, undefined));
    mkdirSync(spec.logsDir, { recursive: true });
    const vbs = vbsPath(spec);
    // Windows Script Host expects a Unicode encoding for paths containing
    // non-ASCII characters (for example, a Cyrillic Windows user name).
    writeFileSync(vbs, `\uFEFF${vbsLauncher(spec)}`, "utf16le");

    // Preferred: a hidden ONLOGON Scheduled Task. Registering a *logon-triggered*
    // task is a privileged operation, so /Create succeeds only from an elevated
    // (admin) terminal. From a normal terminal it returns "Access is denied".
    runSafe("schtasks", ["/Delete", "/F", "/TN", TASK]); // replace if present
    const res = runSafe("schtasks", [
      "/Create",
      "/F",
      "/SC",
      "ONLOGON",
      "/TN",
      TASK,
      "/TR",
      `wscript.exe "${vbs}"`,
    ]);
    if (res.ok) {
      removeStartupLauncher(); // avoid a leftover launcher double-starting the bot
      if (previousTask.exists && !sameWindowsCheckout(spec.cwd, previousTask.source) && previousTask.entry) {
        runSafe("powershell", ["-NoProfile", "-Command", killScript(previousTask.entry)]);
      }
      if (previousStartup.source && !sameWindowsCheckout(spec.cwd, previousStartup.source) && previousStartup.entry) {
        runSafe("powershell", ["-NoProfile", "-Command", killScript(previousStartup.entry)]);
      }
      if (!isRunning(spec)) runSafe("schtasks", ["/Run", "/TN", TASK]);
      return ok(`Installed scheduled task "${TASK}" (starts at logon) and launched it.\nSource: ${spec.cwd}`);
    }

    // A task may still exist that we just couldn't overwrite (e.g. created by an
    // earlier elevated install). Reuse it rather than ALSO adding a Startup
    // launcher, which would double-launch the bot at logon (409 Conflict).
    if (taskInstalled()) {
      const existing = taskSource();
      if (!sameWindowsCheckout(spec.cwd, existing.source)) {
        return fail(staleTargetMessage(spec.cwd, existing.source));
      }
      removeStartupLauncher();
      if (!isRunning(spec)) runSafe("schtasks", ["/Run", "/TN", TASK]);
      return ok(`Scheduled task "${TASK}" already targets this checkout; launched it. (Re-run elevated to recreate it.)\nSource: ${spec.cwd}`);
    }

    // Fallback (no admin — the common case): drop the launcher in the per-user
    // Startup folder. It runs hidden at every logon with no elevation.
    const startupVbs = startupVbsPath();
    const dir = startupDir();
    if (!startupVbs || !dir) {
      return fail(
        `Could not create the logon task (${res.out.trim()}) and no per-user Startup folder is available. ` +
          `Re-run "codex-tg install" from an elevated terminal (Run as administrator).`,
      );
    }
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(startupVbs, `\uFEFF${vbsLauncher(spec)}`, "utf16le");
    } catch (e) {
      return fail(`Startup-folder install failed: ${(e as Error).message}`);
    }
    if (previousStartup.source && !sameWindowsCheckout(spec.cwd, previousStartup.source) && previousStartup.entry) {
      runSafe("powershell", ["-NoProfile", "-Command", killScript(previousStartup.entry)]);
    }
    if (!isRunning(spec)) runSafe("wscript.exe", [startupVbs]); // launch now
    return ok(
      `Installed via the Startup folder — starts hidden at logon, no admin needed — and launched it.\n` +
        `(Tip: run "codex-tg install" from an elevated terminal to use a hidden Scheduled Task instead.)`,
    );
  },

  async uninstall(spec) {
    const task = taskSource();
    const startup = startupSource();
    if (task.exists) {
      runSafe("schtasks", ["/End", "/TN", TASK]);
      if (task.entry) runSafe("powershell", ["-NoProfile", "-Command", killScript(task.entry)]);
    }
    if (startup.entry) runSafe("powershell", ["-NoProfile", "-Command", killScript(startup.entry)]);
    if (!task.exists) await this.stop(spec);
    runSafe("schtasks", ["/Delete", "/F", "/TN", TASK]); // best-effort (may not exist)
    rmSync(vbsPath(spec), { force: true });
    const startupVbs = startupVbsPath();
    if (startupVbs) rmSync(startupVbs, { force: true });
    return ok(`Removed "${TASK}" (scheduled task and/or Startup launcher).`);
  },

  async start(spec) {
    const task = taskSource();
    if (task.exists) {
      if (!sameWindowsCheckout(spec.cwd, task.source)) return fail(staleTargetMessage(spec.cwd, task.source));
      if (isRunning(spec)) return ok(`Already running.\nSource: ${spec.cwd}`);
      const res = runSafe("schtasks", ["/Run", "/TN", TASK]);
      return res.ok ? ok(`Started.\nSource: ${spec.cwd}`) : fail(res.out);
    }
    const startupVbs = startupVbsPath();
    if (startupVbs && existsSync(startupVbs)) {
      const startup = startupSource();
      if (!sameWindowsCheckout(spec.cwd, startup.source)) return fail(staleTargetMessage(spec.cwd, startup.source));
      if (isRunning(spec)) return ok(`Already running.\nSource: ${spec.cwd}`);
      runSafe("wscript.exe", [startupVbs]);
      return ok(`Started.\nSource: ${spec.cwd}`);
    }
    return fail(`Not installed. Run "codex-tg install" first.`);
  },

  async stop(spec) {
    const task = taskSource();
    if (task.exists && !sameWindowsCheckout(spec.cwd, task.source)) return fail(staleTargetMessage(spec.cwd, task.source));
    if (task.exists) runSafe("schtasks", ["/End", "/TN", TASK]); // best-effort if task-based
    const res = runSafe("powershell", ["-NoProfile", "-Command", killScript(entryOf(spec))]);
    return ok(`Stopped. ${res.out.trim()}`);
  },

  async status(spec) {
    const task = taskSource();
    const installedTask = task.exists;
    const startupVbs = startupVbsPath();
    const installedStartup = !!startupVbs && existsSync(startupVbs);
    const installed = installedTask || installedStartup;
    const startup = installedTask ? undefined : installedStartup ? startupSource() : undefined;
    const source = installedTask ? task.source : startup?.source;
    const running = sameWindowsCheckout(spec.cwd, source) && isRunning(spec);
    const how = installedTask ? "scheduled task" : installedStartup ? "Startup folder" : "—";
    const detail = `\nExpected source: ${spec.cwd}\nService source: ${source ?? (installed ? "unknown" : "—")}`;
    const message = `Installed: ${installed ? `yes (${how})` : "no"} | Running: ${running ? "yes" : "no"}${detail}`;
    if (installed && !sameWindowsCheckout(spec.cwd, source)) return fail(`${staleTargetMessage(spec.cwd, source)}\n\n${message}`);
    return ok(message);
  },
};

/** The bot entry file — unique enough to identify the bot process. It may be
 *  followed by trailing args (e.g. `--instance <dir>`), so find it explicitly. */
function entryOf(spec: LaunchSpec): string {
  return (
    spec.args.find((a) => a.endsWith("index.ts")) ?? spec.args[spec.args.length - 1] ?? spec.cwd
  );
}

function taskSource(): { exists: boolean; source?: string; entry?: string } {
  const result = runSafe("schtasks", ["/Query", "/TN", TASK, "/XML"]);
  if (!result.ok) return { exists: taskInstalled() };
  const action = actionFromTaskXml(result.out);
  if (!action) return { exists: true };
  const launcher = /"([^"\r\n]+\.vbs)"|([^\s"]+\.vbs)/i.exec(action.arguments)?.[1]
    ?? /"([^"\r\n]+\.vbs)"|([^\s"]+\.vbs)/i.exec(action.arguments)?.[2];
  const body = launcher ? readText(launcher) : undefined;
  const source = sourceFromTaskAction(action, body);
  return { exists: true, source, entry: source ? join(source, "src", "index.ts") : undefined };
}

function startupSource(): { source?: string; entry?: string } {
  const path = startupVbsPath();
  if (!path || !existsSync(path)) return {};
  const body = readText(path);
  const source = sourceFromTaskAction({ command: "wscript.exe", arguments: `"${path}"` }, body);
  return { source, entry: source ? join(source, "src", "index.ts") : undefined };
}

function readText(path: string): string | undefined {
  try { return readFileSync(path, "utf16le"); } catch { return undefined; }
}

function vbsLauncher(spec: LaunchSpec): string {
  const cmd = `""${spec.nodePath}"" ${spec.args.map((a) => `""${a}""`).join(" ")}`;
  const codexPath = spec.codexCliPath.replace(/"/g, '""');
  return [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Environment("PROCESS")("CODEX_CLI_PATH") = "${codexPath}"`,
    `sh.CurrentDirectory = "${spec.cwd}"`,
    `sh.Run "${cmd}", 0, False`,
  ].join("\r\n");
}

function killScript(entry: string): string {
  const encoded = Buffer.from(entry, "utf8").toString("base64");
  return [
    `$entry = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));`,
    `$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like ('*' + $entry + '*') };`,
    `$p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };`,
    `"killed " + (@($p).Count)`,
  ].join(" ");
}

function countScript(entry: string): string {
  const encoded = Buffer.from(entry, "utf8").toString("base64");
  return `$entry = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like ('*' + $entry + '*') }).Count`;
}

function ok(message: string): ServiceResult {
  return { ok: true, message };
}
function fail(message: string): ServiceResult {
  return { ok: false, message };
}
