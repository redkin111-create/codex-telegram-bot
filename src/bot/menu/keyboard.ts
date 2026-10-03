/**
 * Menu surfaces:
 *  - a tiny PERSISTENT bar (☰ Menu · 🧭 Running · ⏹ Stop) — minimal footprint;
 *  - one editable INLINE control panel opened on demand.
 * Live state (project/agent/model/reasoning/context) lives in the pinned panel,
 * so the bar stays clean.
 */
import { InlineKeyboard, Keyboard } from "grammy";

export const MENU_BTN = "\u2630 Меню"; // ☰
export const RUNNING_BTN = "\u{1F9ED} Активные";
export const STOP_BTN = "\u23F9 Стоп";
export const BAR_LABELS = [MENU_BTN, RUNNING_BTN, STOP_BTN];

/** The always-visible compact bar. */
export function compactKeyboard(): Keyboard {
  return new Keyboard().text(MENU_BTN).text(RUNNING_BTN).text(STOP_BTN).resized().persistent();
}

/** The compact, phone-sized Codex control panel (opened via /menu). */
export function mainMenuInline(state: { busy: boolean }): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("\u{1F4C1} Проекты", "m:project")
    .text("\u{1F4AC} Сеансы", "m:sessions")
    .row()
    .text("\u{1F9E9} MCP", "m:mcp")
    .text("\u{1F6E0} Навыки", "m:skills")
    .row()
    .text("\u{1F916} Модель", "m:model")
    .text("\u2699\uFE0F Настройки", "m:settings")
    .row()
    .text("\u{1F4CA} Статус", "m:status")
    .text("\u{1F195} Новый сеанс", "m:new")
    .row()
    .text("\u{1F9ED} Ещё", "m:more");
  if (state.busy) return kb.row().text("\u{1F6D1} Остановить задачу", "m:stop");
  return kb;
}

/** Standard footer for single-level screens. */
export function homeKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("\u{1F3E0} Главное меню", "ui:home");
}
