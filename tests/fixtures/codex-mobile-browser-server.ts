import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "node:http";
import { MobileAuthStore } from "../../src/mobile/auth.js";
import { getOrCreateMobileAdminToken } from "../../src/mobile/control.js";
import { createMobileServer } from "../../src/mobile/server.js";
import { MobileApprovalBroker } from "../../src/mobile/approvals.js";
import type { LiveEvent, TmaLiveFeed } from "../../src/tma/live.js";
import type { TmaJob } from "../../src/tma/protocol.js";
import type { RuntimeRegistry } from "../../src/bot/registry.js";

const ownerId = 101;
const firstSession = "11111111-1111-4111-8111-111111111111";
const secondSession = "22222222-2222-4222-8222-222222222222";
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
const adminToken = await getOrCreateMobileAdminToken(dataDir);
const sessions = [
  { id: firstSession, title: "Разобрать приложение", cwd: projectOne, updatedAt: Date.now(), source: "appServer" },
  { id: secondSession, title: "Проверить API", cwd: projectOne, updatedAt: Date.now() - 10_000, source: "cli" },
  { id: "33333333-3333-4333-8333-333333333333", title: "Другой проект", cwd: projectTwo, updatedAt: Date.now() - 20_000, source: "vscode" },
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
const fixtureStaged = new Set<string>();
let fixtureBranch = "feat/codex-mobile-fixture";
let fixtureNotesCommitted = false;
let fixtureRenameStaged = true;
const fixtureFiles = new Map<string, string>([
  ["README.md", "# Fixture project\n\nRead-only history is followed by mobile file access.\n"],
  ["src/main.ts", "export function greet() {\n  return \"Hello from fixture\";\n}\n"],
]);

const agent = {
  async canReadSession(sessionId: string, id: number) {
    return id === ownerId && sessions.some((session) => session.id === sessionId);
  },
  async execute(job: TmaJob): Promise<unknown> {
    const args = job.args;
    if (job.op === "snapshot") {
      return {
        projects: [{ path: projectOne, name: "codex-mobile" }, { path: projectTwo, name: "other-project" }],
        sessions: sessions.map((session) => {
          const runtime = controlled.get(session.id);
          return { ...session, busy: runtime?.busy ?? false, queue: runtime?.queue.length ?? 0 };
        }),
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
      const entries = history.get(sessionId) ?? [];
      entries.push({ role: "user", text: message || "Проверка фото", timestamp: Date.now() });
      entries.push({ role: "assistant", text: "Задание принято из тестовой среды. Настоящий Codex не запускался.", timestamp: Date.now() });
      history.set(sessionId, entries);
      const runtime = controlled.get(sessionId) ?? { busy: false, queue: [], paused: false };
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
    if (job.op === "capabilities") return {
      online: true, ...fixtureSettings,
      models: [{ id: "fixture", name: "Fixture Model" }, { id: "fixture-fast", name: "Fixture Fast" }],
      modes: [{ id: "code", name: "Code" }, { id: "plan", name: "Plan" }],
      reasoningLevels: ["minimal", "low", "medium", "high", "max"],
      skills: [{ name: "Fixture skill", description: "Навык для проверки. <script>alert(1)</script> остаётся текстом." }],
      mcpServers: [{ name: "Fixture MCP", toolCount: 2 }],
      account: { type: "chatgpt", email: "fixture@example.invalid", plan: "fixture" },
      limits: [{ id: "fixture", name: "Тестовый период", primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 } }],
      subagents: [{ id: "fixture-agent", name: "Fixture Agent", status: "running" }], checkedAt: Date.now(),
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
        else children.set(name, { name, kind: "file", size: Buffer.byteLength(text), mtimeMs: Date.now() });
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
      project: "codex-mobile", branch: fixtureBranch, branches: [...new Set([fixtureBranch, "main", "release/candidate"])], clean: false,
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
  auth, agent, feed: feed as unknown as TmaLiveFeed, approvals: mobileApprovals, adminToken, dataDir,
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
process.stdout.write(JSON.stringify({ origin: "http://127.0.0.1:" + port, port, instanceDir, dataDir, firstSession }) + "\n");

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
      }
    } catch { process.stdout.write("Fixture control command was ignored.\n"); }
  }
});

async function shutdown() {
  server.closeAllConnections();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await rm(instanceDir, { recursive: true, force: true });
}
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
