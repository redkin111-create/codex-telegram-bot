/**
 * Codex exec/patch approval decisions. Codex sends server→client requests
 * (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`)
 * when a turn runs with an approval policy other than "never". We translate the
 * request into the bot's internal permission prompt (or auto-accept in
 * trust-all mode) and map the choice back to a Codex decision string.
 */
import type { PermissionOutcome, RequestPermissionParams } from "./types.js";

export type PermissionHandler = (params: RequestPermissionParams) => Promise<PermissionOutcome>;

export interface PermissionsRequestApprovalResponse {
  permissions: Record<string, unknown>;
  scope: "turn" | "session";
  strictAutoReview: false;
}

/** Resolve Codex's separate filesystem/network permission approval request. */
export async function decidePermissionsApproval(
  params: Record<string, unknown>,
  trustAllTools: boolean,
  handler: PermissionHandler | undefined,
): Promise<PermissionsRequestApprovalResponse> {
  const requested = asRecord(params.permissions);
  if (trustAllTools && requested) return grantPermissions(requested);
  if (!requested || !handler || !describeRequestedPermissions(requested)) return denyPermissions();

  const fileSystem = asRecord(requested.fileSystem ?? requested.file_system);
  const writes = Boolean(fileSystem?.write) || hasWriteEntry(fileSystem?.entries);
  const network = asRecord(requested.network)?.enabled === true;
  const options = [
    { optionId: "grant", name: "Разрешить один раз", kind: "allow_once" },
    { optionId: "deny", name: "Отклонить", kind: "reject_once" },
  ];
  try {
    const outcome = await handler({
      sessionId: String(params.threadId ?? ""),
      toolCall: {
        toolCallId: String(params.itemId ?? ""),
        title: "Дополнительный доступ",
        kind: fileSystem ? (writes ? "edit" : "read") : network ? "fetch" : "other",
      },
      options,
      mobileOptions: [{ optionId: "codex-mobile-permissions-session-allow", name: "Разрешить для сеанса" }],
      permissions: requested,
      reason: typeof params.reason === "string" ? params.reason : undefined,
      cwd: typeof params.cwd === "string" ? params.cwd : undefined,
    });
    if (outcome.outcome.outcome !== "selected") return denyPermissions();
    if (outcome.outcome.optionId === "grant") return grantPermissions(requested);
    if (outcome.outcome.optionId === "codex-mobile-permissions-session-allow") {
      return grantPermissions(requested, "session");
    }
    return denyPermissions();
  } catch {
    return denyPermissions();
  }
}

/** Human-readable scope; return undefined for malformed or unrecognised grants. */
export function describeRequestedPermissions(value: unknown): string[] | undefined {
  const profile = asRecord(value);
  if (!profile) return undefined;
  const lines: string[] = [];
  const network = asRecord(profile.network);
  if (network?.enabled === true) lines.push("Доступ к интернету");
  else if (network && network.enabled !== false && network.enabled !== undefined) return undefined;

  const fileSystem = asRecord(profile.fileSystem ?? profile.file_system);
  if (fileSystem) {
    for (const [key, label] of [["read", "Чтение"], ["write", "Изменение"]] as const) {
      const paths = fileSystem[key];
      if (paths === undefined || paths === null) continue;
      if (!Array.isArray(paths)) return undefined;
      for (const path of paths) {
        const display = displayPermissionPath(path);
        if (!display) return undefined;
        lines.push(`${label}: ${display}`);
      }
    }
    if (fileSystem.entries !== undefined && fileSystem.entries !== null) {
      if (!Array.isArray(fileSystem.entries)) return undefined;
      for (const item of fileSystem.entries) {
        const entry = asRecord(item);
        const access = entry?.access;
        const path = entry && displayPermissionPath(entry.path);
        if (!path || (access !== "read" && access !== "write")) return undefined;
        lines.push(`${access === "write" ? "Изменение" : "Чтение"}: ${path}`);
      }
    }
  }
  return lines.length ? [...new Set(lines)] : undefined;
}

function displayPermissionPath(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  const path = asRecord(value);
  if (!path) return undefined;
  if (path.type === "path" && typeof path.path === "string") return path.path;
  if (path.type === "special") {
    const special = asRecord(path.value);
    if (special?.kind === "project_roots") {
      const subpath = typeof special.subpath === "string" ? special.subpath.replace(/^[/\\]+/, "") : "";
      return subpath ? `папка проекта\\${subpath}` : "папка проекта";
    }
  }
  return undefined;
}

function hasWriteEntry(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry) => asRecord(entry)?.access === "write");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function grantPermissions(
  permissions: Record<string, unknown>,
  scope: PermissionsRequestApprovalResponse["scope"] = "turn",
): PermissionsRequestApprovalResponse {
  return { permissions, scope, strictAutoReview: false };
}

function denyPermissions(): PermissionsRequestApprovalResponse {
  return { permissions: {}, scope: "turn", strictAutoReview: false };
}

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
  const mobileOptions = canOfferSessionScopedChoice(method, params)
    ? [{ optionId: "codex-mobile-session-allow", name: "Разрешить для сеанса" }]
    : undefined;
  const req: RequestPermissionParams = {
    sessionId: String(params.threadId ?? ""),
    toolCall: {
      toolCallId: String(params.itemId ?? ""),
      title: isFile ? fileChangeTitle(params) : cmd || "command",
      kind: isFile ? "edit" : "execute",
      rawInput: isFile ? { path: firstChangePath(params) } : { command: cmd, cwd: params.cwd },
    },
    options: [
      { optionId: "accept", name: "Allow once", kind: "allow_once" },
      { optionId: "decline", name: "Deny", kind: "reject_once" },
    ],
    ...(mobileOptions ? { mobileOptions } : {}),
  };
  try {
    const outcome = await handler(req);
    if (outcome.outcome.outcome !== "selected") return "cancel";
    return outcome.outcome.optionId === "codex-mobile-session-allow" ? "acceptForSession" : outcome.outcome.optionId;
  } catch {
    return "decline";
  }
}

function canOfferSessionScopedChoice(method: string, params: Record<string, unknown>): boolean {
  const available = params.availableDecisions;
  if (Array.isArray(available)) return available.some((decision) => decision === "acceptForSession");
  if (available !== undefined && available !== null) return false;
  if (method.includes("fileChange")) return typeof params.grantRoot === "string" && params.grantRoot.trim().length > 0;
  return method.includes("commandExecution") && asRecord(params.networkApprovalContext) !== undefined;
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
