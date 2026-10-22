import type { MobileApproval, MobileLiveEvent } from "../types.js";

export function asLiveEvent(message: { id?: number; event: string; data: string }): MobileLiveEvent | undefined {
  if (message.event !== "message") return undefined;
  try {
    const value = JSON.parse(message.data) as Partial<MobileLiveEvent>;
    if (!Number.isSafeInteger(value.id) || (value.id as number) < 0 || typeof value.sessionId !== "string" ||
        value.sessionId.length < 8 || value.sessionId.length > 128 ||
        typeof value.at !== "number" || !Number.isFinite(value.at) ||
        !["text", "tool", "status", "activity", "approval", "elicitation", "transcript", "plan", "compaction"].includes(String(value.kind))) return undefined;
    const base = { id: value.id as number, sessionId: value.sessionId, at: value.at };
    if (value.kind === "text") {
      return typeof value.text === "string" && value.text.length > 0 && value.text.length <= 4000
        ? { ...base, kind: "text", text: value.text }
        : undefined;
    }
    if (value.kind === "tool" || value.kind === "activity") {
      return typeof value.label === "string" && value.label.length > 0 && value.label.length <= 220
        ? { ...base, kind: value.kind, label: value.label }
        : undefined;
    }
    if (value.kind === "status") {
      const statuses = new Set(["working", "approval", "completed", "failed", "cancelled", "observing"]);
      return typeof value.status === "string" && statuses.has(value.status) &&
          (value.label === undefined || typeof value.label === "string" && value.label.length <= 220)
        ? { ...base, kind: "status", status: value.status as MobileLiveEvent["status"], ...(typeof value.label === "string" ? { label: value.label } : {}) }
        : undefined;
    }
    if (value.kind === "plan") {
      if (!Array.isArray(value.plan) || value.plan.length > 30 || typeof value.at !== "number" || !Number.isFinite(value.at) ||
          value.explanation !== undefined && (typeof value.explanation !== "string" || value.explanation.length > 1000) ||
          value.turnId !== undefined && (typeof value.turnId !== "string" || value.turnId.length > 128)) return undefined;
      const plan: NonNullable<MobileLiveEvent["plan"]> = [];
      for (const rawStep of value.plan) {
        if (!rawStep || typeof rawStep !== "object") return undefined;
        const step = rawStep as { step?: unknown; status?: unknown };
        if (typeof step.step !== "string" || step.step.trim().length === 0 || step.step.length > 300 ||
            step.status !== "pending" && step.status !== "inProgress" && step.status !== "completed") return undefined;
        plan.push({ step: step.step, status: step.status });
      }
      return {
        ...base,
        kind: "plan",
        ...(typeof value.turnId === "string" ? { turnId: value.turnId } : {}),
        ...(typeof value.explanation === "string" ? { explanation: value.explanation } : {}),
        plan,
      };
    }
    if (value.kind === "compaction") {
      if (value.label !== "Codex подтвердил сокращение контекста" || typeof value.at !== "number" || !Number.isFinite(value.at)) return undefined;
      return { ...base, kind: "compaction", label: value.label };
    }
    if (value.kind === "transcript" && (value.role !== "user" && value.role !== "assistant" ||
        typeof value.text !== "string" || value.text.length === 0 || value.text.length > 4000)) return undefined;
    if (value.kind === "approval") {
      const approval = value.approval as Partial<MobileApproval> | undefined;
      if (!approval || typeof approval.id !== "string" || !/^[a-f0-9-]{36}$/.test(approval.id) ||
          typeof approval.title !== "string" || typeof approval.kind !== "string" || !Array.isArray(approval.options) ||
          approval.options.length === 0 || approval.options.length > 8 ||
          approval.options.some((option) => !option || typeof option.id !== "string" || typeof option.label !== "string")) return undefined;
    }
    if (value.kind === "elicitation") {
      if (value.label !== "MCP ждёт ответ" || typeof value.at !== "number" || !Number.isFinite(value.at)) return undefined;
      return { ...base, kind: "elicitation", label: value.label };
    }
    if (value.kind === "transcript") {
      if ((value.role !== "user" && value.role !== "assistant") || typeof value.text !== "string" ||
          value.text.length === 0 || value.text.length > 4000) return undefined;
      return { ...base, kind: "transcript", role: value.role, text: value.text };
    }
    if (value.kind === "approval") {
      const approval = value.approval as Partial<MobileApproval> | undefined;
      if (!approval || typeof approval.id !== "string" || !/^[a-f0-9-]{36}$/.test(approval.id) ||
          typeof approval.title !== "string" || approval.title.length > 300 ||
          typeof approval.kind !== "string" || approval.kind.length > 80 || !Array.isArray(approval.options) ||
          approval.options.length === 0 || approval.options.length > 8 ||
          approval.options.some((option) => !option || typeof option.id !== "string" || option.id.length > 100 ||
            typeof option.label !== "string" || option.label.length > 220) ||
          approval.summary !== undefined && (typeof approval.summary !== "string" || approval.summary.length > 1000)) return undefined;
      return { ...base, kind: "approval", approval: {
        id: approval.id,
        title: approval.title,
        kind: approval.kind,
        ...(typeof approval.summary === "string" ? { summary: approval.summary } : {}),
        options: approval.options.map((option) => ({ id: option.id, label: option.label })),
      } };
    }
    return undefined;
  } catch { return undefined; }
}
