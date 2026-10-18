import type { MobileApproval, MobileLiveEvent } from "../types.js";

export function asLiveEvent(message: { id?: number; event: string; data: string }): MobileLiveEvent | undefined {
  if (message.event !== "message") return undefined;
  try {
    const value = JSON.parse(message.data) as Partial<MobileLiveEvent>;
    if (!Number.isSafeInteger(value.id) || typeof value.sessionId !== "string" ||
        !["text", "tool", "status", "activity", "approval", "elicitation", "transcript", "plan", "compaction"].includes(String(value.kind))) return undefined;
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
        id: value.id as number,
        sessionId: value.sessionId,
        kind: "plan",
        at: value.at,
        ...(typeof value.turnId === "string" ? { turnId: value.turnId } : {}),
        ...(typeof value.explanation === "string" ? { explanation: value.explanation } : {}),
        plan,
      };
    }
    if (value.kind === "compaction") {
      if (value.label !== "Codex подтвердил сокращение контекста" || typeof value.at !== "number" || !Number.isFinite(value.at)) return undefined;
      return { id: value.id as number, sessionId: value.sessionId, kind: "compaction", label: value.label, at: value.at };
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
      return { id: value.id as number, sessionId: value.sessionId, kind: "elicitation", label: value.label, at: value.at };
    }
    return value as MobileLiveEvent;
  } catch { return undefined; }
}
