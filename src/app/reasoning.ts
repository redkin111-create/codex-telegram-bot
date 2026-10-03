/**
 * Reasoning effort — a per-chat preference that steers how much deliberation
 * the agent applies. Implemented as a concise directive prepended to prompts so
 * it works regardless of backend-specific knobs.
 */
import type { ReasoningEffort } from "./types.js";

const DIRECTIVE: Record<ReasoningEffort, string> = {
  minimal: "Отвечай прямо и кратко, не трать время на лишние рассуждения.",
  low: "Рассуждай кратко; по возможности выбирай быстрое и простое решение.",
  medium: "", // default behaviour — no directive
  high: "Перед ответом тщательно всё обдумай и проверь результат.",
  max: "Работай предельно тщательно: проверь граничные случаи и предположения, затем перепроверь результат.",
};

const LABEL: Record<ReasoningEffort, string> = {
  minimal: "Минимальный",
  low: "Низкий",
  medium: "Средний",
  high: "Высокий",
  max: "Максимальный",
};

export function reasoningDirective(effort: ReasoningEffort): string {
  return DIRECTIVE[effort] ?? "";
}

export function reasoningLabel(effort: ReasoningEffort): string {
  return LABEL[effort] ?? effort;
}
