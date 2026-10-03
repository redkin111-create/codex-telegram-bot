/**
 * /tasks — manage scheduled tasks (create, list, view, edit, delete, run now).
 * /newtask — start the creation wizard.
 *
 * A task is a prompt + a project + a schedule (once/daily/weekly/monthly/
 * interval). The scheduler runs it and delivers the result here.
 */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import { basename } from "node:path";
import type { BotDeps } from "../deps.js";
import { describeSchedule } from "../../tasks/schedule.js";
import type { Task } from "../../tasks/types.js";
import type { ScheduleType } from "../../tasks/types.js";
import type { WizardPrompt } from "../wizard/task-wizard.js";
import { sendProjectMenu } from "./projects.js";

const UUID = "([0-9a-fA-F-]{36})";

export async function showTasks(ctx: Context, deps: BotDeps): Promise<void> {
  await deps.ephemeral.open(ctx);
  const { text, kb } = listView(deps, ctx.chat!.id);
  await deps.ephemeral.reply(ctx, text, { reply_markup: kb });
}

export async function renderWizardPrompt(ctx: Context, deps: BotDeps, p: WizardPrompt, reuseLatest = false): Promise<void> {
  if (!reuseLatest) await deps.ephemeral.open(ctx);
  const reply = (text: string, extra: Record<string, unknown> = {}) => {
    if (reuseLatest && ctx.chat) return deps.ephemeral.editLatest(ctx.chat.id, text, extra);
    return deps.ephemeral.reply(ctx, text, extra);
  };
  switch (p.kind) {
    case "text":
      await reply(p.text);
      return;
    case "project":
      await sendProjectMenu(ctx, deps, "wiz:proj:", p.text, undefined, reuseLatest);
      return;
    case "scheduleType": {
      const kb = new InlineKeyboard()
        .text("Один раз", "wiz:sched:once")
        .text("Каждый день", "wiz:sched:daily")
        .row()
        .text("Каждую неделю", "wiz:sched:weekly")
        .text("Каждый месяц", "wiz:sched:monthly")
        .row()
        .text("Каждые N минут", "wiz:sched:interval");
      await reply(p.text, { reply_markup: kb });
      return;
    }
    case "confirm": {
      const kb = new InlineKeyboard().text("\u2705 Сохранить", "wiz:confirm").text("\u2716 Отмена", "wiz:cancel");
      await reply(p.text, { reply_markup: kb });
      return;
    }
    case "done":
      await reply(p.text, {
        reply_markup: new InlineKeyboard().text("\u{1F5D3} Задачи", "m:tasks").text("\u{1F3E0} Главное меню", "ui:home"),
      });
      return;
    case "aborted":
      await reply("Действие отменено.", { reply_markup: new InlineKeyboard().text("\u{1F3E0} Главное меню", "ui:home") });
      return;
  }
}

/**
 * Wizard text-input interceptor. Registered BEFORE command/prompt handlers so
 * that, while a task wizard is active, free text feeds the wizard. A slash
 * command aborts the wizard and is allowed through.
 */
export function registerWizardInput(bot: Bot, deps: BotDeps): void {
  bot.on("message:text", async (ctx, next) => {
    const chatId = ctx.chat.id;
    if (!deps.wizard.isActive(chatId)) return next();
    const text = ctx.message.text;
    if (text.startsWith("/")) {
      deps.wizard.abort(chatId);
      return next();
    }
    const p = deps.wizard.handleText(chatId, text);
    if (p) {
      await ctx.deleteMessage().catch(() => {});
      await renderWizardPrompt(ctx, deps, p, true);
    }
  });
}

export function registerTasks(bot: Bot, deps: BotDeps): void {
  bot.command("tasks", (ctx) => showTasks(ctx, deps));
  bot.command("newtask", async (ctx) => {
    await renderWizardPrompt(ctx, deps, deps.wizard.startCreate(ctx.chat.id));
  });

  bot.callbackQuery("task:new", async (ctx) => {
    await ctx.answerCallbackQuery();
    await renderWizardPrompt(ctx, deps, deps.wizard.startCreate(ctx.chat!.id));
  });

  bot.callbackQuery(new RegExp(`^task:view:${UUID}$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    const task = deps.tasks.get(ctx.match![1]!);
    if (!task) return void ctx.editMessageText("Задача не найдена.");
    const { text, kb } = detailView(task);
    await ctx.editMessageText(text, { reply_markup: kb });
  });

  bot.callbackQuery("task:list", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { text, kb } = listView(deps, ctx.chat!.id);
    await ctx.editMessageText(text, { reply_markup: kb });
  });

  bot.callbackQuery(new RegExp(`^task:toggle:${UUID}$`), async (ctx) => {
    const task = deps.tasks.get(ctx.match![1]!);
    if (!task) return void ctx.answerCallbackQuery({ text: "Задача не найдена" });
    const updated = deps.tasks.update(task.id, { enabled: !task.enabled });
    await ctx.answerCallbackQuery({ text: updated?.enabled ? "Задача включена" : "Задача выключена" });
    if (updated) {
      const { text, kb } = detailView(updated);
      await ctx.editMessageText(text, { reply_markup: kb });
    }
  });

  bot.callbackQuery(new RegExp(`^task:run:${UUID}$`), async (ctx) => {
    const task = deps.tasks.get(ctx.match![1]!);
    if (!task) return void ctx.answerCallbackQuery({ text: "Задача не найдена" });
    await ctx.answerCallbackQuery({ text: "Запускаю…" });
    void deps.taskRunner.run(task);
  });

  bot.callbackQuery(new RegExp(`^task:del:${UUID}$`), async (ctx) => {
    deps.tasks.delete(ctx.match![1]!);
    await ctx.answerCallbackQuery({ text: "Задача удалена" });
    const { text, kb } = listView(deps, ctx.chat!.id);
    await ctx.editMessageText(text, { reply_markup: kb });
  });

  bot.callbackQuery(new RegExp(`^task:editmenu:${UUID}$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    const task = deps.tasks.get(ctx.match![1]!);
    if (!task) return;
    await ctx.editMessageText(`Задача «${task.name}». Что изменить?`, {
      reply_markup: editMenu(task.id),
    });
  });

  bot.callbackQuery(new RegExp(`^task:edit:(name|prompt|project|schedule):${UUID}$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    const field = ctx.match![1] as "name" | "prompt" | "project" | "schedule";
    const p = deps.wizard.startEdit(ctx.chat!.id, ctx.match![2]!, field);
    if (p) await renderWizardPrompt(ctx, deps, p);
    else await ctx.reply("Задача не найдена.");
  });

  // ── wizard inline steps ────────────────────────────────────────────────
  bot.callbackQuery(/^wiz:p:([a-f0-9]{16}):(\d+)$/, async (ctx) => {
    const entry = deps.menuCache.getProject(ctx.chat!.id, Number(ctx.match![2]), ctx.match![1]);
    if (!entry) return void ctx.answerCallbackQuery({ text: "Срок действия списка проектов истёк. Начните создание задачи заново." });
    await ctx.answerCallbackQuery();
    const p = deps.wizard.setProject(ctx.chat!.id, entry.path, entry.name);
    if (p) await renderWizardPrompt(ctx, deps, p);
  });

  bot.callbackQuery(/^wiz:sched:(once|daily|weekly|monthly|interval)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = deps.wizard.setScheduleType(ctx.chat!.id, ctx.match![1] as ScheduleType);
    if (p) await renderWizardPrompt(ctx, deps, p);
  });

  bot.callbackQuery("wiz:confirm", async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = deps.wizard.confirm(ctx.chat!.id);
    if (p) await renderWizardPrompt(ctx, deps, p);
  });

  bot.callbackQuery("wiz:cancel", async (ctx) => {
    await ctx.answerCallbackQuery();
    deps.wizard.abort(ctx.chat!.id);
    await ctx.editMessageText("Действие отменено.");
  });
}

// ── views ────────────────────────────────────────────────────────────────

function listView(deps: BotDeps, chatId: number): { text: string; kb: InlineKeyboard } {
  const tasks = deps.tasks.forChat(chatId);
  const kb = new InlineKeyboard();
  if (tasks.length === 0) {
    kb.text("\u2795 Новая задача", "task:new").row().text("\u{1F3E0} Главное меню", "ui:home");
    return { text: "Пока нет задач по расписанию.", kb };
  }
  for (const t of tasks) {
    const dot = t.enabled ? "\u{1F7E2}" : "\u26AA";
    const name = t.name.length > 24 ? t.name.slice(0, 24) + "\u2026" : t.name;
    kb.text(`${dot} ${name} \u00B7 ${describeSchedule(t.schedule)}`, `task:view:${t.id}`).row();
  }
  kb.text("\u2795 Новая задача", "task:new").row().text("\u{1F3E0} Главное меню", "ui:home");
  return { text: `\u{1F5D3} Задачи по расписанию (${tasks.length}):`, kb };
}

function detailView(t: Task): { text: string; kb: InlineKeyboard } {
  const next = t.nextRun ? new Date(t.nextRun).toLocaleString("ru-RU") : "\u2014";
  const last = t.lastRun ? `${new Date(t.lastRun).toLocaleString("ru-RU")} (${translateStatus(t.lastStatus)})` : "ещё не запускалась";
  const prompt = t.prompt.length > 300 ? t.prompt.slice(0, 300) + "\u2026" : t.prompt;
  const text = [
    `\u{1F5D3} ${t.name}  ${t.enabled ? "\u{1F7E2} включена" : "\u26AA выключена"}`,
    `\u{1F4C1} Проект: ${t.projectName || basename(t.projectPath)}`,
    `\u{1F501} Расписание: ${describeSchedule(t.schedule)}`,
    `\u23ED Следующий запуск: ${next}`,
    `\u23EE Последний запуск: ${last}`,
    "",
    `\u{1F4AC} ${prompt}`,
  ].join("\n");
  const kb = new InlineKeyboard()
    .text("\u25B6 Запустить", `task:run:${t.id}`)
    .text(t.enabled ? "\u23F8 Выключить" : "\u25B6 Включить", `task:toggle:${t.id}`)
    .row()
    .text("\u270F\uFE0F Изменить", `task:editmenu:${t.id}`)
    .text("\u{1F5D1} Удалить", `task:del:${t.id}`)
    .row()
    .text("\u2B05 Назад", "task:list")
    .text("\u{1F3E0} Меню", "ui:home");
  return { text, kb };
}

function editMenu(id: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Название", `task:edit:name:${id}`)
    .text("Действие", `task:edit:prompt:${id}`)
    .row()
    .text("Проект", `task:edit:project:${id}`)
    .text("Расписание", `task:edit:schedule:${id}`)
    .row()
    .text("\u2B05 Назад", `task:view:${id}`)
    .text("\u{1F3E0} Меню", "ui:home");
}

function translateStatus(status: string | undefined): string {
  switch (status?.toLowerCase()) {
    case "completed": case "success": case "ok": return "успешно";
    case "failed": case "error": return "ошибка";
    case "running": return "выполняется";
    default: return status ?? "неизвестно";
  }
}
