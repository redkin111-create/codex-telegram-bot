import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const MAX_OUTPUT_CHARS = 64 * 1024;

export interface MobileTerminalResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  timedOut: boolean;
}

function windowsPowerShellScript(command: string): string {
  return [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [Console]::OutputEncoding",
    "$global:LASTEXITCODE = 0",
    "$__codexMobileErrorCount = $Error.Count",
    "& {",
    command,
    "}",
    "$__codexMobileCmdletFailed = $Error.Count -gt $__codexMobileErrorCount",
    "if ($__codexMobileCmdletFailed) {",
    "  if ($global:LASTEXITCODE -eq 0) { exit 1 }",
    "}",
    "exit $global:LASTEXITCODE",
  ].join("\n");
}

function trimOutput(value: string): string {
  return value.length > MAX_OUTPUT_CHARS
    ? value.slice(0, MAX_OUTPUT_CHARS) + "\n[Вывод сокращён]"
    : value;
}

export async function runMobileTerminalCommand(cwd: string, command: string): Promise<MobileTerminalResult> {
  const started = Date.now();
  const windows = process.platform === "win32";
  const executable = windows ? "powershell.exe" : "/bin/sh";
  const args = windows
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsPowerShellScript(command)]
    : ["-c", command];
  try {
    const result = await execFile(executable, args, {
      cwd,
      timeout: 60_000,
      maxBuffer: 256 * 1024,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const stdout = String(result.stdout);
    const stderr = String(result.stderr);
    return {
      exitCode: 0,
      stdout: trimOutput(stdout),
      stderr: trimOutput(stderr),
      truncated: stdout.length > MAX_OUTPUT_CHARS || stderr.length > MAX_OUTPUT_CHARS,
      durationMs: Date.now() - started,
      timedOut: false,
    };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer };
    const stdout = String(failure.stdout ?? "");
    const stderr = String(failure.stderr ?? "");
    return {
      exitCode: typeof failure.code === "number" ? failure.code : null,
      stdout: trimOutput(stdout),
      stderr: trimOutput(stderr),
      truncated: stdout.length > MAX_OUTPUT_CHARS || stderr.length > MAX_OUTPUT_CHARS,
      durationMs: Date.now() - started,
      timedOut: failure.code === "ETIMEDOUT",
    };
  }
}
