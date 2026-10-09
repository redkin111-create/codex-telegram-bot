/** A deliberately small, allowlisted RPC protocol shared by the VPS and PC. */
export const TMA_OPERATIONS = [
  "snapshot", "history", "create", "select", "send", "cancel",
  "queue", "queueRemove", "queueResume", "image",
] as const;
export type TmaOperation = (typeof TMA_OPERATIONS)[number];

export interface TmaJob {
  id: string;
  op: TmaOperation;
  userId: number;
  args: Record<string, unknown>;
}

export interface TmaResult {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export function isTmaOperation(value: unknown): value is TmaOperation {
  return typeof value === "string" && (TMA_OPERATIONS as readonly string[]).includes(value);
}

export function isTmaJob(value: unknown): value is TmaJob {
  if (!value || typeof value !== "object") return false;
  const obj = value as Partial<TmaJob>;
  return typeof obj.id === "string" && /^[a-f0-9]{24}$/.test(obj.id) &&
    isTmaOperation(obj.op) && Number.isSafeInteger(obj.userId) && (obj.userId ?? 0) > 0 &&
    !!obj.args && typeof obj.args === "object" && !Array.isArray(obj.args);
}

export function argumentString(args: Record<string, unknown>, key: string, max = 2000): string {
  const val = args[key];
  if (typeof val !== "string" || val.length === 0 || val.length > max) throw new Error("Неверное поле: " + key);
  return val;
}
