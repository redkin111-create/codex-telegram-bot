/**
 * Cross-platform helpers for spawning CLIs that may be Windows shims.
 *
 * On Windows, npm-installed CLIs (`codex`, `npx`, most MCP servers) are `.cmd`
 * batch shims. Node's `spawn` cannot run a bare name (no PATHEXT) and — since a
 * security fix — refuses to run a `.cmd`/`.bat` without a shell. So such
 * commands must run through a shell. To avoid Node's DEP0190 warning ("passing
 * args with shell:true"), callers should pass a single, hand-quoted command
 * line (built via {@link shellLine}) with NO args array. A native `.exe` (or any
 * POSIX binary) is spawned directly.
 */

/** True when `command` must be run through a shell on this platform. */
export function needsShell(command: string): boolean {
  return process.platform === "win32" && !/\.exe$/i.test(command);
}

/** Quote a single argument for a shell command line when it needs it. */
export function quoteArg(a: string): string {
  if (a === "") return '""';
  return /[\s"&|<>^()%]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

/** Build a single shell command line from a command + args (each quoted). */
export function shellLine(command: string, args: string[]): string {
  return [command, ...args.map(quoteArg)].join(" ");
}
