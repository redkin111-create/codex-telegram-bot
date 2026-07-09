/**
 * Cross-platform launching of the `codex` CLI.
 *
 * On Windows an npm install exposes `codex` as a `.cmd` shim (the native
 * `codex.exe` is buried in a vendor dir), which Node's `spawn` cannot run as a
 * bare name (no PATHEXT) and — since a security fix — refuses to run without a
 * shell. We therefore run shims through a shell. To avoid Node's DEP0190 warning
 * ("passing args with shell:true"), shell invocations pass a single, hand-quoted
 * command string with no args array. A native `.exe`/POSIX binary is spawned
 * directly (no shell) for a clean process tree.
 */
import { type ChildProcessWithoutNullStreams, execFile, spawn, type SpawnOptions } from "node:child_process";
import { promisify } from "node:util";
import { codexLaunch } from "../config.js";
import { shellLine } from "./win-spawn.js";

const pExecFile = promisify(execFile);

/** Build a single shell command line from a (possibly quoted) file + args. */
function commandLine(file: string, args: string[]): string {
  return shellLine(file, args);
}

/**
 * Spawn the codex CLI with pipes, handling the Windows `.cmd` shim case.
 * Returns a ChildProcess with non-null stdio streams.
 */
export function codexSpawn(codexPath: string, args: string[], opts: SpawnOptions = {}): ChildProcessWithoutNullStreams {
  const { file, shell } = codexLaunch(codexPath);
  const base: SpawnOptions = { windowsHide: true, ...opts };
  const proc = shell
    ? spawn(commandLine(file, args), { ...base, shell: true })
    : spawn(file, args, base);
  return proc as ChildProcessWithoutNullStreams;
}

export interface CodexRunResult {
  stdout: string;
  stderr: string;
}

/** Run a short codex command and capture output (login/logout/status). */
export async function codexRun(
  codexPath: string,
  args: string[],
  opts: { timeout?: number } = {},
): Promise<CodexRunResult> {
  const { file, shell } = codexLaunch(codexPath);
  const base = { encoding: "utf-8" as const, windowsHide: true, timeout: opts.timeout };
  const { stdout, stderr } = shell
    ? await pExecFile(commandLine(file, args), { ...base, shell: true })
    : await pExecFile(file, args, base);
  return { stdout: String(stdout), stderr: String(stderr) };
}

/** Describe how codex will be launched (for logging). */
export function codexLaunchInfo(codexPath: string): string {
  const { file, shell } = codexLaunch(codexPath);
  return `${file}${shell ? " (via shell)" : ""}`;
}
