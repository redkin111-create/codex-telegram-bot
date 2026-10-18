import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { MobileAuthStore } from "../../src/mobile/auth.js";
import { createMobileServer } from "../../src/mobile/server.js";
import { MobileApprovalBroker } from "../../src/mobile/approvals.js";
import { MiniAppAgent, type MobileLocalJob } from "../../src/tma/agent.js";
import type { LiveEvent, TmaLiveFeed } from "../../src/tma/live.js";
import type { TmaJob } from "../../src/tma/protocol.js";
import type { RuntimeRegistry } from "../../src/bot/registry.js";
import type { AcpClient } from "../../src/acp/client.js";
import type { AppConfig } from "../../src/config.js";

const ownerId = 101;
const firstSession = "11111111-1111-4111-8111-111111111111";
const secondSession = "22222222-2222-4222-8222-222222222222";
const archivedFixtureSession = "44444444-4444-4444-8444-444444444444";
const olderArchivedFixtureSession = "77777777-7777-4777-8777-777777777777";
const projectOne = "C:\\fixture\\codex-mobile";
const projectTwo = "C:\\fixture\\other-project";
const screenshotPath = "C:\\fixture\\codex-mobile\\screenshots\\sample.png";

class FixtureFeed {
  readonly epoch = randomUUID().replaceAll("-", "");
  private nextId = 0;
  private readonly events = new Map<string, LiveEvent[]>();
  private readonly listeners = new Map<string, Set<(event: LiveEvent) => void>>();
  private readonly statuses = new Map<string, { status: string; label: string; at: number }>();

  latestId() { return this.nextId; }
  hasSubscribers(sessionId: string) { return (this.listeners.get(sessionId)?.size ?? 0) > 0; }
  getStatus(sessionId: string) { return this.statuses.get(sessionId); }
  subscribe(sessionId: string, after: number, listener: (event: LiveEvent) => void) {
    const set = this.listeners.get(sessionId) ?? new Set<(event: LiveEvent) => void>();
    set.add(listener);
    this.listeners.set(sessionId, set);
    for (const event of this.events.get(sessionId) ?? []) if (event.id > after) listener(event);
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(sessionId); };
  }
  publish(sessionId: string, payload: Omit<LiveEvent, "id" | "sessionId" | "at">) {
    const event: LiveEvent = { ...payload, id: ++this.nextId, sessionId, at: Date.now() };
    const list = this.events.get(sessionId) ?? [];
    list.push(event);
    this.events.set(sessionId, list.slice(-40));
    if (payload.kind === "status" && payload.status) {
      this.statuses.set(sessionId, { status: payload.status, label: payload.label ?? "", at: event.at });
    }
    for (const listener of this.listeners.get(sessionId) ?? []) listener(event);
  }
  status(sessionId: string, status: string, label: string) {
    this.publish(sessionId, { kind: "status", status: status as LiveEvent["status"], label });
  }
}

const instanceDir = await mkdtemp(join(tmpdir(), "codex-mobile-browser-"));
const dataDir = join(instanceDir, "data");
const auth = new MobileAuthStore(dataDir, { allowedOwners: new Set([String(ownerId)]) });
const feed = new FixtureFeed();
const sessions = [
  { id: firstSession, title: "Разобрать приложение", cwd: projectOne, updatedAt: Date.now(), source: "appServer" },
  { id: secondSession, title: "Проверить API", cwd: projectOne, updatedAt: Date.now() - 10_000, source: "cli" },
  { id: "33333333-3333-4333-8333-333333333333", title: "Другой проект", cwd: projectTwo, updatedAt: Date.now() - 20_000, source: "vscode" },
  { id: "55555555-5555-4555-8555-555555555555", title: "Legacy Codex architecture", cwd: projectOne, updatedAt: Date.now() - 40_000, source: "cli" },
  { id: "66666666-6666-4666-8666-666666666666", title: "Legacy Codex integration", cwd: projectOne, updatedAt: Date.now() - 50_000, source: "appServer" },
];
const archivedSessions = [
  { id: archivedFixtureSession, title: "Старый архивный сеанс", cwd: projectOne, updatedAt: Date.now() - 30_000, source: "appServer" },
  { id: olderArchivedFixtureSession, title: "Ещё один архивный сеанс", cwd: projectOne, updatedAt: Date.now() - 60_000, source: "cli" },
];
const history = new Map<string, Array<{ role: "user" | "assistant" | "tool"; text: string; tool?: string; timestamp: number }>>([
  [firstSession, [
    { role: "user", text: "Проверь экран Codex Mobile и сообщи, что видишь.", timestamp: Date.now() - 70_000 },
    { role: "assistant", text: "## Проверка готова\n\n- История загружена\n- **Безопасная разметка**\n\n[небезопасная ссылка](javascript:alert(1)) <img src=x onerror=alert(1)>", timestamp: Date.now() - 60_000 },
    { role: "tool", tool: "read_file", text: "Секретный вывод инструмента для теста.\nВ браузере показывается только по запросу.", timestamp: Date.now() - 55_000 },
  ]],
  [secondSession, [{ role: "assistant", text: "API fixture для переключения сеанса.", timestamp: Date.now() - 15_000 }]],
]);
const controlled = new Map<string, { busy: boolean; queue: Array<{ id: string; text: string }>; paused: boolean }>();
let selected = firstSession;
const fixtureSettings = { model: "fixture", mode: "code", reasoning: "medium" };
const fixtureGoals = new Map<string, { threadId: string; objective: string; status: "active" | "paused"; tokenBudget: number | null; tokensUsed: number; timeUsedSeconds: number; createdAt: number; updatedAt: number }>();
const fixtureStaged = new Set<string>();
let fixtureBranch = "feat/codex-mobile-fixture";
let fixtureNotesCommitted = false;
let fixtureRenameStaged = true;
let fixturePluginInstalled = false;
let fixtureMcpAuthorized = false;
const fixtureSkills = [
  { name: "fixture-review", description: "Навык для проверки. <script>alert(1)</script> остаётся текстом.", enabled: true, scope: "user" as const, canToggle: true, invokable: true },
  { name: "disabled-helper", description: "Отключённый навык.", enabled: false, scope: "repo" as const, canToggle: true, invokable: false },
  { name: "managed-skill", description: "Управляется политикой.", enabled: true, scope: "admin" as const, canToggle: false, invokable: true },
];
const fixtureTerminals = new Map<string, { sessionId: string; output: string; pendingInput: string; exited: boolean; exitCode: number | null; }>();
const fixtureTerminalBySession = new Map<string, string>();
const fixtureBackgroundProcesses = new Map<string, Array<{ itemId: string; processId: string }>>([
  [firstSession, [{ itemId: "fixture-command-item", processId: "4242" }]],
]);
let fixtureBackgroundTerminalFailure = false;
let fixtureLatestTurnId = "11111111-1111-4111-8111-111111111111";
let fixtureEditUnavailable = false;
let fixtureEditFailure = false;
let fixtureTranscriptionFailure = false;
let fixtureDeleteFailure = false;
const fixtureFiles = new Map<string, string>([
  ["README.md", "# Fixture project\n\nRead-only history is followed by mobile file access.\n"],
  ["src/main.ts", "export function greet() {\n  return \"Hello from fixture\";\n}\n"],
  ["assets/preview.png", "fixture raster preview"],
]);

const voiceAcp = {
  isConnected: true,
  async listProjects() { return []; },
  async listThreads() { return sessions.map((session) => ({ id: session.id, name: session.title, cwd: session.cwd, source: session.source, createdAt: 1, updatedAt: session.updatedAt, recencyAt: session.updatedAt })); },
  async listAllThreads() { return sessions.map((session) => ({ id: session.id, name: session.title, cwd: session.cwd, source: session.source, createdAt: 1, updatedAt: session.updatedAt, recencyAt: session.updatedAt })); },
} as unknown as AcpClient;
const voiceConfig = {
  allowedUsers: new Set([String(ownerId)]), sessionsDir: dataDir, dataDir,
  workspace: projectOne, projectRoots: [projectOne], sttModel: "fixture",
} as AppConfig;
const voiceAgent = new MiniAppAgent({
  cfg: voiceConfig,
  acp: voiceAcp,
  registry: { runtimeForSession: () => undefined } as unknown as RuntimeRegistry,
  stt: {
    enabled: true,
    async transcribe() {
      if (fixtureTranscriptionFailure) { fixtureTranscriptionFailure = false; throw new Error("upstream-fixture-private-detail"); }
      return "Проверь состояние проекта перед отправкой";
    },
  },
});

const agent = {
  async canReadSession(sessionId: string, id: number) {
    return id === ownerId && (sessions.some((session) => session.id === sessionId) || archivedSessions.some((session) => session.id === sessionId));
  },
  async execute(job: TmaJob): Promise<unknown> {
    const args = job.args;
    if (job.op === "snapshot") {
      return {
        projects: [...new Map([
          [projectOne, "codex-mobile"], [projectTwo, "other-project"],
          ...sessions.filter((session) => session.cwd !== projectOne && session.cwd !== projectTwo).map((session) => [session.cwd, session.title.split(" · ")[0] ?? session.title] as [string, string]),
        ]).entries()].map(([path, name]) => ({ path, name })),
        sessions: sessions.slice(0, 3).map((session) => {
          const runtime = controlled.get(session.id);
          return { ...session, archived: false, busy: runtime?.busy ?? false, queue: runtime?.queue.length ?? 0 };
        }),
        archivedSessions: archivedSessions.slice(0, 1).map((session) => ({ ...session, archived: true, busy: false, queue: 0 })),
        archiveAvailable: true,
        selected, controlled: [...controlled].map(([id, runtime]) => ({ id, busy: runtime.busy, queue: runtime.queue.length, paused: runtime.paused })),
        online: true, model: "fixture", models: [{ id: "fixture", name: "Fixture" }],
      };
    }
    const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
    if (job.op === "history") {
      const entries = history.get(sessionId) ?? [];
      return { entries: entries.filter((entry) => args.includeTools === true || entry.role !== "tool"), images: sessionId === firstSession ? [{ path: screenshotPath, name: "sample.png", mtimeMs: 1, size: 68 }] : [], project: projectOne };
    }
    if (job.op === "activity") {
      return { busy: controlled.get(sessionId)?.busy ?? false, queue: controlled.get(sessionId)?.queue.length ?? 0,
        images: sessionId === firstSession ? [{ path: screenshotPath, name: "sample.png", mtimeMs: 1, size: 68 }] : [] };
    }
    if (job.op === "image") {
      return { mime: "image/png", name: "Тестовый скриншот Codex.png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/x6kAAAAASUVORK5CYII=" };
    }
    if (job.op === "create") {
      const id = randomUUID();
      sessions.unshift({ id, title: "Новый сеанс", cwd: String(args.cwd), updatedAt: Date.now(), source: "appServer" });
      history.set(id, []);
      selected = id;
      controlled.set(id, { busy: false, queue: [], paused: false });
      return { sessionId: id };
    }
    if (job.op === "select") {
      selected = sessionId;
      if (!controlled.has(sessionId)) controlled.set(sessionId, {
        busy: false,
        queue: sessionId === firstSession ? [{ id: "queued-fixture-1", text: "Продолжить после первого этапа" }] : [],
        paused: sessionId === firstSession,
      });
      return { sessionId };
    }
    if (job.op === "send") {
      const message = String(args.text ?? "");
      const runtime = controlled.get(sessionId) ?? { busy: false, queue: [], paused: false };
      if (runtime.busy) {
        runtime.queue.push({ id: randomUUID(), text: message || "Проверить прикреплённое фото" });
        controlled.set(sessionId, runtime);
        return { result: "queued" };
      }
      const entries = history.get(sessionId) ?? [];
      entries.push({ role: "user", text: message || "Проверка фото", timestamp: Date.now() });
      entries.push({ role: "assistant", text: "Задание принято из тестовой среды. Настоящий Codex не запускался.", timestamp: Date.now() });
      history.set(sessionId, entries);
      runtime.busy = true;
      controlled.set(sessionId, runtime);
      feed.status(sessionId, "working", "Codex работает (тест)");
      feed.publish(sessionId, { kind: "text", text: "Запрос принят тестовой средой" });
      return { result: "submitted" };
    }
    if (job.op === "cancel") {
      const runtime = controlled.get(sessionId);
      if (runtime) runtime.busy = false;
      feed.status(sessionId, "cancelled", "Задача остановлена (тест)");
      return { cancelled: true };
    }
    if (job.op === "queue") {
      const runtime = controlled.get(sessionId) ?? { busy: false, queue: [], paused: false };
      return { items: runtime.queue, busy: runtime.busy, paused: runtime.paused };
    }
    if (job.op === "queueRemove") {
      const runtime = controlled.get(sessionId);
      if (runtime) runtime.queue = runtime.queue.filter((item) => item.id !== args.itemId);
      return { removed: true };
    }
    if (job.op === "queueResume") {
      const runtime = controlled.get(sessionId);
      if (runtime) runtime.paused = false;
      return { resumed: true };
    }
    throw new Error("Неизвестная fixture-операция: " + job.op);
  },
  async executeMobile(job: { op: string; userId: number; args: Record<string, unknown> }): Promise<unknown> {
    const args = job.args;
    const sessionId = String(args.sessionId ?? "");
    if (job.op === "transcribeAudio") return voiceAgent.executeMobile(job as unknown as MobileLocalJob);
    if (job.op === "latestEditableTurn") {
      if (sessionId !== firstSession) throw new Error("Сеанс не найден");
      return fixtureEditUnavailable
        ? { editable: false, reason: "В запросе есть вложение, которое нельзя безопасно восстановить.", attachmentCount: 1 }
        : { turnId: fixtureLatestTurnId, text: "Проверь экран Codex Mobile и сообщи, что видишь.", skillNames: [], attachmentCount: 0, editable: true };
    }
    if (job.op === "editAndRetry") {
      if (fixtureEditFailure) { fixtureEditFailure = false; throw new Error("Тестовая ошибка Codex при повторной отправке"); }
      if (sessionId !== firstSession || args.turnId !== fixtureLatestTurnId) throw new Error("Последний запрос Codex изменился");
      if (fixtureEditUnavailable) throw new Error("Последний запрос нельзя безопасно редактировать с телефона");
      const entries = history.get(sessionId) ?? [];
      let lastUserIndex = -1;
      for (let index = entries.length - 1; index >= 0; index--) if (entries[index]?.role === "user") { lastUserIndex = index; break; }
      if (lastUserIndex < 0) throw new Error("Последний запрос не найден");
      entries.splice(lastUserIndex);
      entries.push({ role: "user", text: String(args.text ?? ""), timestamp: Date.now() });
      entries.push({ role: "assistant", text: "Запрос повторно обработан из изолированной тестовой среды. Настоящий Codex не запускался.", timestamp: Date.now() });
      history.set(sessionId, entries);
      fixtureLatestTurnId = randomUUID();
      return { result: "end_turn" };
    }
    if (job.op === "searchThreads") {
      const query = String(args.query ?? "").trim().toLowerCase();
      const source = args.archived === true ? archivedSessions : sessions;
      const matching = source.filter((session) =>
        (!args.cwd || session.cwd === args.cwd) && `${session.title} ${session.cwd}`.toLowerCase().includes(query),
      );
      const offset = Math.max(0, Number.parseInt(String(args.cursor ?? "0"), 10) || 0);
      const page = matching.slice(offset, offset + 1);
      return {
        sessions: page.map((session) => ({ ...session, archived: args.archived === true, busy: false, queue: 0, liveStatus: "unknown", liveLabel: "Статус неизвестен" })),
        nextCursor: offset + page.length < matching.length ? String(offset + page.length) : undefined,
      };
    }
    if (job.op === "reviewThread") {
      const runtime = controlled.get(sessionId) ?? { busy: false, queue: [], paused: false };
      if (runtime.busy) throw new Error("Нельзя запускать ревью, пока Codex работает (тестовая среда)");
      const target = args.target as { type?: string } | undefined;
      if (!target?.type || !["uncommittedChanges", "baseBranch", "commit", "custom"].includes(target.type)) throw new Error("Некорректная цель ревью fixture");
      const entries = history.get(sessionId) ?? [];
      entries.push({ role: "assistant", text: "Ревью Codex запущено в тестовой среде. Настоящий Codex не запускался.", timestamp: Date.now() });
      history.set(sessionId, entries);
      runtime.busy = true;
      controlled.set(sessionId, runtime);
      feed.status(sessionId, "working", "Ревью Codex выполняется (тест)");
      feed.publish(sessionId, { kind: "text", text: "Ревью Codex запущено тестовой средой" });
      return { started: true, reviewThreadId: sessionId, turnId: "fixture-review-turn" };
    }
    if (job.op === "listBackgroundTerminals") {
      if (fixtureBackgroundTerminalFailure) throw new Error("Тестовая ошибка Codex: связь потеряна");
      if (!sessions.some((entry) => entry.id === sessionId)) throw new Error("Сеанс не найден");
      return { items: (fixtureBackgroundProcesses.get(sessionId) ?? []).map((item) => ({ ...item })) };
    }
    if (job.op === "stopBackgroundTerminal") {
      const items = fixtureBackgroundProcesses.get(sessionId) ?? [];
      const processId = String(args.processId ?? "");
      if (!items.some((item) => item.processId === processId)) throw new Error("Фоновый процесс не найден в выбранном сеансе");
      fixtureBackgroundProcesses.set(sessionId, items.filter((item) => item.processId !== processId));
      return { stopped: true, processId };
    }
    if (job.op === "listMoreThreads") {
      const archived = args.archived === true;
      const source = archived ? archivedSessions : sessions;
      const matching = source.filter((session) => !args.cwd || session.cwd === args.cwd);
      const offset = Number(args.offset ?? 0);
      const page = matching.slice(offset, offset + 1);
      return {
        sessions: page.map((session) => ({ ...session, archived, busy: false, queue: 0, liveStatus: "unknown", liveLabel: "Статус неизвестен" })),
        ...(offset + page.length < matching.length ? { nextOffset: offset + page.length } : {}),
      };
    }
    if (job.op === "terminalExec") {
      const session = sessions.find((entry) => entry.id === sessionId);
      if (!session) throw new Error("Сеанс не найден");
      return { exitCode: 0, stdout: `mobile-terminal-fixture\n${session.cwd}\n`, stderr: "", truncated: false, durationMs: 4, timedOut: false };
    }
    if (job.op === "terminalStart") {
      const session = sessions.find((entry) => entry.id === sessionId);
      if (!session) throw new Error("Сеанс не найден");
      const existingId = fixtureTerminalBySession.get(sessionId);
      const existing = existingId ? fixtureTerminals.get(existingId) : undefined;
      if (existing && !existing.exited && existingId) return { terminalId: existingId, shell: "Fixture Shell", reused: true, exited: false };
      const terminalId = randomUUID();
      fixtureTerminals.set(terminalId, { sessionId, output: "fixture shell ready\r\n", pendingInput: "", exited: false, exitCode: null });
      fixtureTerminalBySession.set(sessionId, terminalId);
      return { terminalId, shell: "Fixture Shell", reused: false, exited: false };
    }
    if (job.op === "terminalRead") {
      const terminal = fixtureTerminals.get(String(args.terminalId ?? ""));
      if (!terminal || terminal.sessionId !== sessionId) throw new Error("Терминал не найден");
      const offset = Math.max(0, Number(args.offset ?? 0));
      return { terminalId: args.terminalId, output: terminal.output.slice(offset), nextOffset: terminal.output.length,
        truncated: false, exited: terminal.exited, exitCode: terminal.exitCode };
    }
    if (job.op === "terminalInput") {
      const terminal = fixtureTerminals.get(String(args.terminalId ?? ""));
      if (!terminal || terminal.sessionId !== sessionId || terminal.exited) throw new Error("Терминал не найден");
      terminal.pendingInput += String(args.data ?? "");
      const end = Math.max(terminal.pendingInput.lastIndexOf("\r"), terminal.pendingInput.lastIndexOf("\n"));
      if (end >= 0) {
        const command = terminal.pendingInput.slice(0, end).trim();
        terminal.pendingInput = terminal.pendingInput.slice(end + 1);
        if (command.toLowerCase() === "exit") { terminal.exited = true; terminal.exitCode = 0; }
        else terminal.output += `fixture received: ${command}\r\n`;
      }
      return { written: true };
    }
    if (job.op === "terminalResize") return { resized: true };
    if (job.op === "terminalStop") {
      const terminal = fixtureTerminals.get(String(args.terminalId ?? ""));
      if (!terminal || terminal.sessionId !== sessionId) throw new Error("Терминал не найден");
      terminal.exited = true; terminal.exitCode = 0;
      return { stopped: true };
    }
    if (job.op === "createWorktree") {
      const source = sessions.find((session) => session.id === sessionId);
      const branch = String(args.branchName ?? "");
      if (!source) throw new Error("Сеанс не найден");
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(branch) || branch.includes("..") || branch.includes("//") || branch.endsWith("/")) throw new Error("Недопустимое имя ветки");
      const id = randomUUID();
      const path = source.cwd + "-worktrees/" + branch.replaceAll("/", "-");
      sessions.unshift({ ...source, id, title: `${branch} · рабочая копия`, cwd: path, updatedAt: Date.now(), source: "appServer" });
      history.set(id, []);
      selected = id;
      fixtureBranch = branch;
      return { sessionId: id, branch, path };
    }
    if (job.op === "forkThread") {
      const source = sessions.find((session) => session.id === sessionId);
      if (!source) throw new Error("Сеанс не найден");
      if (controlled.get(sessionId)?.busy) throw new Error("Нельзя ответвить сеанс, пока Codex выполняет задачу");
      const id = randomUUID();
      sessions.unshift({ ...source, id, title: `${source.title} · ответвление`, updatedAt: Date.now(), source: "appServer" });
      history.set(id, [...(history.get(sessionId) ?? [])]);
      controlled.set(id, { busy: false, queue: [], paused: false });
      selected = id;
      return { sessionId: id };
    }
    if (job.op === "steer") {
      const runtime = controlled.get(sessionId);
      if (!runtime?.busy) throw new Error("Нет активной задачи для направления");
      const entries = history.get(sessionId) ?? [];
      entries.push({ role: "user", text: "Направление: " + String(args.text ?? ""), timestamp: Date.now() });
      history.set(sessionId, entries);
      feed.publish(sessionId, { kind: "text", text: "Направление принято тестовой средой" });
      return { steered: true };
    }
    if (job.op === "renameThread") {
      const session = [...sessions, ...archivedSessions].find((entry) => entry.id === sessionId);
      if (!session) throw new Error("Сеанс не найден");
      session.title = String(args.name ?? "");
      return { sessionId, name: session.title };
    }
    if (job.op === "archiveThread") {
      const index = sessions.findIndex((entry) => entry.id === sessionId);
      if (index < 0) throw new Error("Активный сеанс не найден");
      archivedSessions.unshift({ ...sessions.splice(index, 1)[0]! });
      return { sessionId, archived: true };
    }
    if (job.op === "unarchiveThread") {
      const index = archivedSessions.findIndex((entry) => entry.id === sessionId);
      if (index < 0) throw new Error("Архивный сеанс не найден");
      sessions.unshift({ ...archivedSessions.splice(index, 1)[0]! });
      return { sessionId, archived: false };
    }
    if (job.op === "deleteThread") {
      if (fixtureDeleteFailure) throw new Error("Тестовая ошибка Codex: удаление заблокировано связанной историей");
      const index = archivedSessions.findIndex((entry) => entry.id === sessionId);
      if (index < 0) throw new Error("Архивный сеанс не найден");
      archivedSessions.splice(index, 1);
      history.delete(sessionId);
      controlled.delete(sessionId);
      fixtureBackgroundProcesses.delete(sessionId);
      return { sessionId, deleted: true };
    }
    if (job.op === "setGoal") {
      const previous = fixtureGoals.get(sessionId);
      const goal = {
        threadId: sessionId,
        objective: typeof args.objective === "string" ? args.objective : previous?.objective ?? "",
        status: args.status === "paused" ? "paused" as const : "active" as const,
        tokenBudget: args.tokenBudget === undefined ? previous?.tokenBudget ?? null : args.tokenBudget as number | null,
        tokensUsed: previous?.tokensUsed ?? 24,
        timeUsedSeconds: previous?.timeUsedSeconds ?? 15,
        createdAt: previous?.createdAt ?? Date.now() / 1000,
        updatedAt: Date.now() / 1000,
      };
      fixtureGoals.set(sessionId, goal);
      return { goal };
    }
    if (job.op === "clearGoal") { fixtureGoals.delete(sessionId); return { cleared: true }; }
    if (job.op === "setSkillEnabled") {
      const skill = fixtureSkills.find((entry) => entry.name === args.name);
      if (!skill?.canToggle || typeof args.enabled !== "boolean") throw new Error("Навык недоступен для изменения");
      skill.enabled = args.enabled;
      return { name: skill.name, enabled: skill.enabled };
    }
    if (job.op === "compactThread") {
      if (controlled.get(sessionId)?.busy) throw new Error("Нельзя сократить контекст, пока Codex выполняет задачу");
      feed.publish(sessionId, { kind: "activity", label: "Запрос на сокращение контекста принят тестовой средой" });
      return { started: true };
    }
    if (job.op === "installPlugin") {
      if (args.pluginId !== "reviewer@official" || args.marketplace !== "Fixture official") throw new Error("Плагин отсутствует в каталоге Codex");
      fixturePluginInstalled = true;
      return { installed: true, authorizationRequired: [{ id: "calendar", name: "Calendar connector", installUrl: "https://login.example.invalid/connect" }] };
    }
    if (job.op === "uninstallPlugin") {
      if (args.pluginId !== "reviewer@official" || !fixturePluginInstalled) throw new Error("Плагин не найден среди установленных");
      fixturePluginInstalled = false;
      return { uninstalled: true };
    }
    if (job.op === "mcpOAuthLogin") {
      if (args.name !== "fixture-mcp" || args.sessionId !== firstSession) throw new Error("MCP-сервер не найден в выбранном сеансе");
      fixtureMcpAuthorized = true;
      return { authorizationUrl: "https://login.example.invalid/oauth/fixture" };
    }
    if (job.op === "capabilities") return {
      online: true, ...fixtureSettings,
      models: [{ id: "fixture", name: "Fixture Model" }, { id: "fixture-fast", name: "Fixture Fast" }],
      modes: [{ id: "code", name: "Code" }, { id: "plan", name: "Plan" }],
      reasoningLevels: ["minimal", "low", "medium", "high", "max"],
      skills: fixtureSkills.map((skill) => ({ ...skill })),
      mcpServersAvailable: true,
      mcpServers: [{
        name: "fixture-mcp", status: fixtureMcpAuthorized ? "connected" : "authenticationRequired",
        authStatus: fixtureMcpAuthorized ? "oauth" : "notLoggedIn", serverName: "Fixture MCP server",
        serverVersion: "1.0", tools: [
          { name: "read_status", description: "Read a safe fixture status." },
          { name: "host_info", description: "Text only: <script>alert(1)</script>." },
        ], toolCount: 2, resourceCount: 1, resourceTemplateCount: 0, discoveryFailed: false,
      }],
      plugins: [{ id: "reviewer@official", name: "Review helper", marketplace: "Fixture official",
        description: "Показывает результаты ревью изменений.", capabilities: ["review", "summaries"], sourceType: "remote",
        installed: fixturePluginInstalled, enabled: true, installable: !fixturePluginInstalled,
        installPolicy: "AVAILABLE", availability: "AVAILABLE", mustShowInstallationInterstitial: false }],
      pluginCatalogAvailable: true,
      apps: [{ id: "calendar", name: "Calendar connector", description: "Fixture connection status only.",
        enabled: true, accessible: false, callable: false, installUrl: "https://login.example.invalid/connect" }],
      appsAvailable: true,
      account: { type: "chatgpt", email: "fixture@example.invalid", plan: "fixture" },
      limits: [{ id: "fixture", name: "Тестовый период", primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 } }],
      subagents: [{ id: "fixture-agent", name: "Fixture Agent", status: "running" }],
      goal: fixtureGoals.get(sessionId), goalAvailable: true, checkedAt: Date.now(),
    };
    if (job.op === "files") {
      const path = String(args.path ?? "");
      const prefix = path ? `${path}/` : "";
      const children = new Map<string, { name: string; kind: "directory" | "file"; size?: number; mtimeMs?: number }>();
      for (const [filePath, text] of fixtureFiles) {
        if (!filePath.startsWith(prefix)) continue;
        const remainder = filePath.slice(prefix.length);
        if (!remainder) continue;
        const slash = remainder.indexOf("/");
        const name = slash < 0 ? remainder : remainder.slice(0, slash);
        if (slash >= 0) children.set(name, { name, kind: "directory" });
        else children.set(name, { name, kind: "file", size: filePath === "assets/preview.png" ? 75 : Buffer.byteLength(text), mtimeMs: Date.now() });
      }
      const entries = [...children.values()].sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1);
      return { project: "codex-mobile", path, entries };
    }
    if (job.op === "readFile") {
      const path = String(args.path ?? "");
      const text = fixtureFiles.get(path);
      if (text === undefined) throw new Error("Файл не найден");
      return { project: "codex-mobile", path, text, size: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
    }
    if (job.op === "readImage") {
      if (args.path !== "assets/preview.png") throw new Error("Неподдерживаемый формат изображения");
      return { project: "codex-mobile", path: "assets/preview.png", name: "preview.png", mime: "image/png", size: 75,
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/x6kAAAAASUVORK5CYII=" };
    }
    if (job.op === "writeFile") {
      const path = String(args.path ?? "");
      const current = fixtureFiles.get(path);
      if (current === undefined || createHash("sha256").update(current).digest("hex") !== args.expectedHash) throw new Error("Файл изменился");
      fixtureFiles.set(path, String(args.content ?? ""));
      return { path, sha256: createHash("sha256").update(fixtureFiles.get(path)!).digest("hex"), savedAt: Date.now() };
    }
    if (job.op === "createFile") {
      const path = String(args.path ?? "");
      if (!path || fixtureFiles.has(path)) throw new Error("Файл уже существует");
      fixtureFiles.set(path, String(args.content ?? ""));
      return { path, sha256: createHash("sha256").update(fixtureFiles.get(path)!).digest("hex"), savedAt: Date.now() };
    }
    if (job.op === "gitStatus") return {
      project: "codex-mobile", branch: fixtureBranch, branches: [...new Set([fixtureBranch, "main", "release/candidate"])], remoteBranches: ["origin/mobile/feature"],
      remotes: [{ name: "origin", fetchTargets: ["github.com"], pushTargets: ["github.com"] }], clean: false,
      changes: [
        ...(!fixtureStaged.has("src/main.ts") ? [{ code: "M", indexStatus: " ", worktreeStatus: "M", path: "src/main.ts" }] : []),
        ...(!fixtureNotesCommitted ? (!fixtureStaged.has("notes/review.md") ? [{ code: "??", indexStatus: "?", worktreeStatus: "?", path: "notes/review.md" }] : [{ code: "A", indexStatus: "A", worktreeStatus: " ", path: "notes/review.md" }]) : []),
        ...(fixtureRenameStaged ? [{ code: "R", indexStatus: "R", worktreeStatus: " ", path: "src/renamed.ts", previousPath: "src/old-main.ts" }]
          : fixtureStaged.has("src/old-main.ts") && fixtureStaged.has("src/renamed.ts")
            ? [{ code: "R", indexStatus: "R", worktreeStatus: " ", path: "src/renamed.ts", previousPath: "src/old-main.ts" }]
            : [{ code: fixtureStaged.has("src/old-main.ts") ? "D" : "D", indexStatus: fixtureStaged.has("src/old-main.ts") ? "D" : " ", worktreeStatus: fixtureStaged.has("src/old-main.ts") ? " " : "D", path: "src/old-main.ts" },
              { code: fixtureStaged.has("src/renamed.ts") ? "A" : "??", indexStatus: fixtureStaged.has("src/renamed.ts") ? "A" : "?", worktreeStatus: fixtureStaged.has("src/renamed.ts") ? " " : "?", path: "src/renamed.ts" }]),
      ], checkedAt: Date.now(),
    };
    if (job.op === "gitDiff") {
      const selectedPath = String(args.path ?? "");
      const renameSelected = selectedPath === "src/renamed.ts" || args.previousPath === "src/old-main.ts";
      const mainDiff = "diff --git a/src/main.ts b/src/main.ts\nindex 1111111..2222222 100644\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1,3 +1,3 @@\n-export const answer = 42;\n+export const answer = 43;\n";
      return {
        project: "codex-mobile",
        unstaged: (!selectedPath || selectedPath === "src/main.ts") ? mainDiff : "",
        staged: !selectedPath
          ? fixtureStaged.has("notes/review.md") ? "diff --git a/notes/review.md b/notes/review.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes/review.md\n@@ -0,0 +1 @@\n+Review fixture\n" : fixtureRenameStaged ? "diff --git a/src/old-main.ts b/src/renamed.ts\nsimilarity index 100%\nrename from src/old-main.ts\nrename to src/renamed.ts\n" : ""
          : renameSelected && fixtureRenameStaged ? "diff --git a/src/old-main.ts b/src/renamed.ts\nsimilarity index 100%\nrename from src/old-main.ts\nrename to src/renamed.ts\n" : selectedPath === "notes/review.md" && fixtureStaged.has("notes/review.md") ? "diff --git a/notes/review.md b/notes/review.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes/review.md\n@@ -0,0 +1 @@\n+Review fixture\n" : "",
        checkedAt: Date.now(),
      };
    }
    if (job.op === "gitStage") { fixtureStaged.add(String(args.path)); return { path: args.path, staged: true }; }
    if (job.op === "gitUnstage") {
      if (typeof args.previousPath === "string") {
        fixtureRenameStaged = false;
        fixtureStaged.delete("src/old-main.ts");
        fixtureStaged.delete("src/renamed.ts");
      }
      else fixtureStaged.delete(String(args.path));
      return { path: args.path, staged: false };
    }
    if (job.op === "gitCommit") {
      if (!fixtureStaged.size) throw new Error("Нет подготовленных изменений для коммита");
      const message = String(args.message ?? ""); fixtureStaged.clear(); fixtureNotesCommitted = true;
      return { commit: "abc1234", message, branch: fixtureBranch };
    }
    if (job.op === "gitCreateBranch") {
      const branch = String(args.name ?? "");
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes("..") || branch.includes("//") || branch.endsWith("/")) {
        throw new Error(`fatal: '${branch}' is not a valid branch name`);
      }
      fixtureBranch = branch;
      return { branch: fixtureBranch };
    }
    if (job.op === "gitSwitchBranch") {
      const branch = String(args.name ?? "");
      if (![fixtureBranch, "main", "release/candidate"].includes(branch)) throw new Error("Не удалось найти ветку в этом проекте");
      fixtureBranch = branch;
      return { branch: fixtureBranch };
    }
    if (job.op === "gitTrackRemoteBranch") {
      if (args.remoteBranch !== "origin/mobile/feature") throw new Error("Удалённая ветка не найдена среди уже загруженных ссылок");
      fixtureBranch = "mobile/feature";
      return { branch: fixtureBranch, upstream: String(args.remoteBranch) };
    }
    if (job.op === "gitFetch") {
      if (args.remoteName !== "origin") throw new Error("Удалённый репозиторий не найден");
      return { remoteName: "origin", fetched: true };
    }
    if (job.op === "gitPush") {
      if (args.remoteName !== "origin") throw new Error("Удалённый репозиторий не найден");
      return { remoteName: "origin", branch: fixtureBranch };
    }
    if (job.op === "setModel") fixtureSettings.model = String(args.modelId);
    else if (job.op === "setMode") fixtureSettings.mode = String(args.modeId);
    else if (job.op === "setReasoning") fixtureSettings.reasoning = String(args.effort);
    return { ok: true };
  },
};

const mobileApprovals = new MobileApprovalBroker(
    feed as unknown as TmaLiveFeed,
    { ownerChatForSession: (id: string) => sessions.some((session) => session.id === id) ? ownerId : undefined } as unknown as RuntimeRegistry,
    new Set([String(ownerId)]),
    async () => ({ outcome: { outcome: "cancelled" } }),
  );
const server: Server = createMobileServer({
  auth, agent, feed: feed as unknown as TmaLiveFeed, approvals: mobileApprovals, dataDir,
  staticRoot: resolve("apps/codex-mobile/dist"), port: 0,
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("Не удалось открыть тестовый HTTP сервер");
const port = address.port;
const laptopPairing = auth.beginPairing("Browser QA Laptop");
auth.approvePairing(laptopPairing.code, ownerId);
auth.completePairing(laptopPairing.pairingCookie);
const browserPairing = auth.beginPairing("Browser QA Mobile");
auth.approvePairing(browserPairing.code, ownerId);
const browserLogin = auth.completePairing(browserPairing.pairingCookie);
if (!browserLogin || browserLogin.status !== "approved") throw new Error("Не удалось создать тестовый вход для браузера");
const browserBootstrap: Server = createServer((_req, res) => {
  res.statusCode = 302;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Location", "http://127.0.0.1:" + port + "/");
  res.setHeader("Set-Cookie", [
    `__Host-codex-mobile-session=${browserLogin.cookieValue}; Path=/; Secure; HttpOnly; SameSite=Strict`,
    `__Host-codex-mobile-csrf=${browserLogin.csrfToken}; Path=/; Secure; SameSite=Strict`,
  ]);
  res.end();
});
browserBootstrap.listen(0, "127.0.0.1");
await once(browserBootstrap, "listening");
const bootstrapAddress = browserBootstrap.address();
if (!bootstrapAddress || typeof bootstrapAddress === "string") throw new Error("Не удалось открыть тестовый bootstrap");
process.stdout.write(JSON.stringify({
  origin: "http://127.0.0.1:" + port,
  bootstrapOrigin: "http://127.0.0.1:" + bootstrapAddress.port,
  port,
  instanceDir,
  dataDir,
  firstSession,
}) + "\n");

let inputBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  inputBuffer += chunk;
  const lines = inputBuffer.split(/\r?\n/);
  inputBuffer = lines.pop() ?? "";
  for (const line of lines) {
    try {
      const command = JSON.parse(line) as { command?: string };
      if (command.command === "approval") {
        void mobileApprovals.handle({
          sessionId: firstSession,
          toolCall: { title: "git status", kind: "execute" },
          options: [{ optionId: "accept", name: "Разрешить один раз" }, { optionId: "decline", name: "Отклонить" }],
          reason: "Нужен доступ для выполнения команды проверки.",
        }).then((result) => process.stdout.write(JSON.stringify({ fixtureApprovalResult: result }) + "\n"));
      } else if (command.command === "backgroundTerminalsError") {
        fixtureBackgroundTerminalFailure = true;
        process.stdout.write("Fixture background terminal errors enabled.\n");
      } else if (command.command === "backgroundTerminalsReset") {
        fixtureBackgroundTerminalFailure = false;
        process.stdout.write("Fixture background terminal errors disabled.\n");
      } else if (command.command === "turnEditUnavailable") {
        fixtureEditUnavailable = true;
        process.stdout.write("Fixture turn edit is unavailable because of an attachment.\n");
      } else if (command.command === "turnEditReset") {
        fixtureEditUnavailable = false;
        process.stdout.write("Fixture turn edit is available.\n");
      } else if (command.command === "turnEditError") {
        fixtureEditFailure = true;
        process.stdout.write("Fixture turn edit failure enabled.\n");
      } else if (command.command === "transcriptionError") {
        fixtureTranscriptionFailure = true;
        process.stdout.write("Fixture transcription failure enabled.\n");
      } else if (command.command === "transcriptionReset") {
        fixtureTranscriptionFailure = false;
        process.stdout.write("Fixture transcription failure disabled.\n");
      } else if (command.command === "deleteThreadError") {
        fixtureDeleteFailure = true;
        process.stdout.write("Fixture Codex deletion error enabled.\n");
      } else if (command.command === "deleteThreadReset") {
        fixtureDeleteFailure = false;
        process.stdout.write("Fixture Codex deletion error disabled.\n");
      }
    } catch { process.stdout.write("Fixture control command was ignored.\n"); }
  }
});

async function shutdown() {
  voiceAgent.stop();
  browserBootstrap.closeAllConnections();
  await new Promise<void>((resolveClose) => browserBootstrap.close(() => resolveClose()));
  server.closeAllConnections();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await rm(instanceDir, { recursive: true, force: true });
}
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
