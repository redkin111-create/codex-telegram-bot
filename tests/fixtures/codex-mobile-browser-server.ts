import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { deflateSync } from "node:zlib";
import { MobileAuthStore } from "../../src/mobile/auth.js";
import type { MobilePromptAttachment } from "../../src/mobile/attachments.js";
import { createMobileServer } from "../../src/mobile/server.js";
import { requestedMobileSkillNames } from "../../src/mobile/skill-selection.js";
import { MobileApprovalBroker, MobileElicitationBroker } from "../../src/mobile/approvals.js";
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
function pngCrc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const payload = Buffer.concat([name, data]);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(pngCrc32(payload));
  return Buffer.concat([length, payload, checksum]);
}

function makeFixtureScreenshot(): Buffer {
  const width = 320;
  const height = 180;
  const stride = width * 4 + 1;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    pixels[row] = 0;
    for (let x = 0; x < width; x++) {
      const pixel = row + 1 + x * 4;
      const inHeader = y < 28;
      const inLeftPanel = x < 214;
      const dx = x - 118;
      const dy = y - 108;
      const inCircle = dx * dx + dy * dy < 32 * 32;
      const color = inHeader ? [18, 25, 21] : inCircle ? [215, 166, 75] : inLeftPanel ? [55, 91, 67] : [51, 61, 55];
      pixels[pixel] = color[0]!;
      pixels[pixel + 1] = color[1]!;
      pixels[pixel + 2] = color[2]!;
      pixels[pixel + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const fixtureScreenshotData = makeFixtureScreenshot();
const fixtureScreenshots = [
  { path: screenshotPath, name: "sample.png", mtimeMs: 1, size: fixtureScreenshotData.byteLength },
  ...Array.from({ length: 399 }, (_, index) => {
    const n = index + 2;
    const name = `capture-${String(n).padStart(3, "0")}.png`;
    return { path: `C:\\fixture\\codex-mobile\\screenshots\\${name}`, name, mtimeMs: n, size: fixtureScreenshotData.byteLength };
  }),
];
const recentFixtureScreenshots = fixtureScreenshots.slice(-256);
const fixturePinnedSection = { id: "01984de2-8f74-7c91-a3b2-5c5e937cf318", name: "Закреплённые", builtIn: true };
const fixtureSectionsAvailable = process.env.CODEX_MOBILE_FIXTURE_SECTIONS_UNAVAILABLE !== "1";
const fixtureCompactionUnconfirmed = process.env.CODEX_MOBILE_FIXTURE_COMPACTION_UNCONFIRMED === "1";
const fixtureGitPullEnabled = process.env.CODEX_MOBILE_FIXTURE_GIT_PULL === "1";
const fixtureSections = [{ id: "88888888-8888-4888-8888-888888888888", name: "В работе" }];
type FixtureSession = { id: string; title: string; cwd: string; updatedAt: number; source: string; section?: { id: string; name: string; builtIn?: boolean }; ephemeral?: boolean; parentThreadId?: string };

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
const fixtureHost = process.env.CODEX_MOBILE_FIXTURE_HOST ?? "127.0.0.1";
if (fixtureHost !== "127.0.0.1" && fixtureHost !== "phone.localhost") {
  throw new Error("Browser fixture host must be a loopback address");
}
const fixtureMcpOAuthMode = process.env.CODEX_MOBILE_FIXTURE_MCP_OAUTH_MODE ?? "exact";
if (fixtureMcpOAuthMode !== "exact" && fixtureMcpOAuthMode !== "par") {
  throw new Error("Browser fixture MCP OAuth mode must be exact or par");
}
async function reserveLoopbackPort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Не удалось выбрать порт тестового HTTP сервера");
  const port = address.port;
  probe.close();
  await once(probe, "close");
  return port;
}
const dataDir = join(instanceDir, "data");
const auth = new MobileAuthStore(dataDir, { allowedOwners: new Set([String(ownerId)]) });
const feed = new FixtureFeed();
const sessions: FixtureSession[] = [
  { id: firstSession, title: "Разобрать приложение", cwd: projectOne, updatedAt: Date.now(), source: "appServer", section: fixtureSections[0] },
  { id: secondSession, title: "Проверить API", cwd: projectOne, updatedAt: Date.now() - 10_000, source: "cli" },
  { id: "33333333-3333-4333-8333-333333333333", title: "Другой проект", cwd: projectTwo, updatedAt: Date.now() - 20_000, source: "vscode" },
  { id: "55555555-5555-4555-8555-555555555555", title: "Legacy Codex architecture", cwd: projectOne, updatedAt: Date.now() - 40_000, source: "cli" },
  { id: "66666666-6666-4666-8666-666666666666", title: "Legacy Codex integration", cwd: projectOne, updatedAt: Date.now() - 50_000, source: "appServer" },
];
const archivedSessions: FixtureSession[] = [
  { id: archivedFixtureSession, title: "Старый архивный сеанс", cwd: projectOne, updatedAt: Date.now() - 30_000, source: "appServer" },
  { id: olderArchivedFixtureSession, title: "Ещё один архивный сеанс", cwd: projectOne, updatedAt: Date.now() - 60_000, source: "cli" },
];
const fixtureReadStates = new Map<string, { firstUnread: null | { type: "threadStart" } | { type: "turn"; turnId: string }; revision: string }>([
  [firstSession, { firstUnread: { type: "turn", turnId: "fixture-unread-turn" }, revision: "fixture-rev-1" }],
  [secondSession, { firstUnread: null, revision: "fixture-rev-1" }],
]);
let fixtureReadStateConflict = process.env.CODEX_MOBILE_FIXTURE_READ_STATE_CONFLICT === "1";
const history = new Map<string, Array<{ role: "user" | "assistant" | "tool"; text: string; tool?: string; timestamp: number }>>([
  [firstSession, [
    { role: "user", text: "Старый запрос: добавь функцию приветствия.", timestamp: Date.now() - 90_000 },
    { role: "assistant", text: "В тестовом проекте появилась функция приветствия.", timestamp: Date.now() - 85_000 },
    { role: "user", text: "Проверь экран Codex Mobile и сообщи, что видишь.", timestamp: Date.now() - 70_000 },
    { role: "assistant", text: "## Проверка готова\n\n- История загружена\n- **Безопасная разметка**\n\n[небезопасная ссылка](javascript:alert(1)) <img src=x onerror=alert(1)>", timestamp: Date.now() - 60_000 },
    { role: "assistant", text: 'Ревью завершено.\n\n::code-comment{title="[P1] Не исполнять недоверенный текст" body="Этот текст содержит <img src=x onerror=alert(1)> и должен оставаться текстом." file="src/main.ts" start=1 end=1 priority=1}', timestamp: Date.now() - 58_000 },
    { role: "tool", tool: "read_file", text: "Секретный вывод инструмента для теста.\nВ браузере показывается только по запросу.", timestamp: Date.now() - 55_000 },
  ]],
  [secondSession, [{ role: "assistant", text: "API fixture для переключения сеанса.", timestamp: Date.now() - 15_000 }]],
]);
const controlled = new Map<string, { busy: boolean; queue: Array<{ id: string; text: string }>; paused: boolean }>();
let selected = firstSession;
const fixtureSettings = { model: "fixture", mode: "code", reasoning: "medium" };
const fixtureGoals = new Map<string, { threadId: string; objective: string; status: "active" | "paused"; tokenBudget: number | null; tokensUsed: number; timeUsedSeconds: number; createdAt: number; updatedAt: number }>();
const fixtureStaged = new Set<string>();
let fixtureConflictResolved = false;
let fixtureBinaryConflictResolved = false;
let fixtureBranch = fixtureGitPullEnabled ? "mobile/feature" : "feat/codex-mobile-fixture";
let fixtureGitPullCount = 0;
let fixtureNotesCommitted = false;
let fixtureRenameStaged = true;
let fixturePluginInstalled = false;
let fixturePluginEnabled = true;
let fixtureMarketplaces = [
  { name: "Fixture official", pluginCount: 2, installedPluginCount: 1, manageable: true },
  { name: "Built-in catalog", pluginCount: 4, installedPluginCount: 0, manageable: false },
];
let fixtureMcpAuthorized = false;
const fixtureMcpOAuthState = "codex-mobile-fixture-oauth-state";
const mcpOAuthCallbackServer = createServer((req, res) => {
  const callback = new URL(req.url ?? "/", "http://127.0.0.1");
  if (callback.pathname !== "/callback/fixture-id" || callback.searchParams.get("state") !== fixtureMcpOAuthState || !callback.searchParams.get("code")) {
    res.statusCode = 400;
    res.end("Invalid fixture callback");
    return;
  }
  fixtureMcpAuthorized = true;
  feed.publish(firstSession, { kind: "activity", label: "Вход в MCP-сервер fixture-mcp выполнен" });
  res.statusCode = 200;
  res.end("Authentication complete");
});
mcpOAuthCallbackServer.listen(0, "127.0.0.1");
await once(mcpOAuthCallbackServer, "listening");
const mcpOAuthCallbackAddress = mcpOAuthCallbackServer.address();
if (!mcpOAuthCallbackAddress || typeof mcpOAuthCallbackAddress === "string") throw new Error("Не удалось открыть фиктивный OAuth callback");
const fixtureCapabilitiesFailOnCall = Number.parseInt(process.env.CODEX_MOBILE_FIXTURE_CAPABILITIES_FAIL_ON_CALL ?? "0", 10);
let fixtureCapabilitiesCalls = 0;
const fixtureSkills = [
  { name: "browser-skill", description: "Тестовый навык управления браузером. Эта запись не подключает и не запускает реальный браузерный сценарий.", enabled: true, scope: "user" as const, canToggle: true, invokable: true },
  { name: "fixture-review", description: "Навык для проверки. <script>alert(1)</script> остаётся текстом.", enabled: true, scope: "user" as const, canToggle: true, invokable: true },
  { name: "disabled-helper", description: "Отключённый навык.", enabled: false, scope: "repo" as const, canToggle: true, invokable: false },
  { name: "managed-skill", description: "Управляется политикой.", enabled: true, scope: "admin" as const, canToggle: false, invokable: true },
];
type FixtureMcpConfigEntry = { name: string; scope: "global" | "workspace"; enabled: boolean; transport: "http" | "stdio"; effective: boolean };
const fixtureMcpConfig: FixtureMcpConfigEntry[] = [
  { name: "fixture-git", scope: "global" as const, enabled: true, transport: "http" as const, effective: false },
  { name: "fixture-git", scope: "workspace" as const, enabled: true, transport: "stdio" as const, effective: true },
  { name: "fixture-search", scope: "global" as const, enabled: false, transport: "http" as const, effective: true },
];
const fixtureTerminals = new Map<string, { sessionId: string; output: string; pendingInput: string; exited: boolean; exitCode: number | null; }>();
const fixtureTerminalBySession = new Map<string, string>();
const fixtureBackgroundProcesses = new Map<string, Array<{ itemId: string; processId: string }>>([
  [firstSession, [{ itemId: "fixture-command-item", processId: "4242" }]],
]);
let fixtureBackgroundTerminalFailure = false;
let fixtureLatestTurnId = "11111111-1111-4111-8111-111111111111";
let fixtureTurnIds = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", fixtureLatestTurnId];
let fixtureEditUnavailable = process.env.CODEX_MOBILE_FIXTURE_EDIT_UNAVAILABLE === "1";
let fixtureEditWithImages = process.env.CODEX_MOBILE_FIXTURE_EDIT_WITH_IMAGES === "1";
let fixtureEditFailure = false;
let fixtureTranscriptionFailure = false;
let fixtureDeleteFailure = false;
let fixtureSectionDeleteFailure = false;
const fixtureFiles = new Map<string, string>([
  ["README.md", "# Fixture project\n\nRead-only history is followed by mobile file access.\n"],
  ["src/main.ts", "export function greet() {\n  return \"Hello from fixture\";\n}\n"],
  ["src/conflict.ts", "<<<<<<< HEAD\nexport const greeting = \"Hello\";\n=======\nexport const greeting = \"Hi\";\n>>>>>>> feature/greeting\n"],
  ["assets/preview.png", "fixture raster preview"],
  ["assets/release.zip", "PK\u0003\u0004fixture archive bytes"],
]);
const fixtureDirectories = new Set<string>(["src", "assets"]);
fixtureDirectories.add("bulk");
for (let index = 0; index < 260; index++) {
  fixtureFiles.set(`bulk/file-${String(index).padStart(3, "0")}.txt`, `Fixture entry ${index}`);
}

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
  async execute(job: TmaJob, attachments: readonly MobilePromptAttachment[] = []): Promise<unknown> {
    const args = job.args;
    if (job.op === "snapshot") {
      return {
        projects: [...new Map([
          [projectOne, "codex-mobile"], [projectTwo, "other-project"],
          ...sessions.filter((session) => session.cwd !== projectOne && session.cwd !== projectTwo).map((session) => [session.cwd, session.title.split(" · ")[0] ?? session.title] as [string, string]),
        ]).entries()].map(([path, name]) => ({ path, name })),
        sessions: sessions.slice(0, 3).map((session) => {
          const runtime = controlled.get(session.id);
          return { ...session, section: session.section ?? null, archived: false, busy: runtime?.busy ?? false, queue: runtime?.queue.length ?? 0 };
        }),
        archivedSessions: archivedSessions.slice(0, 1).map((session) => ({ ...session, section: session.section ?? null, archived: true, busy: false, queue: 0 })),
        sectionsAvailable: fixtureSectionsAvailable,
        sections: fixtureSectionsAvailable ? [{ ...fixturePinnedSection }, ...fixtureSections.map((section) => ({ ...section, builtIn: false }))] : [],
        archiveAvailable: true,
        selected, controlled: [...controlled].map(([id, runtime]) => ({ id, busy: runtime.busy, queue: runtime.queue.length, paused: runtime.paused })),
        online: true, model: "fixture", models: [{ id: "fixture", name: "Fixture" }],
      };
    }
    const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
    if (job.op === "history") {
      const entries = history.get(sessionId) ?? [];
      return { entries: entries.filter((entry) => args.includeTools === true || entry.role !== "tool"), images: sessionId === firstSession ? recentFixtureScreenshots : [], project: projectOne };
    }
    if (job.op === "activity") {
      return { busy: controlled.get(sessionId)?.busy ?? false, queue: controlled.get(sessionId)?.queue.length ?? 0,
        images: sessionId === firstSession ? recentFixtureScreenshots : [] };
    }
    if (job.op === "image") {
      return { mime: "image/png", name: "Тестовый скриншот Codex.png",
        data: fixtureScreenshotData.toString("base64") };
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
      const appIds = Array.isArray(args.appIds) ? args.appIds.filter((id): id is string => typeof id === "string") : [];
      if (appIds.some((id) => id !== "calendar")) throw new Error("Fixture Codex App недоступно");
      const fileContext = attachments.map((file) => file.text !== undefined
        ? `\n\nВложенный файл «${file.name}»:\n${file.text}`
        : `\n\nВложенный файл «${file.name}» сохранён по пути: ${file.path ?? "недоступен"}.`).join("");
      const appMentions = appIds.length ? `${appIds.map((id) => id === "calendar" ? "$calendar-connector" : `$${id}`).join(" ")}\n\n` : "";
      const message = `${appMentions}${String(args.text ?? "")}${fileContext}`.trim();
      const requestedSkills = requestedMobileSkillNames(String(args.text ?? ""), fixtureSkills.filter((skill) => skill.enabled && skill.invokable).map((skill) => skill.name));
      const runtime = controlled.get(sessionId) ?? { busy: false, queue: [], paused: false };
      if (runtime.busy) {
        runtime.queue.push({ id: randomUUID(), text: message || "Проверить прикреплённое фото" });
        controlled.set(sessionId, runtime);
        return { result: "queued" };
      }
      const entries = history.get(sessionId) ?? [];
      entries.push({ role: "user", text: message || "Проверка фото", timestamp: Date.now() });
      entries.push({ role: "assistant", text: requestedSkills.length
        ? `Тестовая среда получила навыки Codex: ${requestedSkills.join(", ")}. Настоящий Codex не запускался.`
        : "Задание принято из тестовой среды. Настоящий Codex не запускался.", timestamp: Date.now() });
      history.set(sessionId, entries);
      fixtureLatestTurnId = randomUUID();
      fixtureTurnIds.push(fixtureLatestTurnId);
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
    if (job.op === "listOlderScreenshots") {
      if (job.userId !== ownerId || !sessions.some((session) => session.id === sessionId)) throw new Error("Доступ к сеансу запрещён");
      if (sessionId !== firstSession) return { images: [] };
      const older = fixtureScreenshots.slice(0, 144);
      if (args.beforeOffset === 64) return { images: older.slice(0, 64) };
      if (args.beforeOffset !== undefined) throw new Error("Некорректный указатель страницы скриншотов");
      return { images: older.slice(-80), nextCursor: 64 };
    }
    if (job.op === "searchHistory") {
      if (job.userId !== ownerId || !sessions.some((session) => session.id === sessionId)) throw new Error("Доступ к сеансу запрещён");
      const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      const matches = Array.from({ length: 101 }, (_, index) => ({ role: "assistant" as const, text: `Найдено в старой части истории: полный поиск fixture #${String(index).padStart(3, "0")}`, timestamp: Date.now() - 86_400_000 + index }));
      const allMatches = matches[0]!.text.toLowerCase().includes(query) ? matches : [];
      const beforeOffset = typeof args.beforeOffset === "number" ? args.beforeOffset : undefined;
      const entries = beforeOffset === 1 ? allMatches.slice(0, 1) : allMatches.slice(-100);
      const startOffset = beforeOffset === 1 ? 0 : Math.max(allMatches.length - entries.length, 0);
      return { entries, total: allMatches.length, skippedLargeRecords: 0, startOffset, ...(startOffset > 0 ? { nextOffset: startOffset } : {}), revision: "0123456789abcdef" };
    }
    if (job.op === "listThreadReadStates") {
      if (job.userId !== ownerId || !Array.isArray(args.sessionIds) || args.sessionIds.length > 1000) throw new Error("Доступ к сеансу запрещён");
      const states: Record<string, { firstUnread: null | { type: "threadStart" } | { type: "turn"; turnId: string }; revision: string }> = {};
      for (const id of args.sessionIds) {
        if (typeof id === "string" && [...sessions, ...archivedSessions].some((session) => session.id === id)) {
          const state = fixtureReadStates.get(id);
          if (state) states[id] = state;
        }
      }
      return { states };
    }
    if (job.op === "updateThreadReadState") {
      if (job.userId !== ownerId || ![...sessions, ...archivedSessions].some((session) => session.id === sessionId)) throw new Error("Доступ к сеансу запрещён");
      const state = fixtureReadStates.get(sessionId);
      if (!state) throw new Error("Codex не предоставляет управление статусом прочтения для этого сеанса");
      if (fixtureReadStateConflict) {
        fixtureReadStateConflict = false;
        const nextRevision = Number.parseInt(state.revision.split("-").at(-1) ?? "1", 10) + 1;
        fixtureReadStates.set(sessionId, { ...state, revision: `fixture-rev-${nextRevision}` });
        throw new Error("Статус прочтения изменился в Codex Desktop. Обновите список сеансов.");
      }
      if (args.expectedRevision !== state.revision) throw new Error("Статус прочтения изменился. Обновите список сеансов и повторите действие.");
      if (args.operation !== "read" && args.operation !== "unread") throw new Error("Неизвестное действие со статусом прочтения");
      const updated = {
        firstUnread: args.operation === "read" ? null : { type: "threadStart" as const },
        revision: `fixture-rev-${Number.parseInt(state.revision.split("-").at(-1) ?? "1", 10) + 1}`,
      };
      fixtureReadStates.set(sessionId, updated);
      return { sessionId, readState: updated };
    }
    if (job.op === "listThreadSections") return fixtureSections.map((section) => ({ ...section }));
    if (job.op === "createThreadSection") {
      const name = String(args.name ?? "").trim();
      if (!name || name.length > 64) throw new Error("Название раздела должно содержать от 1 до 64 безопасных символов");
      const section = { id: randomUUID(), name };
      fixtureSections.push(section);
      return section;
    }
    if (job.op === "renameThreadSection") {
      const section = fixtureSections.find((item) => item.id === args.sectionId);
      if (!section) throw new Error("Раздел не найден");
      section.name = String(args.name ?? "").trim();
      return { ...section };
    }
    if (job.op === "deleteThreadSection") {
      if (fixtureSectionDeleteFailure) throw new Error("Тестовая ошибка Codex: раздел занят другим окном");
      const index = fixtureSections.findIndex((item) => item.id === args.sectionId);
      if (index < 0) throw new Error("Раздел не найден");
      fixtureSections.splice(index, 1);
      for (const session of [...sessions, ...archivedSessions]) if (session.section?.id === args.sectionId) session.section = undefined;
      return { sectionId: args.sectionId, deleted: true };
    }
    if (job.op === "moveThreadToSection") {
      const session = [...sessions, ...archivedSessions].find((item) => item.id === sessionId);
      if (!session) throw new Error("Сеанс не найден");
      const section = args.sectionId === null ? undefined : args.sectionId === fixturePinnedSection.id
        ? { ...fixturePinnedSection }
        : fixtureSections.find((item) => item.id === args.sectionId);
      if (args.sectionId !== null && !section) throw new Error("Раздел не найден");
      session.section = section;
      return { sessionId, sectionId: args.sectionId ?? null };
    }
    if (job.op === "transcribeAudio") return voiceAgent.executeMobile(job as unknown as MobileLocalJob);
    if (job.op === "listRealtimeVoices") {
      if (job.userId !== ownerId || !sessions.some((session) => session.id === sessionId)) throw new Error("Доступ к сеансу запрещён");
      return { voices: ["marin", "cedar"], defaultVoice: "marin" };
    }
    if (job.op === "startRealtime") {
      const runtime = controlled.get(sessionId);
      const offer = typeof args.sdp === "string" ? args.sdp : "";
      if (job.userId !== ownerId || !sessions.some((session) => session.id === sessionId)) throw new Error("Доступ к сеансу запрещён");
      if (runtime?.busy || (runtime?.queue.length ?? 0) > 0) throw new Error("Дождитесь завершения текущей задачи и очереди перед запуском голосового режима");
      if (!/^v=0\r?$/m.test(offer) || !/^m=audio\s/m.test(offer) || !/^m=application\s/m.test(offer)) throw new Error("Браузер не сформировал корректное аудиосоединение");
      const voice = typeof args.voice === "string" ? args.voice : "по умолчанию";
      if (voice !== "по умолчанию" && !["marin", "cedar"].includes(voice)) throw new Error("Выбранный голос Codex сейчас недоступен");
      feed.publish(sessionId, { kind: "activity", label: `Голосовой режим Codex подключён (${voice})` });
      feed.publish(sessionId, { kind: "transcript", role: "user", text: "Проверь голосовое подключение" });
      feed.publish(sessionId, { kind: "transcript", role: "assistant", text: "Голосовое подключение тестовой среды готово" });
      return { sdp: "v=0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" };
    }
    if (job.op === "stopRealtime") {
      if (job.userId !== ownerId || !sessions.some((session) => session.id === sessionId)) throw new Error("Доступ к сеансу запрещён");
      feed.publish(sessionId, { kind: "activity", label: "Голосовой режим Codex завершён" });
      return { stopped: true };
    }
    if (job.op === "latestEditableTurn") {
      if (sessionId !== firstSession) throw new Error("Сеанс не найден");
      return fixtureEditUnavailable
        ? { editable: false, reason: "В запросе есть вложение, которое нельзя безопасно восстановить.", attachmentCount: 1 }
        : { turnId: fixtureLatestTurnId, text: "Проверь экран Codex Mobile и сообщи, что видишь.", skillNames: [], appIds: ["calendar"], attachmentCount: fixtureEditWithImages ? 2 : 0, editable: true };
    }
    if (job.op === "listEditableTurns") {
      if (sessionId !== firstSession) throw new Error("Сеанс не найден");
      const userEntries = (history.get(sessionId) ?? []).filter((entry) => entry.role === "user");
      const turns = fixtureTurnIds.slice(0, userEntries.length).map((turnId, index) => {
        const unavailable = fixtureEditUnavailable && turnId === fixtureLatestTurnId;
        const hasImages = fixtureEditWithImages && turnId === fixtureLatestTurnId;
        return {
          turnId, text: userEntries[index]?.text ?? "", skillNames: [],
          appIds: index === userEntries.length - 1 ? ["calendar"] : [],
          attachmentCount: unavailable ? 1 : hasImages ? 2 : 0, editable: !unavailable,
          ...(unavailable ? { reason: "Запрос содержит вложение." } : {}),
        };
      }).reverse();
      return { latestTurnId: fixtureLatestTurnId, turns };
    }
    if (job.op === "editAndRetry") {
      if (fixtureEditFailure) { fixtureEditFailure = false; throw new Error("Тестовая ошибка Codex при повторной отправке"); }
      if (sessionId !== firstSession || args.expectedLatestTurnId !== fixtureLatestTurnId) throw new Error("История Codex изменилась. Обновите список запросов перед редактированием");
      const turnIndex = fixtureTurnIds.indexOf(String(args.turnId ?? ""));
      if (turnIndex < 0) throw new Error("Выбранный запрос больше не найден");
      if (fixtureEditUnavailable && args.turnId === fixtureLatestTurnId) throw new Error("Выбранный запрос содержит вложение и не может быть безопасно восстановлен");
      const entries = history.get(sessionId) ?? [];
      const userIndices = entries.flatMap((entry, index) => entry.role === "user" ? [index] : []);
      const targetUserIndex = userIndices[turnIndex];
      if (targetUserIndex === undefined) throw new Error("Выбранный запрос не найден в истории");
      entries.splice(targetUserIndex);
      const appIds = turnIndex === fixtureTurnIds.length - 1 ? ["calendar"] : [];
      if (appIds.some((id) => id !== "calendar")) throw new Error("Fixture Codex App недоступно");
      const appMention = appIds.includes("calendar") ? "$calendar-connector\n\n" : "";
      entries.push({ role: "user", text: `${appMention}${String(args.text ?? "")}`, timestamp: Date.now() });
      entries.push({ role: "assistant", text: "Запрос повторно обработан из изолированной тестовой среды. Настоящий Codex не запускался.", timestamp: Date.now() });
      history.set(sessionId, entries);
      fixtureTurnIds = fixtureTurnIds.slice(0, turnIndex);
      fixtureLatestTurnId = randomUUID();
      fixtureTurnIds.push(fixtureLatestTurnId);
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
    if (job.op === "listTerminalShells") {
      return { shells: [{ id: "cmd", label: "Командная строка (cmd)" }, { id: "powershell", label: "Windows PowerShell" }] };
    }
    if (job.op === "terminalStart") {
      const session = sessions.find((entry) => entry.id === sessionId);
      if (!session) throw new Error("Сеанс не найден");
      const existingId = fixtureTerminalBySession.get(sessionId);
      const existing = existingId ? fixtureTerminals.get(existingId) : undefined;
      if (existing && !existing.exited && existingId) return { terminalId: existingId, shell: "Fixture Shell", shellId: String(args.shell ?? "cmd"), reused: true, exited: false };
      const terminalId = randomUUID();
      fixtureTerminals.set(terminalId, { sessionId, output: "fixture shell ready\r\n", pendingInput: "", exited: false, exitCode: null });
      fixtureTerminalBySession.set(sessionId, terminalId);
      return { terminalId, shell: "Fixture Shell", shellId: String(args.shell ?? "cmd"), reused: false, exited: false };
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
    if (job.op === "createSideChat") {
      const source = sessions.find((session) => session.id === sessionId);
      if (!source || source.ephemeral) throw new Error("Исходный сеанс не найден");
      const id = randomUUID();
      sessions.unshift({ ...source, id, title: `${source.title} · side chat`, updatedAt: Date.now(), source: "appServer", ephemeral: true, parentThreadId: sessionId });
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
    if (job.op === "listMcpConfig") return fixtureMcpConfig.map((server) => ({ ...server }));
    if (job.op === "addMcpConfigServer") {
      if (job.userId !== ownerId || !sessions.some((session) => session.id === sessionId)) throw new Error("Доступ к сеансу запрещён");
      const name = typeof args.name === "string" ? args.name : "";
      const scope = args.scope === "global" ? "global" : args.scope === "workspace" ? "workspace" : undefined;
      const transport = args.transport === "http" ? "http" : args.transport === "stdio" ? "stdio" : undefined;
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(name) || !scope || !transport || fixtureMcpConfig.some((server) => server.name === name)) throw new Error("Проверьте имя MCP-сервера и выбранное подключение");
      const entry: FixtureMcpConfigEntry = { name, scope, enabled: true, transport, effective: true };
      fixtureMcpConfig.push(entry);
      return { ...entry, restartRequired: true };
    }
    if (job.op === "setMcpConfigEnabled") {
      const server = fixtureMcpConfig.find((entry) => entry.name === args.name && entry.scope === args.scope);
      if (!server || typeof args.enabled !== "boolean") throw new Error("MCP-сервер недоступен для изменения");
      server.enabled = args.enabled;
      return { ...server, restartRequired: true };
    }
    if (job.op === "removeMcpConfigServer") {
      if (job.userId !== ownerId || !sessions.some((session) => session.id === sessionId)) throw new Error("Доступ к сеансу запрещён");
      const index = fixtureMcpConfig.findIndex((entry) => entry.name === args.name && entry.scope === args.scope);
      if (index < 0) throw new Error("MCP-сервер недоступен для удаления");
      const [server] = fixtureMcpConfig.splice(index, 1);
      return { name: server!.name, scope: server!.scope, removed: true, restartRequired: true };
    }
    if (job.op === "restartCodex") {
      if ([...controlled.values()].some((runtime) => runtime.busy || runtime.queue.length > 0)) throw new Error("Сначала завершите активную работу и очистите очередь");
      return { restarted: true };
    }
    if (job.op === "compactThread") {
      if (controlled.get(sessionId)?.busy) throw new Error("Нельзя сократить контекст, пока Codex выполняет задачу");
      feed.publish(sessionId, { kind: "activity", label: "Запрос на сокращение контекста принят тестовой средой" });
      if (!fixtureCompactionUnconfirmed) feed.publish(sessionId, { kind: "compaction", label: "Codex подтвердил сокращение контекста" });
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
    if (job.op === "setPluginEnabled") {
      if (args.pluginId !== "reviewer@official" || !fixturePluginInstalled || typeof args.enabled !== "boolean") throw new Error("Плагин недоступен для изменения");
      fixturePluginEnabled = args.enabled;
      return { pluginId: args.pluginId, enabled: fixturePluginEnabled };
    }
    if (job.op === "addMarketplace") {
      const source = typeof args.source === "string" ? args.source : "";
      if (!/^(?:[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}|https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}(?:\.git)?)$/i.test(source)) {
        throw new Error("Для безопасной загрузки с телефона используйте GitHub HTTPS или owner/repo");
      }
      if (args.source !== "fixture/mobile-tools" || args.refName !== "stable") throw new Error("Фиктивный источник не принят");
      if (!fixtureMarketplaces.some((marketplace) => marketplace.name === "Fixture mobile")) {
        fixtureMarketplaces.push({ name: "Fixture mobile", pluginCount: 1, installedPluginCount: 0, manageable: true });
      }
      return { marketplaceName: "Fixture mobile", alreadyAdded: false };
    }
    if (job.op === "upgradeMarketplace") {
      const marketplace = fixtureMarketplaces.find((entry) => entry.name === args.marketplaceName && entry.manageable);
      if (!marketplace) throw new Error("Управляемый фиктивный каталог не найден");
      marketplace.pluginCount += 1;
      return { upgraded: true };
    }
    if (job.op === "removeMarketplace") {
      const index = fixtureMarketplaces.findIndex((entry) => entry.name === args.marketplaceName && entry.manageable);
      if (index < 0) throw new Error("Управляемый фиктивный каталог не найден");
      const [removed] = fixtureMarketplaces.splice(index, 1);
      return { marketplaceName: removed!.name, removed: true };
    }
    if (job.op === "mcpOAuthLogin") {
      if (args.name !== "fixture-mcp" || args.sessionId !== firstSession) throw new Error("MCP-сервер не найден в выбранном сеансе");
      const authorizationUrl = new URL("https://login.example.invalid/oauth/fixture");
      if (fixtureMcpOAuthMode === "par") {
        authorizationUrl.searchParams.set("client_id", "fixture-codex-client");
        authorizationUrl.searchParams.set("request_uri", "urn:ietf:params:oauth:request_uri:fixture");
      } else {
        authorizationUrl.searchParams.set("redirect_uri", `http://127.0.0.1:${mcpOAuthCallbackAddress.port}/callback/fixture-id`);
      }
      authorizationUrl.searchParams.set("state", fixtureMcpOAuthState);
      return { authorizationUrl: authorizationUrl.href };
    }
    if (job.op === "callMcpTool") {
      if (!fixtureMcpAuthorized || args.sessionId !== firstSession || args.server !== "fixture-mcp") throw new Error("Fixture MCP-сервер не подключён к выбранному сеансу");
      if (args.tool !== "read_status") throw new Error("Fixture MCP-инструмент не найден");
      const input = args.arguments as { query?: unknown };
      if (!input || typeof input !== "object" || typeof input.query !== "string") throw new Error("Fixture MCP ждёт строку query");
      return { text: `Fixture MCP result: ${input.query}\n<script>alert(1)</script>`, isError: false, truncated: false, omittedContentBlocks: 0 };
    }
    if (job.op === "readMcpResource") {
      if (!fixtureMcpAuthorized || args.sessionId !== firstSession) throw new Error("Fixture MCP-ресурс недоступен в выбранном сеансе");
      if (args.resourceId === "fixture-resource-account-notes") return { text: "Fixture resource content\n<img src=x onerror=alert(1)>", truncated: false, omittedContentBlocks: 0 };
      if (args.resourceId === "fixture-resource-account-report") {
        const parameters = args.parameters as { account_id?: unknown };
        if (!parameters || typeof parameters.account_id !== "string") throw new Error("Fixture MCP-шаблон ждёт account_id");
        return { text: `Fixture report for ${parameters.account_id}\n<img src=x onerror=alert(1)>`, truncated: false, omittedContentBlocks: 0 };
      }
      throw new Error("Fixture MCP-ресурс недоступен в выбранном сеансе");
    }
    if (job.op === "capabilities") {
      fixtureCapabilitiesCalls++;
      if (fixtureCapabilitiesFailOnCall > 0 && fixtureCapabilitiesCalls === fixtureCapabilitiesFailOnCall) {
        throw new Error("Тестовая ошибка Codex: обновление настроек недоступно");
      }
      return {
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
          { name: "read_status", description: "Read a safe fixture status.", inputSchema: {
            type: "object", required: ["query"], properties: { query: { type: "string", description: "Search phrase" } },
          } },
          { name: "host_info", description: "Text only: <script>alert(1)</script>.", inputSchema: { type: "object", properties: {} } },
        ], resources: fixtureMcpAuthorized ? [
          { id: "fixture-resource-account-notes", name: "Account notes", description: "Text-only fixture resource.", mimeType: "text/plain" },
          { id: "fixture-resource-account-report", name: "Account report", description: "Read a report for one account.", mimeType: "text/plain", parameters: ["account_id"] },
        ] : [],
        toolCount: 2, resourceCount: 1, resourceTemplateCount: fixtureMcpAuthorized ? 1 : 0, discoveryFailed: false,
      }],
      plugins: [{ id: "reviewer@official", name: "Review helper", marketplace: "Fixture official",
        description: "Показывает результаты ревью изменений.", capabilities: ["review", "summaries"], sourceType: "remote",
        installed: fixturePluginInstalled, enabled: fixturePluginEnabled, canToggle: fixturePluginInstalled, installable: !fixturePluginInstalled,
        installPolicy: "AVAILABLE", availability: "AVAILABLE", mustShowInstallationInterstitial: false }],
      pluginCatalogAvailable: true,
      marketplaces: fixtureMarketplaces.map((marketplace) => ({ ...marketplace })),
      apps: [{ id: "calendar", name: "Calendar connector", description: "Fixture app for read-only invocation checks.",
        enabled: true, accessible: true, callable: true, installUrl: "https://login.example.invalid/connect" }],
      appsAvailable: true,
      account: { type: "chatgpt", email: "fixture@example.invalid", plan: "fixture" },
      limits: [{ id: "fixture", name: "Тестовый период", primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 } }],
      subagents: [{ id: "fixture-agent", name: "Fixture Agent", status: "running" }],
      goal: fixtureGoals.get(sessionId), goalAvailable: true, checkedAt: Date.now(),
      };
    }
    if (job.op === "files") {
      const path = String(args.path ?? "");
      const prefix = path ? `${path}/` : "";
      const children = new Map<string, { name: string; kind: "directory" | "file"; size?: number; mtimeMs?: number }>();
      for (const directory of fixtureDirectories) {
        if (!directory.startsWith(prefix)) continue;
        const remainder = directory.slice(prefix.length);
        if (!remainder) continue;
        const slash = remainder.indexOf("/");
        const name = slash < 0 ? remainder : remainder.slice(0, slash);
        children.set(name, { name, kind: "directory", mtimeMs: 1 });
      }
      for (const [filePath, text] of fixtureFiles) {
        if (!filePath.startsWith(prefix)) continue;
        const remainder = filePath.slice(prefix.length);
        if (!remainder) continue;
        const slash = remainder.indexOf("/");
        const name = slash < 0 ? remainder : remainder.slice(0, slash);
        if (slash >= 0) children.set(name, { name, kind: "directory", mtimeMs: 1 });
        else children.set(name, { name, kind: "file", size: filePath === "assets/preview.png" ? 75 : Buffer.byteLength(text), mtimeMs: 1 });
      }
      const allEntries = [...children.values()].sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1);
      const offset = Number(args.offset ?? 0);
      const entries = allEntries.slice(offset, offset + 250);
      const nextOffset = offset + entries.length < allEntries.length ? offset + entries.length : undefined;
      return { project: "codex-mobile", path, entries, total: allEntries.length, ...(nextOffset === undefined ? {} : { nextOffset }) };
    }
    if (job.op === "readFile") {
      const path = String(args.path ?? "");
      const text = fixtureFiles.get(path);
      if (text === undefined) throw new Error("Файл не найден");
      return { project: "codex-mobile", path, text, size: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
    }
    if (job.op === "downloadFile") {
      const path = String(args.path ?? "");
      const content = fixtureFiles.get(path);
      if (content === undefined) throw new Error("Файл не найден");
      const bytes = Buffer.from(content, "utf8");
      return { name: path.split(/[\\/]/).at(-1) ?? "download", size: bytes.length, bytes };
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
    if (job.op === "createDirectory") {
      const path = String(args.path ?? "").replaceAll("\\", "/");
      const parts = path.split("/").filter(Boolean);
      const parent = parts.slice(0, -1).join("/");
      if (!path || parts.length === 0 || parts.some((part) => part === "." || part === "..") || (parent && !fixtureDirectories.has(parent)) || fixtureDirectories.has(path) || fixtureFiles.has(path)) throw new Error("Папка уже существует или путь недопустим");
      fixtureDirectories.add(path);
      return { path };
    }
    if (job.op === "renameProjectEntry") {
      const path = String(args.path ?? "");
      const newName = String(args.newName ?? "");
      const kind = String(args.expectedKind ?? "");
      const parts = path.split("/");
      const target = parts.slice(0, -1).concat(newName).filter(Boolean).join("/");
      if (!path || !newName || newName.includes("/") || args.expectedMtimeMs !== 1 || fixtureFiles.has(target) || fixtureDirectories.has(target)) throw new Error("Файл или папка изменились");
      if (kind === "file") {
        const content = fixtureFiles.get(path);
        const size = path === "assets/preview.png" ? 75 : content === undefined ? -1 : Buffer.byteLength(content);
        if (content === undefined || size !== args.expectedSize) throw new Error("Файл или папка изменились");
        fixtureFiles.set(target, content);
        fixtureFiles.delete(path);
      } else if (kind === "directory" && fixtureDirectories.has(path)) {
        const oldPrefix = path + "/";
        const newPrefix = target + "/";
        fixtureDirectories.delete(path);
        fixtureDirectories.add(target);
        for (const directory of [...fixtureDirectories]) if (directory.startsWith(oldPrefix)) { fixtureDirectories.delete(directory); fixtureDirectories.add(newPrefix + directory.slice(oldPrefix.length)); }
        for (const [filePath, content] of [...fixtureFiles]) if (filePath.startsWith(oldPrefix)) { fixtureFiles.delete(filePath); fixtureFiles.set(newPrefix + filePath.slice(oldPrefix.length), content); }
      } else throw new Error("Файл или папка не найдены");
      return { from: path, path: target, kind };
    }
    if (job.op === "deleteProjectEntry") {
      const path = String(args.path ?? "");
      const kind = String(args.expectedKind ?? "");
      if (!path || args.expectedMtimeMs !== 1) throw new Error("Файл или папка изменились");
      if (kind === "file") {
        const content = fixtureFiles.get(path);
        const size = path === "assets/preview.png" ? 75 : content === undefined ? -1 : Buffer.byteLength(content);
        if (content === undefined || size !== args.expectedSize) throw new Error("Файл или папка изменились");
        fixtureFiles.delete(path);
      } else if (kind === "directory" && fixtureDirectories.has(path)) {
        if (args.confirmationName !== path.split("/").at(-1)) throw new Error("Введите точное имя папки, чтобы подтвердить удаление");
        const prefix = path + "/";
        for (const directory of [...fixtureDirectories]) if (directory === path || directory.startsWith(prefix)) fixtureDirectories.delete(directory);
        for (const filePath of [...fixtureFiles.keys()]) if (filePath.startsWith(prefix)) fixtureFiles.delete(filePath);
      } else throw new Error("Файл или папка не найдены");
      return { path, kind };
    }
    if (job.op === "gitConflictStages") {
      if (String(args.path ?? "") === "assets/icon.bin" && !fixtureBinaryConflictResolved) return {
        project: "codex-mobile", path: "assets/icon.bin", binaryStages: ["base", "ours", "theirs"], worktreeSha256: "a".repeat(64),
      };
      if (String(args.path ?? "") !== "src/conflict.ts" || fixtureConflictResolved) throw new Error("Файл не находится в состоянии конфликта Git");
      return {
        project: "codex-mobile", path: "src/conflict.ts",
        base: "export const greeting = \"Hello\";\n// <img src=x onerror=alert(1)>\n",
        ours: "export const greeting = \"Hello\";\n",
        theirs: "export const greeting = \"Hi\";\n",
      };
    }
    if (job.op === "gitResolveConflictStage") {
      const path = String(args.path ?? "");
      const stage = String(args.stage ?? "");
      if (path !== "assets/icon.bin" || fixtureBinaryConflictResolved || !["base", "ours", "theirs"].includes(stage) || args.expectedHash !== "a".repeat(64)) throw new Error("Версии конфликта изменились. Обновите Git и повторите выбор.");
      fixtureBinaryConflictResolved = true;
      fixtureStaged.add(path);
      return { path, stage, size: 4, sha256: "b".repeat(64) };
    }
    if (job.op === "gitStatus") return {
      project: "codex-mobile", branch: fixtureBranch, ...(fixtureGitPullEnabled ? { upstream: "origin/mobile/feature" } : {}),
      branches: [...new Set([fixtureBranch, "main", "release/candidate"])], remoteBranches: ["origin/mobile/feature"],
      remotes: [{ name: "origin", fetchTargets: ["github.com"], pushTargets: ["github.com"] }], clean: fixtureGitPullEnabled,
      changes: fixtureGitPullEnabled ? [] : [
        ...(!fixtureStaged.has("src/main.ts") ? [{ code: "M", indexStatus: " ", worktreeStatus: "M", path: "src/main.ts" }] : []),
        ...(fixtureConflictResolved ? [{ code: "M", indexStatus: "M", worktreeStatus: " ", path: "src/conflict.ts" }] : [{ code: "UU", indexStatus: "U", worktreeStatus: "U", path: "src/conflict.ts" }]),
        ...(fixtureBinaryConflictResolved ? [{ code: "M", indexStatus: "M", worktreeStatus: " ", path: "assets/icon.bin" }] : [{ code: "UU", indexStatus: "U", worktreeStatus: "U", path: "assets/icon.bin" }]),
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
      const notesDiff = "diff --git a/notes/review.md b/notes/review.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes/review.md\n@@ -0,0 +1 @@\n+Review fixture\n";
      return {
        project: "codex-mobile",
        unstaged: [
          (!selectedPath || selectedPath === "src/main.ts") ? mainDiff : "",
          !fixtureNotesCommitted && !fixtureStaged.has("notes/review.md") && (!selectedPath || selectedPath === "notes/review.md") ? notesDiff : "",
        ].filter(Boolean).join("\n"),
        staged: !selectedPath
          ? fixtureStaged.has("notes/review.md") ? "diff --git a/notes/review.md b/notes/review.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes/review.md\n@@ -0,0 +1 @@\n+Review fixture\n" : fixtureRenameStaged ? "diff --git a/src/old-main.ts b/src/renamed.ts\nsimilarity index 100%\nrename from src/old-main.ts\nrename to src/renamed.ts\n" : ""
          : renameSelected && fixtureRenameStaged ? "diff --git a/src/old-main.ts b/src/renamed.ts\nsimilarity index 100%\nrename from src/old-main.ts\nrename to src/renamed.ts\n" : selectedPath === "notes/review.md" && fixtureStaged.has("notes/review.md") ? "diff --git a/notes/review.md b/notes/review.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes/review.md\n@@ -0,0 +1 @@\n+Review fixture\n" : "",
        checkedAt: Date.now(),
      };
    }
    if (job.op === "gitStage") {
      const path = String(args.path);
      fixtureStaged.add(path);
      if (path === "src/conflict.ts") fixtureConflictResolved = true;
      if (path === "assets/icon.bin") fixtureBinaryConflictResolved = true;
      return { path, staged: true };
    }
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
    if (job.op === "gitPull") {
      if (!fixtureGitPullEnabled) throw new Error("Тестовый upstream не настроен");
      fixtureGitPullCount++;
      return { branch: fixtureBranch, upstream: "origin/mobile/feature", updated: fixtureGitPullCount === 1 };
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

const fixtureRegistry = { ownerChatForSession: (id: string) => sessions.some((session) => session.id === id) ? ownerId : undefined } as unknown as RuntimeRegistry;
const mobileApprovals = new MobileApprovalBroker(
    feed as unknown as TmaLiveFeed,
    fixtureRegistry,
    new Set([String(ownerId)]),
    async () => ({ outcome: { outcome: "cancelled" } }),
  );
const mobileElicitations = new MobileElicitationBroker(feed as unknown as TmaLiveFeed, fixtureRegistry, new Set([String(ownerId)]));
let fixtureAccountActive = "fixture-personal";
let fixtureAccountAutoRotate = false;
let fixtureDeviceLogin: { status: "pending" | "completed" | "failed" | "cancelled"; startedAt: string; verificationUrl?: string; userCode?: string } | undefined;
const fixtureAccounts = [
  { id: "fixture-personal", label: "Fixture личный", email: "personal@example.test", accountType: "Plus", savedAt: "2026-10-18T00:00:00.000Z" },
  { id: "fixture-work", label: "Fixture рабочий", email: "work@example.test", accountType: "Team", savedAt: "2026-10-17T00:00:00.000Z" },
];
const mobileAccounts = {
  async snapshot(userId: number) {
    if (userId !== ownerId) throw new Error("Доступ к аккаунтам запрещён");
    return {
      loggedIn: true,
      activeAccountId: fixtureAccountActive,
      activeLabel: fixtureAccounts.find((account) => account.id === fixtureAccountActive)?.email ?? "Fixture личный",
      activeAccountType: fixtureAccounts.find((account) => account.id === fixtureAccountActive)?.accountType ?? "Plus",
      autoRotate: fixtureAccountAutoRotate,
      ...(fixtureDeviceLogin ? { deviceLogin: { ...fixtureDeviceLogin } } : {}),
      accounts: fixtureAccounts.map((account) => ({ ...account, active: account.id === fixtureAccountActive })),
    };
  },
  async execute(userId: number, value: unknown) {
    if (userId !== ownerId) throw new Error("Доступ к аккаунтам запрещён");
    const body = value as { action?: string; id?: string; label?: string; enabled?: boolean };
    const target = fixtureAccounts.find((account) => account.id === body.id);
    if (body.action === "saveCurrent") return { snapshot: await this.snapshot(userId), message: "Текущий тестовый аккаунт сохранён" };
    if (body.action === "startDeviceLogin") {
      fixtureDeviceLogin = { status: "pending", startedAt: new Date().toISOString(), verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" };
      return { snapshot: await this.snapshot(userId), message: "Тестовый одноразовый код создан" };
    }
    if (body.action === "cancelDeviceLogin") {
      if (fixtureDeviceLogin?.status !== "pending") throw new Error("Нет ожидающего тестового входа");
      fixtureDeviceLogin = { status: "cancelled", startedAt: fixtureDeviceLogin.startedAt };
      return { snapshot: await this.snapshot(userId), message: "Тестовый вход отменён" };
    }
    if (body.action === "rename" && target) target.label = String(body.label ?? "");
    else if (body.action === "forget" && target) fixtureAccounts.splice(fixtureAccounts.indexOf(target), 1);
    else if (body.action === "setAutoRotate") fixtureAccountAutoRotate = body.enabled === true;
    else if (body.action === "switch" && target) {
      if (process.env.CODEX_MOBILE_FIXTURE_ACCOUNT_SWITCH_BLOCKED === "1") throw new Error("Codex занят. Дождитесь завершения текущей задачи перед сменой аккаунта");
      fixtureAccountActive = target.id;
    } else if (body.action !== "saveCurrent") throw new Error("Сохранённый тестовый аккаунт не найден");
    return { snapshot: await this.snapshot(userId), message: "Тестовый аккаунт обновлён" };
  },
};
const requestedPort = fixtureHost === "phone.localhost" ? await reserveLoopbackPort() : 0;
const mobileOrigin = `http://${fixtureHost}:`;
const server: Server = createMobileServer({
  auth, agent, accounts: mobileAccounts as never, feed: feed as unknown as TmaLiveFeed, approvals: mobileApprovals,
  elicitations: mobileElicitations, dataDir,
  staticRoot: resolve("apps/codex-mobile/dist"), port: requestedPort,
  isCodexOAuthCallbackListener: async (callback) => callback.protocol === "http:" && callback.hostname === "127.0.0.1" &&
    Number(callback.port) === mcpOAuthCallbackAddress.port,
  ...(fixtureHost === "phone.localhost" ? { allowedOrigins: [`${mobileOrigin}${requestedPort}`] } : {}),
});
server.listen(requestedPort, "127.0.0.1");
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
  res.setHeader("Location", `${mobileOrigin}${port}/`);
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
  origin: mobileOrigin + port,
  bootstrapOrigin: mobileOrigin + bootstrapAddress.port,
  port,
  instanceDir,
  dataDir,
  firstSession,
  oauthCallbackPasteUrl: `http://127.0.0.1:${mcpOAuthCallbackAddress.port}/callback/fixture-id?code=browser-fixture-code&state=${fixtureMcpOAuthState}`,
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
      if (command.command === "approval" || command.command === "approvalNoSession" || command.command === "approvalAdvanced" || command.command === "permissionApproval") {
        const permissionApproval = command.command === "permissionApproval";
        const advancedApproval = command.command === "approvalAdvanced";
        void mobileApprovals.handle({
          sessionId: firstSession,
          toolCall: permissionApproval
            ? { title: "Дополнительный доступ", kind: "write" }
            : { title: "git status", kind: "execute" },
          options: permissionApproval
            ? [{ optionId: "grant", name: "Разрешить один раз" }, { optionId: "deny", name: "Отклонить" }]
            : [{ optionId: "accept", name: "Разрешить один раз" }, { optionId: "decline", name: "Отклонить" }],
          ...((command.command === "approval" || permissionApproval) ? {
            mobileOptions: [permissionApproval
              ? { optionId: "codex-mobile-permissions-session-allow", name: "Разрешить для сеанса" }
              : { optionId: "codex-mobile-session-allow", name: "Разрешить для сеанса" }],
          } : {}),
          ...(advancedApproval ? {
            mobileChoices: [
              { optionId: "accept", name: "Разрешить один раз", kind: "allow_once" },
              { optionId: "codex-mobile-decision-1", name: "Разрешить и сохранить правило команды", kind: "allow_rule" },
              { optionId: "codex-mobile-decision-2", name: "Разрешить хост и сохранить правило", kind: "allow_rule" },
              { optionId: "cancel", name: "Отменить текущий ход", kind: "cancel" },
            ],
            mobileSummary: "Правило команды: [\"npm\",\"test\"]\nСетевое правило для registry.example.com: разрешить",
          } : {}),
          ...(permissionApproval ? {
            permissions: {
              network: { enabled: true },
              fileSystem: { write: ["C:\\fixture\\codex-mobile\\output"] },
            },
          } : {}),
          reason: permissionApproval
            ? "Codex запрашивает файловые и сетевые права."
            : "Нужен доступ для выполнения команды проверки.",
        }).then((result) => process.stdout.write(JSON.stringify({ fixtureApprovalResult: result }) + "\n"));
      } else if (command.command === "mcpElicitationForm" || command.command === "mcpElicitationUrl") {
        const form = command.command === "mcpElicitationForm";
        void mobileElicitations.handle({
          threadId: firstSession,
          serverName: "fixture-account",
          mode: form ? "form" : "url",
          message: form ? "Проверьте параметры запроса и ответьте MCP-серверу." : "Продолжите тестовый вход, затем вернитесь сюда.",
          ...(form ? { requestedSchema: {
            type: "object",
            properties: {
              account_id: { type: "string", title: "Account ID", description: "<img src=x onerror=alert(1)>", maxLength: 80 },
              region: { type: "string", title: "Регион", enum: ["eu", "us"] },
              count: { type: "integer", title: "Количество", minimum: 1, maximum: 10 },
              enabled: { type: "boolean", title: "Разрешить доступ" },
              api_token: { type: "string", title: "Ключ API", format: "password", minLength: 8, maxLength: 32 },
            },
            required: ["account_id", "region", "api_token"],
          } } : {
            url: "https://accounts.example.test/authorize?token=fixture-secret",
          }),
        }).then((result) => process.stdout.write(JSON.stringify({ fixtureElicitationResult: result }) + "\n"));
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
      } else if (command.command === "voiceClosed") {
        feed.publish(selected, { kind: "activity", label: "Голосовой режим Codex завершён" });
        process.stdout.write("Fixture realtime voice closed remotely.\n");
      } else if (command.command === "voiceError") {
        feed.publish(selected, { kind: "activity", label: "Ошибка голосового соединения Codex" });
        process.stdout.write("Fixture realtime voice failed remotely.\n");
      } else if (command.command === "deviceLoginSuccess" || command.command === "deviceLoginFailure") {
        if (fixtureDeviceLogin?.status !== "pending") throw new Error("No fake device-code login is pending");
        fixtureDeviceLogin = {
          status: command.command === "deviceLoginSuccess" ? "completed" : "failed",
          startedAt: fixtureDeviceLogin.startedAt,
        };
        process.stdout.write(command.command === "deviceLoginSuccess" ? "Fixture device-code login completed.\n" : "Fixture device-code login failed.\n");
      } else if (command.command === "planUpdated") {
        feed.publish(selected, { kind: "plan", turnId: "fixture-turn", explanation: "Изолированная проверка плана",
          plan: [
            { step: "Прочитать историю", status: "completed" },
            { step: "Проверить <img src=x onerror=alert(1)>", status: "inProgress" },
            { step: "Сверить изменения", status: "pending" },
          ] });
        process.stdout.write("Fixture current-turn plan published.\n");
      } else if (command.command === "liveFileChange") {
        feed.publish(firstSession, { kind: "tool", label: "Изменяется файл main.ts" });
        process.stdout.write("Fixture safe file-change event published.\n");
      } else if (command.command === "deleteThreadError") {
        fixtureDeleteFailure = true;
        process.stdout.write("Fixture Codex deletion error enabled.\n");
      } else if (command.command === "deleteThreadReset") {
        fixtureDeleteFailure = false;
        process.stdout.write("Fixture Codex deletion error disabled.\n");
      } else if (command.command === "sectionDeleteError") {
        fixtureSectionDeleteFailure = true;
        process.stdout.write("Fixture Codex section deletion error enabled.\n");
      } else if (command.command === "sectionDeleteReset") {
        fixtureSectionDeleteFailure = false;
        process.stdout.write("Fixture Codex section deletion error disabled.\n");
      }
    } catch { process.stdout.write("Fixture control command was ignored.\n"); }
  }
});

async function shutdown() {
  voiceAgent.stop();
  browserBootstrap.closeAllConnections();
  await new Promise<void>((resolveClose) => browserBootstrap.close(() => resolveClose()));
  mcpOAuthCallbackServer.closeAllConnections();
  await new Promise<void>((resolveClose) => mcpOAuthCallbackServer.close(() => resolveClose()));
  server.closeAllConnections();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await rm(instanceDir, { recursive: true, force: true });
}
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
