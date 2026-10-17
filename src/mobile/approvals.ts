import { randomUUID } from "node:crypto";
import type { PermissionOutcome, RequestPermissionParams } from "../acp/types.js";
import { describeRequestedPermissions, type PermissionHandler } from "../acp/approvals.js";
import type { RuntimeRegistry } from "../bot/registry.js";
import type { TmaLiveFeed } from "../tma/live.js";

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
    const options = params.options.filter((option) =>
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
