import { randomUUID } from "node:crypto";
import type { PermissionOutcome, RequestPermissionParams } from "../acp/types.js";
import { describeRequestedPermissions, type PermissionHandler } from "../acp/approvals.js";
import type { RuntimeRegistry } from "../bot/registry.js";
import type { LiveElicitation, LiveElicitationField, TmaLiveFeed } from "../tma/live.js";

interface PendingApproval {
  id: string;
  ownerId: number;
  sessionId: string;
  params: RequestPermissionParams;
  timer: NodeJS.Timeout;
  resolve: (outcome: PermissionOutcome) => void;
  view: { id: string; title: string; kind: string; summary?: string; options: Array<{ id: string; label: string }> };
}

const cancelled: PermissionOutcome = { outcome: { outcome: "cancelled" } };

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max).trim() : "";
}

/** Route one Codex permission request to the active phone for that session.
 * If no phone is watching, keep the project's existing Telegram approval path. */
export class MobileApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly feed: TmaLiveFeed,
    private readonly registry: RuntimeRegistry,
    private readonly allowedOwners: ReadonlySet<string>,
    private readonly fallback?: PermissionHandler,
    private readonly timeoutMs = 45_000,
  ) {}

  handle = async (params: RequestPermissionParams): Promise<PermissionOutcome> => {
    const ownerId = this.registry.ownerChatForSession(params.sessionId);
    if (ownerId === undefined || !this.allowedOwners.has(String(ownerId)) || !this.feed.hasSubscribers(params.sessionId)) {
      return this.fallback ? this.fallback(params) : cancelled;
    }
    const choices = [...params.options];
    const rejectIndex = choices.findIndex((option) =>
      /reject|deny|no|cancel|отклон|запрет/i.test(`${option.optionId} ${option.name} ${option.kind ?? ""}`),
    );
    choices.splice(rejectIndex < 0 ? choices.length : rejectIndex, 0, ...(params.mobileOptions ?? []));
    const options = choices.filter((option) =>
      typeof option.optionId === "string" && option.optionId.length <= 100 &&
      typeof option.name === "string" && option.name.length <= 160,
    ).map((option) => ({ id: option.optionId, label: clean(option.name, 160) }));
    if (!options.length) return this.fallback ? this.fallback(params) : cancelled;
    const details = params.permissions ? describeRequestedPermissions(params.permissions) : undefined;
    const summary = [clean(params.reason, 600), ...(details ?? [])].filter(Boolean).join("\n").slice(0, 1200) || undefined;
    const id = randomUUID();
    const view = {
      id,
      title: clean(params.toolCall?.title, 600) || "Codex запрашивает разрешение",
      kind: clean(params.toolCall?.kind, 40) || "other",
      summary,
      options,
    };
    return new Promise<PermissionOutcome>((resolve) => {
      const timer = setTimeout(() => { void this.expire(id); }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, { id, ownerId, sessionId: params.sessionId, params, timer, resolve, view });
      this.feed.status(params.sessionId, "approval", "Ожидается подтверждение на телефоне");
      this.feed.publish(params.sessionId, { kind: "approval", approval: view, label: "Требуется подтверждение" });
    });
  };

  listFor(ownerId: number, sessionId: string) {
    return [...this.pending.values()]
      .filter((item) => item.ownerId === ownerId && item.sessionId === sessionId)
      .map((item) => item.view);
  }

  resolve(ownerId: number, sessionId: string, id: string, optionId: string): boolean {
    const item = this.pending.get(id);
    if (!item || item.ownerId !== ownerId || item.sessionId !== sessionId ||
        !item.view.options.some((option) => option.id === optionId)) return false;
    this.pending.delete(id);
    clearTimeout(item.timer);
    item.resolve({ outcome: { outcome: "selected", optionId } });
    this.feed.status(sessionId, "working", "Codex продолжает выполнение");
    return true;
  }

  private async expire(id: string): Promise<void> {
    const item = this.pending.get(id);
    if (!item) return;
    this.pending.delete(id);
    this.feed.status(item.sessionId, "approval", "Подтверждение телефона истекло");
    if (!this.fallback) { item.resolve(cancelled); return; }
    try { item.resolve(await this.fallback(item.params)); }
    catch { item.resolve(cancelled); }
    finally { this.feed.status(item.sessionId, "working", "Codex продолжает выполнение"); }
  }
}

export interface McpElicitationResult {
  action: "accept" | "decline" | "cancel";
  content: Record<string, unknown> | null;
}

interface PendingElicitation {
  id: string;
  ownerId: number;
  sessionId: string;
  view: LiveElicitation;
  timer: NodeJS.Timeout;
  resolve: (result: McpElicitationResult) => void;
}

const cancelledElicitation: McpElicitationResult = { action: "cancel", content: null };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max).trim()
    : undefined;
}

function finiteInteger(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
}

function formFields(value: unknown): LiveElicitationField[] | undefined {
  const schema = record(value);
  const properties = record(schema?.properties);
  if (!schema || schema.type !== "object" || !properties ||
      Object.keys(schema).some((key) => !["type", "properties", "required", "additionalProperties", "title", "description"].includes(key)) ||
      schema.additionalProperties !== undefined && schema.additionalProperties !== false) return undefined;
  const entries = Object.entries(properties);
  if (entries.length === 0 || entries.length > 12) return undefined;
  const rawRequired = schema.required ?? [];
  if (!Array.isArray(rawRequired) || rawRequired.length > entries.length ||
      rawRequired.some((name) => typeof name !== "string" || !Object.hasOwn(properties, name))) return undefined;
  const required = new Set(rawRequired as string[]);
  const fields: LiveElicitationField[] = [];
  for (const [name, rawField] of entries) {
    const field = record(rawField);
    const type = field?.type;
    if (!field || Object.keys(field).some((key) => !["type", "title", "description", "minLength", "maxLength", "minimum", "maximum", "enum", "format"].includes(key)) ||
        field.format !== undefined && field.format !== "password" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) ||
        (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean")) return undefined;
    const minLength = field.minLength === undefined ? undefined : finiteInteger(field.minLength, 2000);
    const maxLength = field.maxLength === undefined ? 1000 : finiteInteger(field.maxLength, 2000);
    const minimum = field.minimum === undefined ? undefined : field.minimum;
    const maximum = field.maximum === undefined ? undefined : field.maximum;
    if ((field.minLength !== undefined && minLength === undefined) ||
        (field.maxLength !== undefined && maxLength === undefined) ||
        minLength !== undefined && maxLength !== undefined && minLength > maxLength ||
        type !== "string" && (field.minLength !== undefined || field.maxLength !== undefined) ||
        type !== "number" && type !== "integer" && (minimum !== undefined || maximum !== undefined) ||
        minimum !== undefined && (typeof minimum !== "number" || !Number.isFinite(minimum)) ||
        maximum !== undefined && (typeof maximum !== "number" || !Number.isFinite(maximum)) ||
        typeof minimum === "number" && typeof maximum === "number" && minimum > maximum) return undefined;
    let options: string[] | undefined;
    if (field.enum !== undefined) {
      if (type !== "string" || !Array.isArray(field.enum) || field.enum.length === 0 || field.enum.length > 40 ||
          field.enum.some((option) => typeof option !== "string" || !option.trim() || option.length > 160)) return undefined;
      options = [...new Set(field.enum as string[])];
      if (options.length !== field.enum.length) return undefined;
    }
    fields.push({
      name,
      label: boundedText(field.title, 120) || name,
      type,
      required: required.has(name),
      ...(boundedText(field.description, 300) ? { description: boundedText(field.description, 300) } : {}),
      ...(options ? { options } : {}),
      ...(field.format === "password" ? { secret: true } : {}),
      ...(minLength !== undefined ? { minLength } : {}),
      ...(maxLength !== undefined ? { maxLength } : {}),
      ...(typeof minimum === "number" ? { minimum } : {}),
      ...(typeof maximum === "number" ? { maximum } : {}),
    });
  }
  return fields;
}

function safeElicitation(value: unknown): Omit<LiveElicitation, "id"> | undefined {
  const params = record(value);
  const serverName = boundedText(params?.serverName, 100);
  const message = boundedText(params?.message, 600);
  if (!serverName || !message) return undefined;
  if (params?.mode === "form") {
    const fields = formFields(params.requestedSchema);
    return fields ? { mode: "form", serverName, message, fields } : undefined;
  }
  if (params?.mode !== "url" || typeof params.url !== "string" || params.url.length > 2048) return undefined;
  try {
    const url = new URL(params.url);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) return undefined;
    return { mode: "url", serverName, message, url: url.toString(), urlHost: url.hostname };
  } catch { return undefined; }
}

function acceptedContent(fields: readonly LiveElicitationField[], value: unknown): Record<string, unknown> | undefined {
  const input = record(value);
  if (!input || Object.keys(input).some((name) => !fields.some((field) => field.name === name))) return undefined;
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    if (!Object.hasOwn(input, field.name)) {
      if (field.required) return undefined;
      continue;
    }
    const entry = input[field.name];
    if (field.type === "string") {
      if (typeof entry !== "string" || entry.length > (field.maxLength ?? 1000) ||
          entry.length < (field.minLength ?? 0) || field.options && !field.options.includes(entry)) return undefined;
    } else if (field.type === "number" || field.type === "integer") {
      if (typeof entry !== "number" || !Number.isFinite(entry) || field.type === "integer" && !Number.isInteger(entry) ||
          field.minimum !== undefined && entry < field.minimum || field.maximum !== undefined && entry > field.maximum) return undefined;
    } else if (typeof entry !== "boolean") return undefined;
    content[field.name] = entry;
  }
  return content;
}

/** Show MCP's supported form/URL elicitation only to the owner watching that session. */
export class MobileElicitationBroker {
  private readonly pending = new Map<string, PendingElicitation>();

  constructor(
    private readonly feed: TmaLiveFeed,
    private readonly registry: RuntimeRegistry,
    private readonly allowedOwners: ReadonlySet<string>,
    private readonly timeoutMs = 120_000,
  ) {}

  handle = async (params: Record<string, unknown>): Promise<McpElicitationResult> => {
    const sessionId = typeof params.threadId === "string" ? params.threadId : "";
    const ownerId = this.registry.ownerChatForSession(sessionId);
    const safe = safeElicitation(params);
    if (!safe || ownerId === undefined || !this.allowedOwners.has(String(ownerId)) || !this.feed.hasSubscribers(sessionId)) {
      return { action: "decline", content: null };
    }
    const id = randomUUID();
    const view: LiveElicitation = { id, ...safe };
    return new Promise<McpElicitationResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.feed.status(sessionId, "approval", "Запрос MCP истёк без ответа");
        resolve(cancelledElicitation);
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, { id, ownerId, sessionId, view, timer, resolve });
      this.feed.status(sessionId, "approval", "MCP ждёт ответ с телефона");
      this.feed.publish(sessionId, { kind: "elicitation", label: "MCP ждёт ответ" });
    });
  };

  listFor(ownerId: number, sessionId: string): LiveElicitation[] {
    return [...this.pending.values()]
      .filter((item) => item.ownerId === ownerId && item.sessionId === sessionId)
      .map((item) => item.view);
  }

  resolve(ownerId: number, sessionId: string, id: string, action: string, value?: unknown): boolean {
    const item = this.pending.get(id);
    if (!item || item.ownerId !== ownerId || item.sessionId !== sessionId ||
        action !== "accept" && action !== "decline" && action !== "cancel") return false;
    let result: McpElicitationResult;
    if (action === "decline" || action === "cancel") result = { action, content: null };
    else if (item.view.mode === "url") {
      if (value !== undefined && value !== null) return false;
      result = { action: "accept", content: null };
    }
    else {
      const content = acceptedContent(item.view.fields ?? [], value);
      if (!content) return false;
      result = { action: "accept", content };
    }
    this.pending.delete(id);
    clearTimeout(item.timer);
    item.resolve(result);
    this.feed.status(sessionId, "working", "Codex продолжает выполнение");
    return true;
  }
}
