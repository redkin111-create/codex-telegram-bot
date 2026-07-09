/**
 * Codex exec/patch approval decisions. Codex sends server→client requests
 * (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`)
 * when a turn runs with an approval policy other than "never". We translate the
 * request into the bot's internal permission prompt (or auto-accept in
 * trust-all mode) and map the choice back to a Codex decision string.
 */
import type { PermissionOutcome, RequestPermissionParams } from "./types.js";

export type PermissionHandler = (params: RequestPermissionParams) => Promise<PermissionOutcome>;

/** Decide a Codex approval → "accept" | "acceptForSession" | "decline" | "cancel". */
export async function decideApproval(
  method: string,
  params: Record<string, unknown>,
  trustAllTools: boolean,
  handler: PermissionHandler | undefined,
): Promise<string> {
  if (trustAllTools || !handler) {
    return trustAllTools ? "accept" : "decline";
  }
  const isFile = method.includes("fileChange");
  const cmd = Array.isArray(params.command) ? (params.command as string[]).join(" ") : String(params.command ?? "");
  const req: RequestPermissionParams = {
    sessionId: String(params.threadId ?? ""),
    toolCall: {
      toolCallId: String(params.itemId ?? ""),
      title: isFile ? fileChangeTitle(params) : cmd || "command",
      kind: isFile ? "edit" : "execute",
      rawInput: isFile ? { path: firstChangePath(params) } : { command: cmd, cwd: params.cwd },
    },
    options: [
      { optionId: "accept", name: "Approve", kind: "allow_once" },
      { optionId: "acceptForSession", name: "Approve always", kind: "allow_always" },
      { optionId: "decline", name: "Deny", kind: "reject_once" },
    ],
  };
  try {
    const outcome = await handler(req);
    return outcome.outcome.outcome === "selected" ? outcome.outcome.optionId : "cancel";
  } catch {
    return "decline";
  }
}

function firstChangePath(params: Record<string, unknown>): string {
  const changes = params.changes as Array<{ path?: string }> | undefined;
  return Array.isArray(changes) && changes[0]?.path ? String(changes[0].path) : "";
}

function fileChangeTitle(params: Record<string, unknown>): string {
  const changes = params.changes as Array<{ path?: string }> | undefined;
  if (!Array.isArray(changes) || changes.length === 0) return "file change";
  if (changes.length === 1) return `Edit ${changes[0]?.path ?? "file"}`;
  return `Edit ${changes.length} files`;
}
