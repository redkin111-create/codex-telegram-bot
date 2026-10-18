/**
 * Codex exec/patch approval decisions. Codex sends server→client requests
 * (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`)
 * when a turn runs with an approval policy other than "never". We translate the
 * request into the bot's internal permission prompt (or auto-accept in
 * trust-all mode) and map the choice back to a Codex decision string.
 */
import type { PermissionOutcome, RequestPermissionParams } from "./types.js";

export type PermissionHandler = (params: RequestPermissionParams) => Promise<PermissionOutcome>;
export type CodexApprovalDecision = string
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: { host: string; action: "allow" | "deny" } } };

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

/** Decide a Codex approval, preserving structured choices advertised by app-server. */
export async function decideApproval(
  method: string,
  params: Record<string, unknown>,
  trustAllTools: boolean,
  handler: PermissionHandler | undefined,
): Promise<CodexApprovalDecision> {
  if (trustAllTools || !handler) {
    return trustAllTools ? "accept" : "decline";
  }
  const isFile = method.includes("fileChange");
  const cmd = Array.isArray(params.command) ? (params.command as string[]).join(" ") : String(params.command ?? "");
  const mobileChoices = advertisedMobileChoices(params.availableDecisions, method);
  const mobileOptions = !mobileChoices && canOfferSessionScopedChoice(method, params)
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
    ...(mobileChoices ? {
      mobileChoices: mobileChoices.choices,
      ...(mobileChoices.summary ? { mobileSummary: mobileChoices.summary } : {}),
    } : {}),
    ...(mobileOptions ? { mobileOptions } : {}),
  };
  try {
    const outcome = await handler(req);
    if (outcome.outcome.outcome !== "selected") return "cancel";
    if (mobileChoices) return mobileChoices.decisions.get(outcome.outcome.optionId) ?? "cancel";
    return outcome.outcome.optionId === "codex-mobile-session-allow" ? "acceptForSession" : outcome.outcome.optionId;
  } catch {
    return mobileChoices ? (mobileChoices.decisions.has("decline") ? "decline" : "cancel") : "decline";
  }
}

function advertisedMobileChoices(
  raw: unknown,
  method: string,
): { choices: NonNullable<RequestPermissionParams["mobileChoices"]>; decisions: Map<string, CodexApprovalDecision>; summary?: string } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length > 32) return { choices: [], decisions: new Map() };
  const choices: NonNullable<RequestPermissionParams["mobileChoices"]> = [];
  const decisions = new Map<string, CodexApprovalDecision>();
  const summary: string[] = [];
  const add = (optionId: string, name: string, decision: CodexApprovalDecision, kind?: string) => {
    if (decisions.has(optionId)) return;
    decisions.set(optionId, decision);
    choices.push({ optionId, name, ...(kind ? { kind } : {}) });
  };

  raw.forEach((value, index) => {
    if (typeof value === "string") {
      switch (value) {
        case "accept": add("accept", "Разрешить один раз", value, "allow_once"); break;
        case "acceptForSession": add("codex-mobile-session-allow", "Разрешить для сеанса", value, "allow_session"); break;
        case "decline": add("decline", "Отклонить действие", value, "reject_once"); break;
        case "cancel": add("cancel", "Отменить текущий ход", value, "cancel"); break;
      }
      return;
    }
    if (!method.includes("commandExecution")) return;
    const wrapper = asRecord(value);
    if (!wrapper || Object.keys(wrapper).length !== 1) return;
    const execChoice = asRecord(wrapper.acceptWithExecpolicyAmendment);
    if (execChoice && Object.keys(wrapper)[0] === "acceptWithExecpolicyAmendment" &&
        Object.keys(execChoice).length === 1 && Array.isArray(execChoice.execpolicy_amendment) &&
        execChoice.execpolicy_amendment.length > 0 && execChoice.execpolicy_amendment.length <= 32 &&
        execChoice.execpolicy_amendment.every((part) => typeof part === "string" && part.length > 0 && part.length <= 200)) {
      const command = execChoice.execpolicy_amendment as string[];
      const optionId = `codex-mobile-decision-${index}`;
      add(optionId, "Разрешить и сохранить правило команды", value as CodexApprovalDecision, "allow_rule");
      summary.push(`Правило команды: ${JSON.stringify(command).slice(0, 700)}`);
      return;
    }
    const networkChoice = asRecord(wrapper.applyNetworkPolicyAmendment);
    const amendment = asRecord(networkChoice?.network_policy_amendment);
    if (networkChoice && Object.keys(wrapper)[0] === "applyNetworkPolicyAmendment" &&
        Object.keys(networkChoice).length === 1 && amendment && Object.keys(amendment).length === 2 &&
        typeof amendment.host === "string" && isPolicyHost(amendment.host) &&
        (amendment.action === "allow" || amendment.action === "deny")) {
      const optionId = `codex-mobile-decision-${index}`;
      const name = amendment.action === "allow" ? "Разрешить хост и сохранить правило" : "Запретить хост и сохранить правило";
      add(optionId, name, value as CodexApprovalDecision, amendment.action === "deny" ? "reject_rule" : "allow_rule");
      summary.push(`Сетевое правило для ${amendment.host}: ${amendment.action === "allow" ? "разрешить" : "запретить"}`);
    }
  });
  return { choices, decisions, ...(summary.length ? { summary: summary.join("\n").slice(0, 1000) } : {}) };
}

function isPolicyHost(host: string): boolean {
  if (host.length > 253) return false;
  return host.split(".").every((label) =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );
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
