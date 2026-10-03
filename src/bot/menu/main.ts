import type { Context } from "grammy";
import { basename } from "node:path";
import { reasoningLabel } from "../../app/reasoning.js";
import type { BotDeps } from "../deps.js";
import { mainMenuInline } from "./keyboard.js";
import { compactLabel } from "./paging.js";

export interface MainMenuState {
  project: string;
  session: string;
  model: string;
  reasoning: string;
  sandbox: string;
  approval: string;
  unsafe: boolean;
  busy: boolean;
}

export function mainMenuText(state: MainMenuState): string {
  const lines = [
    "\u{1F916} Удалённый Codex",
    `\u{1F4C1} Проект: ${compactLabel(state.project, 48)}`,
    `\u{1F4AC} Сеанс: ${compactLabel(state.session, 48)}`,
    `\u{1F9E0} Модель: ${compactLabel(state.model, 48)}`,
    `\u2699\uFE0F Уровень рассуждений: ${state.reasoning}`,
    `\u{1F512} Доступ: ${state.sandbox}`,
    `Подтверждение действий: ${state.approval}`,
  ];
  if (state.unsafe) lines.push("\u26A0\uFE0F В настройках включён полный доступ.");
  return lines.join("\n");
}

export async function openMainMenu(ctx: Context, deps: BotDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  await deps.ephemeral.open(ctx);
  const rt = deps.registry.get(chatId);
  const meta = rt.sessionId ? deps.store.get(rt.sessionId) : undefined;
  const state: MainMenuState = {
    project: rt.projectName || (rt.cwd ? basename(rt.cwd) : "Не выбран"),
    session: meta?.title || (rt.sessionId ? rt.sessionId.slice(0, 8) : "Не запущен"),
    model: rt.model || deps.acp.currentModelId || "По умолчанию",
    reasoning: reasoningLabel(rt.reasoning),
    sandbox: deps.cfg.trustAllTools ? "полный" : "только к рабочим папкам",
    approval: deps.cfg.trustAllTools ? "выключено" : "по запросу",
    unsafe: deps.cfg.trustAllTools,
    busy: rt.isBusy,
  };
  await deps.ephemeral.reply(ctx, mainMenuText(state), { reply_markup: mainMenuInline({ busy: state.busy }) });
}
