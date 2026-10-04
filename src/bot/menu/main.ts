import type { Context } from "grammy";
import { basename } from "node:path";
import { reasoningLabel } from "../../app/reasoning.js";
import { sameProjectPath } from "../../projects/manager.js";
import type { BotDeps } from "../deps.js";
import { mainMenuInline } from "./keyboard.js";
import { compactLabel } from "./paging.js";
import { codexProjectAt, safeSessionTitle } from "../catalog.js";

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
    "\u{1F916} Codex",
    `\u{1F4C1} ${compactLabel(state.project, 48)}`,
    `\u{1F4AC} ${compactLabel(state.session, 48)}`,
    `\u{1F9E0} ${compactLabel(state.model, 40)} · ${state.reasoning}`,
    state.busy ? "\u23F3 Выполняет задачу" : "\u2705 Готов",
  ];
  return lines.join("\n");
}

export async function openMainMenu(ctx: Context, deps: BotDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  await deps.ephemeral.open(ctx);
  const rt = deps.registry.get(chatId);
  const meta = rt.sessionId ? deps.store.get(rt.sessionId) : undefined;
  const state: MainMenuState = {
    project: await currentProjectName(chatId, rt.cwd, rt.projectName, deps),
    session: safeSessionTitle(meta?.title) || (rt.sessionId ? "Текущий сеанс" : "Готов к работе"),
    model: friendlyModel(rt.model || deps.acp.currentModelId, deps.acp.availableModels),
    reasoning: reasoningLabel(rt.reasoning),
    sandbox: deps.cfg.trustAllTools ? "полный" : "только к рабочим папкам",
    approval: deps.cfg.trustAllTools ? "выключено" : "для внешних папок и сети",
    unsafe: deps.cfg.trustAllTools,
    busy: rt.isBusy,
  };
  await deps.ephemeral.reply(ctx, mainMenuText(state), { reply_markup: mainMenuInline({ busy: state.busy }) });
}

async function currentProjectName(chatId: number, cwd: string, fallback: string | undefined, deps: BotDeps): Promise<string> {
  const selected = deps.menuCache.getSelectedProject(chatId);
  if (selected && (selected.roots ?? [selected.path]).some((root) => sameProjectPath(root, cwd))) return selected.name;
  if (cwd) {
    try {
      const project = await codexProjectAt(deps.acp, cwd);
      if (project) return project.name;
    } catch { /* fall back to the runtime's project label */ }
  }
  return fallback || (cwd ? basename(cwd) : "Не выбран");
}

function friendlyModel(id: string | undefined, models: Array<{ modelId: string; name: string }>): string {
  if (!id || id === "auto") return "По умолчанию";
  return models.find((model) => model.modelId === id)?.name || id.replace(/^gpt-/, "GPT-");
}
