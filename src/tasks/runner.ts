/**
 * Executes a scheduled task: opens a fresh session in the task's project,
 * sends the prompt, collects the response, and delivers it to the chat.
 * Runs independently of the user's interactive session.
 */
import type { Api } from "grammy";
import { basename } from "node:path";
import type { AcpClient } from "../acp/client.js";
import type { SessionUpdate } from "../acp/types.js";
import { createLogger } from "../logger.js";
import { briefErrorMessage } from "../bot/prompt-retry.js";
import { sendMarkdownDoc } from "../bot/telegram-io.js";
import type { Task } from "./types.js";

const log = createLogger("task-runner");

export class TaskRunner {
  constructor(
    private readonly api: Api,
    private readonly acp: AcpClient,
    private readonly recordCreatedSession?: (sessionId: string, task: Task) => void,
  ) {}

  /** Run a task; resolves true on success, false on error. */
  async run(task: Task): Promise<boolean> {
    log.info(`running task "${task.name}" in ${task.projectPath}`);
    let sessionId = "";
    let text = "";

    const listener = (sid: string, u: SessionUpdate): void => {
      if (sid === sessionId && u.sessionUpdate === "agent_message_chunk" && typeof u.content?.text === "string") text += u.content.text;
    };

    try {
      sessionId = await this.acp.newSession(task.projectPath);
      this.recordCreatedSession?.(sessionId, task);
      if (task.agent) {
        try {
          await this.acp.setMode(sessionId, task.agent);
        } catch {
          /* best-effort */
        }
      }
      this.acp.on("session-update", listener);
      await this.acp.prompt(sessionId, [{ type: "text", text: task.prompt }]);
      this.acp.off("session-update", listener);
      await this.deliver(task, text);
      return true;
    } catch (err) {
      this.acp.off("session-update", listener);
      await this.deliverError(task, briefErrorMessage(err as Error));
      log.error(`task "${task.name}" failed:`, (err as Error).message);
      return false;
    }
  }

  private async deliver(task: Task, text: string): Promise<void> {
    const project = task.projectName || basename(task.projectPath);
    const body = text.trim() || "_(ответ не содержит текста)_";
    const header = `\u23F0 **Задача: ${task.name}** \u00B7 ${project}`;
    await sendMarkdownDoc(this.api, task.chatId, `${header}\n\n${body}`, { loud: true });
  }

  private async deliverError(task: Task, message: string): Promise<void> {
    try {
      await this.api.sendMessage(task.chatId, `\u274C Не удалось выполнить задачу «${task.name}»: ${message}`, {
        disable_notification: false,
      });
    } catch {
      /* non-fatal */
    }
  }
}
