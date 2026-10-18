/**
 * Codex client — spawns `codex app-server` and speaks its JSON-RPC 2.0 protocol
 * over stdio (the `jsonrpc` header is omitted on the wire, matching Codex).
 *
 * One process manages many threads (the bot's "sessions"). Callers create/resume
 * threads and start turns; Codex's streamed `item/*` and `turn/*` notifications
 * are translated (see ./translate.ts) into the bot's protocol-neutral
 * "session-update" events keyed by threadId, so the whole downstream layer is
 * unchanged. The class name `AcpClient` is kept for import compatibility.
 */
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { REASONING_LEVELS, type ReasoningEffort } from "../app/types.js";
import { codexLaunchInfo, codexSpawn } from "../app/codex-cli.js";
import { createLogger } from "../logger.js";
import { killPid } from "../sessions/process.js";
import { AcpError, isAccountExhaustedError, isContextExhaustedError, isTransientAcpError, toAcpError } from "./errors.js";
import { mobileMcpResourceUriMatchesTemplate, normalizeMobileMcpResourceResult, normalizeMobileMcpToolResult, validateMobileMcpArguments } from "./mobile-mcp.js";
import { decideApproval, decidePermissionsApproval } from "./approvals.js";
import { handleServerRequest, type ServerHandlerOptions } from "./server-handlers.js";
import { JsonRpcTransport } from "./transport.js";
import { installedPluginExists, resolveRemotePluginInstall } from "./plugins.js";
import { requireManagedMarketplace, validateMobileMarketplaceRef, validateMobileMarketplaceSource } from "./marketplaces.js";
import { parseCodexThreadReadState } from "./codex-protocol.js";
import {
  commandString,
  itemToUpdates,
  textChunk,
  thoughtChunk,
  reasoningSummaryChunk,
  turnErrorInfo,
  toCodexInput,
  turnErrorMessage,
} from "./translate.js";
import type {
  CodexInitializeResult,
  CodexCollaborationModeInfo,
  CodexCollaborationModeListResult,
  CodexItem,
  CodexMcpElicitationResponse,
  CodexMcpServerStatus,
  CodexAccountInfo,
  CodexRateLimitSnapshot,
  CodexModelInfo,
  CodexModelListResult,
  CodexThreadResponse,
  CodexThreadForkResponse,
  CodexThreadGoal,
  CodexThreadGoalStatus,
  CodexReviewTarget,
  CodexReviewDelivery,
  CodexReviewStartResponse,
  CodexUserInput,
  CodexTokenUsage,
  CodexTurn,
  CodexTurnResponse,
  CodexTurnStartParams,
  CodexSkillInfo,
  CodexProjectListResponse,
  CodexProjectSummary,
  CodexThreadListParams,
  CodexThreadListResponse,
  CodexThreadSummary,
  CodexThreadReadState,
  CodexThreadSection,
  CodexThreadSettingsUpdateParams,
  CodexBackgroundTerminal,
  CodexMobileEditableTurn,
} from "./codex-protocol.js";
import type {
  ContentBlock,
  InitializeResult,
  JsonRpcMessage,
  PendingStage,
  PermissionOutcome,
  PromptResult,
  RequestPermissionParams,
  SubagentInfo,
} from "./types.js";

const log = createLogger("codex:client");
const MOBILE_APP_ID_PATTERN = /^[a-z0-9][a-z0-9_.:@-]{0,199}$/i;

function mobileAppRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function mobileAppList(value: unknown): Record<string, unknown>[] {
  const data = mobileAppRecord(value)?.data;
  return Array.isArray(data) ? data.flatMap((entry) => {
    const app = mobileAppRecord(entry);
    return app ? [app] : [];
  }) : [];
}

function codexAppSlug(name: string): string {
  return name.normalize("NFKD").toLowerCase()
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function parseMobileEditableImage(url: unknown): { mimeType: string; data: string } | undefined {
  if (typeof url !== "string") return undefined;
  const match = /^data:(image\/(?:jpeg|png|webp));base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/i.exec(url);
  if (!match) return undefined;
  const mimeType = match[1]!.toLowerCase();
  const data = match[2]!;
  if (data.length < 16 || data.length > Math.ceil((1536 * 1024) / 3) * 4 + 4) return undefined;
  const bytes = Buffer.from(data, "base64");
  if (bytes.length < 16 || bytes.length > 1536 * 1024 || bytes.toString("base64") !== data) return undefined;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!(mimeType === "image/jpeg" && jpeg || mimeType === "image/png" && png || mimeType === "image/webp" && webp)) return undefined;
  return { mimeType, data };
}

function parseMobileEditableTurn(value: unknown, retainReplayData = false): CodexMobileEditableTurn | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !/^[a-z0-9_-]{8,128}$/i.test(record.id) || !Array.isArray(record.items)) return undefined;
  const userMessages = record.items.filter((item) => item && typeof item === "object" &&
    (item as Record<string, unknown>).type === "userMessage") as Array<Record<string, unknown>>;
  if (userMessages.length !== 1 || !Array.isArray(userMessages[0]!.content)) return undefined;
  const skillNames: string[] = [];
  const text: string[] = [];
  const resendImages: Array<{ mimeType: string; data: string }> = [];
  const resendLocalImages: string[] = [];
  let attachmentCount = 0;
  let hasUnsupportedContent = false;
  for (const value of userMessages[0]!.content) {
    if (!value || typeof value !== "object") { hasUnsupportedContent = true; continue; }
    const item = value as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") {
      if (item.text_elements !== undefined && (!Array.isArray(item.text_elements) || item.text_elements.length > 0)) hasUnsupportedContent = true;
      else text.push(item.text);
    }
    else if (item.type === "skill" && typeof item.name === "string" && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(item.name)) skillNames.push(item.name);
    else if (item.type === "image") {
      attachmentCount++;
      const image = parseMobileEditableImage(item.url);
      if (!image || resendImages.length + resendLocalImages.length >= 5) hasUnsupportedContent = true;
      else if (retainReplayData) resendImages.push(image);
    }
    else if (item.type === "localImage") {
      attachmentCount++;
      const path = item.path;
      if (typeof path !== "string" || !path || path.length > 32768 || /[\u0000-\u001f\u007f]/.test(path) || !isAbsolute(path) || resendImages.length + resendLocalImages.length >= 5) {
        hasUnsupportedContent = true;
      } else if (retainReplayData) resendLocalImages.push(path);
    }
    else { attachmentCount++; hasUnsupportedContent = true; }
  }
  const joinedText = text.join("\n").trim();
  const status = typeof record.status === "string" ? record.status : "";
  const terminalTurn = status === "completed" || status === "interrupted" || status === "failed";
  return {
    turnId: record.id,
    text: joinedText,
    skillNames: [...new Set(skillNames)],
    attachmentCount,
    ...(resendImages.length ? { resendImages } : {}),
    ...(resendLocalImages.length ? { resendLocalImages } : {}),
    editable: Boolean(joinedText) && !hasUnsupportedContent && terminalTurn,
  };
}

/** Per-thread metadata (context usage %, effort, credits) surfaced to the UI. */
export interface SessionMetadata {
  contextUsagePercentage?: number;
  effort?: string;
  credits?: number;
}

export interface CodexDeviceCodeLogin {
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

// Re-exported so existing importers of these from "../acp/client.js" keep working.
export { AcpError, isAccountExhaustedError, isContextExhaustedError, isTransientAcpError };

export interface AcpClientOptions {
  codexCliPath: string;
  workspace: string;
  /** When true, run every command/edit with no approval prompts (full auto). */
  trustAllTools: boolean;
  /** Allow network access in workspace-write mode without broadening file access. */
  networkAccess?: boolean;
  /** Optional CODEX_HOME override (config/sessions/auth live here). */
  codexHome?: string;
  requestTimeoutMs?: number;
  autoRestart?: boolean;
  /** Reject a turn only after this long with no streaming activity. */
  promptIdleTimeoutMs?: number;
  /** Optional absolute safety cap for a single turn; disabled by default. */
  promptMaxMs?: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  cleanup: () => void;
  method: string;
}

interface TurnPending {
  threadId: string;
  turnId?: string;
  terminalError?: Error;
  terminalErrorTimer?: NodeJS.Timeout;
  resolve: (r: PromptResult) => void;
  reject: (e: Error) => void;
  watch: NodeJS.Timeout;
  start: number;
}

export declare interface AcpClient {
  on(e: "session-update", l: (sessionId: string, update: import("./types.js").SessionUpdate) => void): this;
  on(e: "notification", l: (method: string, params: unknown) => void): this;
  on(e: "exit", l: (code: number | null) => void): this;
  on(e: "restarted", l: () => void): this;
  on(e: "subagents", l: (subagents: SubagentInfo[], pending: PendingStage[]) => void): this;
  emit(e: "session-update", sessionId: string, update: import("./types.js").SessionUpdate): boolean;
  emit(e: "notification", method: string, params: unknown): boolean;
  emit(e: "exit", code: number | null): boolean;
  emit(e: "restarted"): boolean;
  emit(e: "subagents", subagents: SubagentInfo[], pending: PendingStage[]): boolean;
  emit(e: "rate-limits", limits: unknown): boolean;
}

export class AcpClient extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private transport?: JsonRpcTransport;
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  /** In-flight turns, keyed by threadId (one turn per thread at a time). */
  private readonly turns = new Map<string, TurnPending>();
  private readonly timeout: number;
  private readonly promptIdleMs: number;
  private readonly promptMaxMs?: number;
  private readonly lastActivity = new Map<string, number>();
  private stopped = false;
  /** True once an initialize handshake has ever succeeded (for error hints). */
  private everConnected = false;
  private connected = false;
  private restartAttempts = 0;
  private restartTimer?: NodeJS.Timeout;

  agentInfo?: { name?: string; version?: string };
  capabilities?: InitializeResult["agentCapabilities"];
  /** Absolute CODEX_HOME reported by Codex at initialize (sessions/auth live here). */
  codexHome?: string;
  /** Agent/collaboration presets reported by Codex. */
  availableModes: Array<{ id: string; name: string; description?: string }> = [];
  currentModeId?: string;
  /** Models from Codex's `model/list`. */
  availableModels: Array<{ modelId: string; name: string; description?: string }> = [];
  currentModelId?: string;
  availableSkills: CodexSkillInfo[] = [];
  availableMcpServers: CodexMcpServerStatus[] = [];

  private readonly metadata = new Map<string, SessionMetadata>();
  private readonly threadCwd = new Map<string, string>();
  private readonly threadModel = new Map<string, string | null>();
  private readonly threadMode = new Map<string, string | null>();
  private readonly threadEffort = new Map<string, string | null>();
  private readonly collaborationModes = new Map<string, CodexCollaborationModeInfo>();
  private readonly subagents = new Map<string, SubagentInfo>();
  /** Threads with an active native Codex realtime voice transport. */
  private readonly realtimeThreads = new Set<string>();
  /** itemId -> threadId, so text/reasoning deltas route to the right thread. */
  private readonly itemThread = new Map<string, string>();

  permissionHandler?: (params: RequestPermissionParams) => Promise<PermissionOutcome>;
  elicitationHandler?: (params: Record<string, unknown>) => Promise<CodexMcpElicitationResponse>;

  get isConnected(): boolean {
    return this.connected;
  }

  constructor(private readonly opts: AcpClientOptions) {
    super();
    this.setMaxListeners(0);
    this.timeout = opts.requestTimeoutMs ?? 120_000;
    this.promptIdleMs = opts.promptIdleTimeoutMs ?? 900_000;
    this.promptMaxMs = opts.promptMaxMs;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    this.connected = false;
    this.subagents.clear();
    const args = ["app-server"];
    if (!this.opts.trustAllTools) args.push("--enable", "request_permissions_tool");
    const env = { ...process.env } as NodeJS.ProcessEnv;
    if (this.opts.codexHome) env.CODEX_HOME = this.opts.codexHome;
    log.info(`spawning: ${codexLaunchInfo(this.opts.codexCliPath)} app-server`);
    const proc = codexSpawn(this.opts.codexCliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.workspace,
      env,
    });
    this.proc = proc;

    proc.on("exit", (code) => {
      if (this.proc !== proc) return;
      this.connected = false;
      log.warn(`codex app-server exited (code ${code})`);
      const msg = this.everConnected
        ? `codex app-server exited (code ${code})`
        : `codex app-server exited (code ${code}) before it started. Is the 'codex' CLI installed and on PATH? Install it with \`npm i -g @openai/codex\`, or set CODEX_CLI_PATH in your .env to the codex binary.`;
      this.failAllPending(new Error(msg));
      this.emit("exit", code);
      this.maybeRestart();
    });
    proc.on("error", (err) => {
      if (this.proc !== proc) return;
      this.connected = false;
      const e = err as NodeJS.ErrnoException;
      const msg =
        e.code === "ENOENT"
          ? `Could not find the 'codex' CLI (tried "${this.opts.codexCliPath}"). Install it with \`npm i -g @openai/codex\` (or a native build), or set CODEX_CLI_PATH in your .env to the codex binary, then restart.`
          : err.message;
      log.error("failed to spawn codex:", msg);
      this.failAllPending(new Error(msg));
    });

    this.transport = new JsonRpcTransport(proc);
    this.transport.on("message", (m: JsonRpcMessage) => this.onMessage(m));

    const init = (await this.request("initialize", {
      clientInfo: { name: "codex-telegram-bot", title: "Codex Telegram Bot", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    })) as CodexInitializeResult;
    // Codex requires an `initialized` notification to complete the handshake.
    this.send({ method: "initialized" });

    this.codexHome = init?.codexHome || this.opts.codexHome;
    this.capabilities = { loadSession: true };
    this.agentInfo = { name: "codex", version: parseVersion(init?.userAgent) };
    this.restartAttempts = 0;
    this.everConnected = true;
    this.connected = true;
    await Promise.all([this.loadModels(), this.loadCapabilities()]);
    log.info(`connected: codex app-server${init?.userAgent ? ` (${init.userAgent})` : ""}`);
  }

  /** Load live Codex inventories. Each endpoint is independent and best-effort. */
  async refreshInventories(): Promise<void> {
    await Promise.all([this.loadModels(), this.loadCapabilities()]);
  }

  /** Best-effort plugin and app inventory from the already running app-server. */
  async mobileIntegrationInventory(cwd?: string, threadId?: string): Promise<{
    pluginCatalog?: unknown;
    installedPlugins?: unknown;
    apps?: unknown;
    installedApps?: unknown;
  }> {
    const pluginParams = cwd ? { cwds: [cwd] } : {};
    const appParams = { limit: 100, ...(threadId ? { threadId } : {}) };
    const [pluginCatalog, installedPlugins, apps, installedApps] = await Promise.all([
      this.request("plugin/list", pluginParams).catch(() => undefined),
      this.request("plugin/installed", {}).catch(() => undefined),
      this.request("app/list", appParams).catch(() => undefined),
      this.request("app/installed", {}).catch(() => undefined),
    ]);
    return { pluginCatalog, installedPlugins, apps, installedApps };
  }

  /** Add a remote marketplace through Codex's native configuration RPC. */
  async addMobileMarketplace(sourceValue: string, refValue?: string): Promise<{ marketplaceName: string; alreadyAdded: boolean }> {
    const source = validateMobileMarketplaceSource(sourceValue);
    const refName = validateMobileMarketplaceRef(refValue);
    let response: unknown;
    try {
      response = await this.request("marketplace/add", { source, ...(refName ? { refName } : {}) });
    } catch {
      throw new AcpError("Codex не смог добавить каталог плагинов");
    }
    await this.refreshInventories();
    const marketplaceName = (response as { marketplaceName?: unknown } | undefined)?.marketplaceName;
    if (typeof marketplaceName !== "string" || !marketplaceName || marketplaceName.length > 120 ||
        /[\u0000-\u001f\u007f\\/:]/.test(marketplaceName)) {
      throw new AcpError("Codex добавил каталог, но не вернул его имя; обновите список");
    }
    return { marketplaceName, alreadyAdded: (response as { alreadyAdded?: unknown }).alreadyAdded === true };
  }

  /** Remove only a named marketplace that the live global Codex catalog marks as manageable. */
  async removeMobileMarketplace(marketplaceName: string): Promise<void> {
    let catalog: unknown;
    try { catalog = await this.request("plugin/list", {}); }
    catch { throw new AcpError("Codex не смог проверить список каталогов плагинов"); }
    const name = requireManagedMarketplace(catalog, marketplaceName);
    try { await this.request("marketplace/remove", { marketplaceName: name }); }
    catch { throw new AcpError("Codex не смог удалить каталог плагинов"); }
    await this.refreshInventories();
  }

  /** Upgrade one marketplace after checking it is present in the current Codex catalog. */
  async upgradeMobileMarketplace(marketplaceName: string): Promise<void> {
    let catalog: unknown;
    try { catalog = await this.request("plugin/list", {}); }
    catch { throw new AcpError("Codex не смог проверить список каталогов плагинов"); }
    const name = requireManagedMarketplace(catalog, marketplaceName);
    try { await this.request("marketplace/upgrade", { marketplaceName: name }); }
    catch { throw new AcpError("Codex не смог обновить каталог плагинов"); }
    await this.refreshInventories();
  }

  /** Start Codex's native OAuth flow for one MCP server already configured in an authorized thread. */
  async startMobileMcpOAuthLogin(name: string, threadId: string): Promise<{ authorizationUrl: string }> {
    if (!name.trim() || name.length > 120 || !threadId.trim() || threadId.length > 128) {
      throw new Error("Неверные параметры входа в MCP-сервер");
    }
    const response = await this.request("mcpServer/oauth/login", { name, threadId }) as { authorizationUrl?: unknown };
    if (typeof response?.authorizationUrl !== "string") {
      throw new AcpError("Codex не вернул ссылку для входа в MCP-сервер");
    }
    try {
      const authorizationUrl = new URL(response.authorizationUrl);
      if (authorizationUrl.protocol !== "https:" || authorizationUrl.username || authorizationUrl.password) {
        throw new Error("unsafe URL");
      }
      return { authorizationUrl: authorizationUrl.href };
    } catch {
      throw new AcpError("Codex вернул небезопасную ссылку входа; разрешены только HTTPS-ссылки");
    }
  }

  /** List Codex shell processes that are still running for one authorized thread. */
  async listMobileBackgroundTerminals(threadId: string): Promise<CodexBackgroundTerminal[]> {
    if (!/^[a-z0-9_-]{8,128}$/i.test(threadId)) throw new Error("Неверный сеанс Codex для списка фоновых процессов");
    const byProcessId = new Map<string, CodexBackgroundTerminal>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const params = { threadId, limit: 100, ...(cursor ? { cursor } : {}) };
      const response = await this.request("thread/backgroundTerminals/list", params) as {
        data?: unknown;
        nextCursor?: unknown;
      };
      if (!Array.isArray(response?.data)) throw new AcpError("Codex вернул неверный список фоновых процессов");
      for (const value of response.data) {
        if (!value || typeof value !== "object") continue;
        const item = value as Record<string, unknown>;
        if (typeof item.itemId !== "string" || !/^[a-z0-9_-]{1,200}$/i.test(item.itemId) ||
            typeof item.processId !== "string" || !/^[a-z0-9._-]{1,128}$/i.test(item.processId)) continue;
        byProcessId.set(item.processId, { itemId: item.itemId, processId: item.processId });
      }
      const next = typeof response.nextCursor === "string" && response.nextCursor.length <= 2048
        ? response.nextCursor : undefined;
      if (!next || next === cursor || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    return [...byProcessId.values()];
  }

  /** Terminate only a process Codex still reports as belonging to this thread. */
  async terminateMobileBackgroundTerminal(threadId: string, processId: string): Promise<void> {
    if (!/^[a-z0-9_-]{8,128}$/i.test(threadId) || !/^[a-z0-9._-]{1,128}$/i.test(processId)) {
      throw new Error("Укажите фоновый процесс из списка сеанса Codex");
    }
    const processes = await this.listMobileBackgroundTerminals(threadId);
    if (!processes.some((process) => process.processId === processId)) {
      throw new AcpError("Фоновый процесс не найден в выбранном сеансе");
    }
    const result = await this.request("thread/backgroundTerminals/terminate", { threadId, processId }) as { terminated?: unknown };
    if (result?.terminated !== true) throw new AcpError("Codex не подтвердил остановку фонового процесса");
  }

  /** Read only the newest user turn in a form that can be safely edited on mobile. */
  async readMobileLatestEditableTurn(threadId: string): Promise<CodexMobileEditableTurn | undefined> {
    if (!/^[a-z0-9_-]{8,128}$/i.test(threadId)) throw new Error("Неверный сеанс Codex для редактирования запроса");
    const response = await this.request("thread/turns/list", {
      threadId, limit: 1, sortDirection: "desc", itemsView: "full",
    }) as { data?: unknown };
    if (!Array.isArray(response?.data)) throw new AcpError("Codex вернул неверный список запросов");
    return parseMobileEditableTurn(response.data[0]);
  }

  /** Read a bounded list of recent user turns, newest first, for safe mobile editing. */
  async readMobileEditableTurns(threadId: string): Promise<CodexMobileEditableTurn[]> {
    return this.readMobileEditableTurnsInternal(threadId);
  }

  private async readMobileEditableTurnsInternal(threadId: string, retainTurnId?: string): Promise<CodexMobileEditableTurn[]> {
    if (!/^[a-z0-9_-]{8,128}$/i.test(threadId)) throw new Error("Неверный сеанс Codex для редактирования запроса");
    const response = await this.request("thread/turns/list", {
      threadId, limit: 20, sortDirection: "desc", itemsView: "full",
    }) as { data?: unknown };
    if (!Array.isArray(response?.data)) throw new AcpError("Codex вернул неверный список запросов");
    return response.data.flatMap((turn) => {
      const record = turn && typeof turn === "object" ? turn as Record<string, unknown> : undefined;
      const parsed = parseMobileEditableTurn(turn, record?.id === retainTurnId);
      return parsed ? [parsed] : [];
    });
  }

  /** Revalidate the selected turn and latest-turn snapshot before changing history. */
  async revertMobileThread(threadId: string, beforeTurnId: string, expectedLatestTurnId?: string): Promise<CodexMobileEditableTurn> {
    if (!/^[a-z0-9_-]{8,128}$/i.test(threadId) || !/^[a-z0-9_-]{8,128}$/i.test(beforeTurnId)) {
      throw new Error("Неверный запрос для редактирования истории Codex");
    }
    const turns = await this.readMobileEditableTurnsInternal(threadId, beforeTurnId);
    const latestTurnId = turns[0]?.turnId;
    if (!latestTurnId || (expectedLatestTurnId && latestTurnId !== expectedLatestTurnId)) {
      throw new AcpError("История Codex изменилась. Обновите список запросов перед редактированием");
    }
    const selected = turns.find((turn) => turn.turnId === beforeTurnId);
    if (!selected) throw new AcpError("Выбранный запрос больше не найден. Обновите список запросов перед редактированием");
    if (!selected.editable) throw new AcpError("Выбранный запрос нельзя безопасно редактировать с телефона");
    for (const path of selected.resendLocalImages ?? []) {
      try {
        if (!statSync(path).isFile()) throw new Error("not a file");
      } catch {
        throw new AcpError("Исходное изображение недоступно. История не изменена; восстановите вложение в Codex Desktop и повторите попытку");
      }
    }
    const result = await this.request("thread/revert", { threadId, beforeTurnId }) as {
      thread?: { id?: unknown };
    };
    if (result?.thread?.id !== threadId) throw new AcpError("Codex не подтвердил изменение истории сеанса");
    return selected;
  }

  /** Read only the MCP connections already associated with one Codex thread. */
  async listMobileMcpServers(threadId: string): Promise<CodexMcpServerStatus[]> {
    const servers: CodexMcpServerStatus[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.request("mcpServerStatus/list", {
        threadId, detail: "full", limit: 100, ...(cursor ? { cursor } : {}),
      }) as { data?: CodexMcpServerStatus[]; nextCursor?: string | null };
      servers.push(...(response?.data ?? []));
      cursor = response?.nextCursor ?? undefined;
    } while (cursor);
    return servers;
  }

  /** Invoke one MCP tool on the already-connected Codex thread after a live catalog check. */
  async callMobileMcpTool(
    threadId: string,
    serverName: string,
    toolName: string,
    argumentValue: unknown,
  ): Promise<ReturnType<typeof normalizeMobileMcpToolResult>> {
    if (!threadId.trim() || threadId.length > 128 || /[\u0000-\u001f\u007f]/.test(threadId) ||
        !serverName.trim() || serverName.length > 120 || /[\u0000-\u001f\u007f]/.test(serverName) ||
        !toolName.trim() || toolName.length > 120 || /[\u0000-\u001f\u007f]/.test(toolName)) {
      throw new Error("Выберите MCP-сервер и инструмент из текущего сеанса Codex");
    }
    const argumentsValue = validateMobileMcpArguments(argumentValue);
    const servers = await this.listMobileMcpServers(threadId);
    const server = servers.find((entry) => entry.name === serverName);
    if (!server || server.runtimeStatus !== "connected") {
      throw new Error("Сервер MCP не подключён к выбранному сеансу Codex");
    }
    if (!server.tools || !Object.hasOwn(server.tools, toolName)) {
      throw new Error("MCP-инструмент не найден в текущем каталоге сеанса Codex");
    }
    let response: unknown;
    try {
      response = await this.request("mcpServer/tool/call", {
        threadId, server: serverName, tool: toolName, arguments: argumentsValue,
      });
    } catch {
      throw new AcpError("Codex не смог выполнить MCP-инструмент");
    }
    return normalizeMobileMcpToolResult(response);
  }

  /** Read one MCP resource only after confirming it still belongs to the live thread catalog. */
  async readMobileMcpResource(
    threadId: string,
    serverName: string,
    uri: string,
    uriTemplate?: string,
  ): Promise<ReturnType<typeof normalizeMobileMcpResourceResult>> {
    if (!threadId.trim() || threadId.length > 128 || /[\u0000-\u001f\u007f]/.test(threadId) ||
        !serverName.trim() || serverName.length > 120 || /[\u0000-\u001f\u007f]/.test(serverName) ||
        !uri.trim() || uri.length > 2048 || /[\u0000-\u001f\u007f]/.test(uri)) {
      throw new Error("Выберите ресурс из текущего сеанса Codex");
    }
    const servers = await this.listMobileMcpServers(threadId);
    const server = servers.find((entry) => entry.name === serverName);
    if (!server || server.runtimeStatus !== "connected") {
      throw new Error("Сервер MCP не подключён к выбранному сеансу Codex");
    }
    if (uriTemplate) {
      if (!mobileMcpResourceUriMatchesTemplate(uriTemplate, uri) || !server.resourceTemplates?.some((entry) => {
        return entry !== null && typeof entry === "object" && !Array.isArray(entry) &&
          (entry as Record<string, unknown>).uriTemplate === uriTemplate;
      })) {
        throw new Error("MCP-шаблон не найден в текущем каталоге сеанса Codex");
      }
    } else if (!server.resources?.some((entry) => {
      return entry !== null && typeof entry === "object" && !Array.isArray(entry) &&
        (entry as Record<string, unknown>).uri === uri;
    })) {
      throw new Error("MCP-ресурс не найден в текущем каталоге сеанса Codex");
    }
    let response: unknown;
    try {
      response = await this.request("mcpServer/resource/read", { threadId, server: serverName, uri });
    } catch {
      throw new AcpError("Codex не смог прочитать MCP-ресурс");
    }
    return normalizeMobileMcpResourceResult(response);
  }

  /** Read the current skill inventory for one authorized project directory. */
  async listMobileSkills(cwd: string): Promise<CodexSkillInfo[]> {
    const response = await this.request("skills/list", { cwds: [cwd], forceReload: true }) as {
      data?: Array<{ skills?: CodexSkillInfo[] }>;
    };
    return (response?.data ?? []).flatMap((entry) => entry.skills ?? [])
      .filter((skill) => typeof skill.name === "string" && skill.name.length > 0);
  }

  /** Toggle one uniquely identified user/repo skill through Codex's config API. */
  async setMobileSkillEnabled(name: string, enabled: boolean, cwd: string): Promise<boolean> {
    if (!name.trim() || name.length > 160 || typeof enabled !== "boolean") {
      throw new Error("Неверные параметры навыка Codex");
    }
    const matches = (await this.listMobileSkills(cwd)).filter((skill) => skill.name === name);
    if (matches.length === 0) throw new Error("Навык не найден в текущем проекте Codex");
    if (matches.length > 1) throw new Error("Навык нельзя однозначно выбрать по названию");
    const skill = matches[0]!;
    if (skill.scope !== "user" && skill.scope !== "repo") {
      throw new Error("Этот навык управляется Codex или администратором, его нельзя менять с телефона");
    }
    const response = await this.request("skills/config/write", { name, enabled }) as { effectiveEnabled?: unknown };
    if (typeof response?.effectiveEnabled !== "boolean") {
      throw new AcpError("Codex не подтвердил итоговое состояние навыка");
    }
    return response.effectiveEnabled;
  }

  /** Resolve selected skill names to Codex-owned paths for explicit turn input. */
  private async inputForThread(sessionId: string, content: ContentBlock[]): Promise<CodexUserInput[]> {
    const input = toCodexInput(content);
    const names = [...new Set(content
      .filter((block) => block.type === "skill" && typeof block.name === "string")
      .map((block) => block.name!.trim())
      .filter(Boolean))];
    const rawAppIds = content
      .filter((block) => block.type === "appMention")
      .map((block) => block.id);
    if (rawAppIds.some((id) => typeof id !== "string" || !MOBILE_APP_ID_PATTERN.test(id))) {
      throw new AcpError("Выбран неверный идентификатор Codex App");
    }
    const appIds = [...new Set(rawAppIds as string[])];

    const mentions: Array<Extract<CodexUserInput, { type: "mention" }>> = [];
    const appTokens: string[] = [];
    if (appIds.length) {
      const [catalog, installed] = await Promise.all([
        this.request("app/list", { limit: 100, threadId: sessionId }).catch(() => undefined),
        this.request("app/installed", {}).catch(() => undefined),
      ]);
      const catalogApps = mobileAppList(catalog);
      const installedApps = mobileAppRecord(installed)?.apps;
      const installedRecords = Array.isArray(installedApps)
        ? installedApps.flatMap((entry) => {
          const app = mobileAppRecord(entry);
          return app ? [app] : [];
        })
        : [];
      for (const id of appIds) {
        const matches = catalogApps.filter((app) => app.id === id);
        const installedMatches = installedRecords.filter((app) => app.id === id);
        const app = matches[0];
        const state = installedMatches[0];
        if (matches.length !== 1 || installedMatches.length !== 1 ||
            app?.isAccessible !== true || app.isEnabled === false ||
            state?.callable !== true || state.enabled === false) {
          throw new AcpError("Выбранное Codex App сейчас недоступно или не подключено для этого сеанса");
        }
        const name = typeof app.name === "string"
          ? app.name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160)
          : "";
        const safeName = name || id;
        const slug = codexAppSlug(safeName);
        if (!slug) throw new AcpError("У выбранного Codex App не получилось определить имя для вызова");
        appTokens.push(`$${slug}`);
        mentions.push({ type: "mention", name: safeName, path: `app://${id}` });
      }
    }
    if (names.length === 0 && appIds.length === 0) return input;

    const cwd = this.threadCwd.get(sessionId);
    if (names.length) {
      if (!cwd) throw new AcpError("Для выбранного навыка не определена папка проекта Codex");
      const inventory = await this.listMobileSkills(cwd);
      for (const name of names) {
        const matches = inventory.filter((skill) => skill.name === name);
        if (matches.length !== 1 || matches[0]!.enabled === false || !matches[0]!.path) {
          throw new AcpError("Выбранный навык Codex отключён, недоступен или неоднозначен");
        }
        input.push({ type: "skill", name, path: matches[0]!.path! });
      }
    }
    if (mentions.length) {
      const appTokenText = appTokens.join(" ");
      const firstText = input.find((item): item is Extract<CodexUserInput, { type: "text" }> => item.type === "text");
      if (firstText) firstText.text = `${appTokenText}\n\n${firstText.text}`;
      else input.unshift({ type: "text", text: appTokenText });
      input.push(...mentions);
    }
    return input;
  }

  /** Install only a remote plugin that is present and installable in Codex's live catalog. */
  async installMobilePlugin(pluginId: string, marketplaceName: string, cwd: string): Promise<unknown> {
    const [catalog, installed] = await Promise.all([
      this.request("plugin/list", { cwds: [cwd] }),
      this.request("plugin/installed", {}),
    ]);
    if (installedPluginExists(installed, pluginId)) throw new Error("Плагин уже установлен");
    const target = resolveRemotePluginInstall(catalog, pluginId, marketplaceName);
    const result = await this.request("plugin/install", {
      ...target,
      installAttemptId: randomUUID(),
    });
    await this.refreshInventories();
    return result;
  }

  /** Remove only a plugin that the running Codex app-server reports as installed. */
  async uninstallMobilePlugin(pluginId: string): Promise<void> {
    const installed = await this.request("plugin/installed", {});
    if (!installedPluginExists(installed, pluginId)) throw new Error("Плагин не найден среди установленных в Codex");
    await this.request("plugin/uninstall", { pluginId });
    await this.refreshInventories();
  }

  private async loadCapabilities(): Promise<void> {
    await Promise.all([
      this.loadCollaborationModes(),
      this.request("skills/list", { cwds: [this.opts.workspace] })
        .then((r) => {
          const entries = (r as { data?: Array<{ skills?: CodexSkillInfo[] }> })?.data ?? [];
          this.availableSkills = entries.flatMap((e) => e.skills ?? []);
        })
        .catch((e) => {
          this.availableSkills = [];
          log.debug("skills/list unavailable:", (e as Error).message);
        }),
      this.loadMcpStatuses(),
    ]);
  }

  private async loadCollaborationModes(): Promise<void> {
    try {
      const res = (await this.request("collaborationMode/list", {})) as CodexCollaborationModeListResult;
      const modes = res?.data ?? [];
      this.collaborationModes.clear();
      for (const mode of modes) this.collaborationModes.set(mode.name, mode);
      this.availableModes = modes.map((m) => ({
        id: m.name,
        name: m.name,
        description: [m.mode, m.model, m.reasoning_effort].filter(Boolean).join(" · ") || undefined,
      }));
    } catch (e) {
      this.collaborationModes.clear();
      this.availableModes = [];
      log.debug("collaborationMode/list unavailable:", (e as Error).message);
    }
  }

  private async loadMcpStatuses(): Promise<void> {
    try {
      const all: CodexMcpServerStatus[] = [];
      let cursor: string | undefined;
      do {
        const r = (await this.request("mcpServerStatus/list", { detail: "full", limit: 100, cursor })) as {
          data?: CodexMcpServerStatus[];
          nextCursor?: string | null;
        };
        all.push(...(r.data ?? []));
        cursor = r.nextCursor ?? undefined;
      } while (cursor);
      this.availableMcpServers = all;
    } catch (e) {
      this.availableMcpServers = [];
      log.debug("mcpServerStatus/list unavailable:", (e as Error).message);
    }
  }

  /** Live identity and quota state reported by the running app-server. */
  async accountState(): Promise<{
    account?: CodexAccountInfo;
    rateLimits?: CodexRateLimitSnapshot;
    rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot>;
  }> {
    const [account, limits] = await Promise.all([
      this.request("account/read", { refreshToken: false }).catch(() => undefined),
      this.request("account/rateLimits/read", undefined).catch(() => undefined),
    ]);
    const a = account as { account?: CodexAccountInfo | null } | undefined;
    const l = limits as {
      rateLimits?: CodexRateLimitSnapshot;
      rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot> | null;
    } | undefined;
    return {
      account: a?.account ?? undefined,
      rateLimits: l?.rateLimits,
      rateLimitsByLimitId: l?.rateLimitsByLimitId ?? undefined,
    };
  }

  /** Start Codex's native ChatGPT device-code sign-in without exposing tokens to the caller. */
  async startChatgptDeviceCodeLogin(): Promise<CodexDeviceCodeLogin> {
    const response = await this.request("account/login/start", { type: "chatgptDeviceCode" }) as Record<string, unknown>;
    const loginId = typeof response?.loginId === "string" ? response.loginId : "";
    const verificationUrl = typeof response?.verificationUrl === "string" ? response.verificationUrl : "";
    const userCode = typeof response?.userCode === "string" ? response.userCode : "";
    const validLoginId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(loginId);
    const cancelInvalidLogin = async () => {
      if (validLoginId) await this.request("account/login/cancel", { loginId }).catch(() => undefined);
    };
    if (response?.type !== "chatgptDeviceCode" || !validLoginId) {
      await cancelInvalidLogin();
      throw new Error("Codex вернул неверный ответ для входа по коду");
    }
    let url: URL;
    try { url = new URL(verificationUrl); }
    catch { await cancelInvalidLogin(); throw new Error("Codex вернул неверную ссылку входа"); }
    if (url.protocol !== "https:" || url.hostname !== "auth.openai.com" || url.pathname !== "/codex/device" || url.username || url.password || url.search || url.hash) {
      await cancelInvalidLogin();
      throw new Error("Codex вернул небезопасную ссылку входа");
    }
    if (!/^[A-Z0-9-]{4,32}$/.test(userCode)) {
      await cancelInvalidLogin();
      throw new Error("Codex вернул неверный одноразовый код");
    }
    return { loginId, verificationUrl: url.toString(), userCode };
  }

  /** Cancel only a login that this client started and still tracks locally. */
  async cancelAccountLogin(loginId: string): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(loginId)) {
      throw new Error("Неверный ID входа Codex");
    }
    await this.request("account/login/cancel", { loginId });
  }

  /** Populate the model catalogue via `model/list` (best-effort). */
  private async loadModels(): Promise<void> {
    try {
      const list: CodexModelInfo[] = [];
      let cursor: string | undefined;
      do {
        const res = (await this.request("model/list", { cursor, limit: 100, includeHidden: false })) as CodexModelListResult;
        list.push(...(res?.data ?? res?.models ?? []));
        cursor = res?.nextCursor ?? undefined;
      } while (cursor);
      this.availableModels = list.map((m) => ({
        modelId: m.model ?? m.id ?? "",
        name: m.displayName ?? m.model ?? m.id ?? "",
        description: m.description,
      })).filter((m) => m.modelId);
      const def = list.find((m) => m.isDefault);
      if (!this.currentModelId || !this.availableModels.some((m) => m.modelId === this.currentModelId)) {
        this.currentModelId = def?.model ?? def?.id;
      }
    } catch (e) {
      this.availableModels = [];
      log.debug("model/list unavailable:", (e as Error).message);
    }
  }


  private maybeRestart(): void {
    if (this.stopped || !this.opts.autoRestart) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.restartAttempts);
    this.restartAttempts += 1;
    log.warn(`auto-restarting app-server in ${delay}ms (attempt ${this.restartAttempts})`);
    this.restartTimer = setTimeout(() => {
      this.connect()
        .then(() => {
          log.info("app-server reconnected");
          this.emit("restarted");
        })
        .catch((e) => {
          log.error("app-server restart failed:", (e as Error).message);
          this.maybeRestart();
        });
    }, delay);
  }

  get supportsLoadSession(): boolean {
    return true; // Codex supports thread/resume
  }

  /** True while any turn awaits a `turn/completed` — i.e. the agent is working. */
  hasInflightPrompt(): boolean {
    return this.turns.size > 0;
  }

  /** PID of the bot's own codex app-server process (to avoid killing ourselves). */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  async newSession(cwd: string): Promise<string> {
    const params: Record<string, unknown> = { cwd };
    const model = this.modelFor(undefined);
    if (model) params.model = model;
    params.sandbox = this.opts.trustAllTools ? "danger-full-access" : "workspace-write";
    const res = (await this.request("thread/start", params)) as CodexThreadResponse;
    const id = res?.thread?.id;
    if (!id) throw new AcpError("thread/start returned no thread id");
    this.threadCwd.set(id, cwd);
    return id;
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    // Field casing has varied across Codex builds (camelCase vs snake_case);
    // try the canonical camelCase, fall back to snake_case on an argument error.
    try {
      await this.request("thread/resume", { threadId: sessionId });
    } catch (e) {
      const msg = (e as Error).message.toLowerCase();
      if (/thread_?id|missing field|unknown field|invalid params|-32602/.test(msg)) {
        await this.request("thread/resume", { thread_id: sessionId });
      } else {
        throw e;
      }
    }
    this.threadCwd.set(sessionId, cwd);
  }

  /** Return Codex's own project catalogue. This experimental method may not
   *  exist in older app-server builds; callers can fall back to thread/list. */
  async listProjects(): Promise<CodexProjectSummary[]> {
    const byId = new Map<string, CodexProjectSummary>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const response = await this.request("project/list", cursor ? { cursor } : {}) as CodexProjectListResponse;
      const projects = response?.projects ?? response?.data ?? [];
      if (Array.isArray(projects)) {
        for (const project of projects) if (typeof project?.id === "string") byId.set(project.id, project);
      }
      const next = response?.nextCursor ?? undefined;
      if (!next || next === cursor || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    return [...byId.values()];
  }

  /** List persisted Codex threads with the app-server's native filters. */
  async listThreads(params: CodexThreadListParams = {}): Promise<CodexThreadSummary[]> {
    return (await this.listThreadsPage(params)).threads;
  }

  /** Read one native page, retaining its cursor for bounded callers. */
  async listThreadsPage(params: CodexThreadListParams = {}): Promise<{ threads: CodexThreadSummary[]; nextCursor?: string }> {
    const response = await this.request("thread/list", params) as CodexThreadListResponse;
    const threads = response?.threads ?? response?.data ?? [];
    const rawReadStates = response?.readStates;
    const readStates = rawReadStates && typeof rawReadStates === "object" && !Array.isArray(rawReadStates) ? rawReadStates : undefined;
    const readStateMetadataAvailable = readStates !== undefined;
    return {
      threads: Array.isArray(threads) ? threads.filter((thread) => typeof thread?.id === "string").map((thread) => {
        if (!readStateMetadataAvailable) return thread;
        const receipt = readStates && Object.hasOwn(readStates, thread.id) ? parseCodexThreadReadState(readStates[thread.id]) : undefined;
        return {
          ...thread,
          readStateMetadataAvailable: true,
          readStateEligible: receipt !== undefined,
          ...(receipt ? { readState: receipt } : {}),
        };
      }) : [],
      nextCursor: typeof response?.nextCursor === "string" ? response.nextCursor : undefined,
    };
  }

  /** Update Codex's native read receipt using the exact revision shown to the caller. */
  async updateThreadReadState(threadId: string, expectedRevision: string, operation: "read" | "unread"): Promise<CodexThreadReadState> {
    if (typeof threadId !== "string" || !threadId.trim() || threadId.length > 200 || /[\u0000-\u001f\u007f]/.test(threadId)) {
      throw new Error("Неверный идентификатор сеанса для изменения статуса прочтения");
    }
    if (typeof expectedRevision !== "string" || !expectedRevision || expectedRevision.length > 512) {
      throw new Error("Codex не предоставил версию статуса прочтения");
    }
    if (operation !== "read" && operation !== "unread") throw new Error("Неизвестное действие со статусом прочтения");
    const response = await this.request("thread/readState/update", {
      threadId,
      expectedRevision,
      operation: { type: operation },
    }) as { readState?: unknown };
    const receipt = parseCodexThreadReadState(response?.readState);
    if (!receipt) throw new Error("Codex вернул недопустимый статус прочтения");
    return receipt;
  }

  /** Read every page of the Codex conversation catalogue. */
  async listAllThreads(params: CodexThreadListParams = {}): Promise<CodexThreadSummary[]> {
    const byId = new Map<string, CodexThreadSummary>();
    const seenCursors = new Set<string>();
    let cursor = params.cursor;
    for (let page = 0; page < 1000; page++) {
      const pageParams = { ...params };
      if (cursor) pageParams.cursor = cursor;
      else delete pageParams.cursor;
      const { threads, nextCursor: next } = await this.listThreadsPage(pageParams);
      for (const thread of threads) byId.set(thread.id, thread);
      if (!next || next === cursor || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    return [...byId.values()];
  }

  /** Read all user-created sidebar sections through the shared app-server. */
  async listThreadSections(): Promise<CodexThreadSection[]> {
    const byId = new Map<string, CodexThreadSection>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const params = cursor ? { limit: 100, cursor } : { limit: 100 };
      const response = await this.request("threadSection/list", params) as {
        data?: CodexThreadSection[];
        sections?: CodexThreadSection[];
        nextCursor?: string | null;
      };
      const sections = response?.data ?? response?.sections ?? [];
      if (Array.isArray(sections)) {
        for (const section of sections) {
          if (typeof section?.id === "string" && typeof section.name === "string") byId.set(section.id, section);
        }
      }
      const next = typeof response?.nextCursor === "string" ? response.nextCursor : undefined;
      if (!next || next === cursor || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    return [...byId.values()];
  }

  async createThreadSection(name: string): Promise<CodexThreadSection> {
    const response = await this.request("threadSection/create", { name }) as { section?: CodexThreadSection };
    if (!response?.section?.id || typeof response.section.name !== "string") throw new AcpError("threadSection/create returned no section");
    return response.section;
  }

  async renameThreadSection(sectionId: string, name: string): Promise<CodexThreadSection> {
    const response = await this.request("threadSection/update", { sectionId, name }) as { section?: CodexThreadSection };
    if (!response?.section?.id || typeof response.section.name !== "string") throw new AcpError("threadSection/update returned no section");
    return response.section;
  }

  async deleteThreadSection(sectionId: string): Promise<void> {
    await this.request("threadSection/delete", { sectionId });
  }

  async moveThreadToSection(threadId: string, sectionId: string | null): Promise<void> {
    await this.request("thread/section/move", { threadId, sectionId });
  }

  /** Rename a persisted Codex thread using the app-server's native metadata API. */
  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.request("thread/name/set", { threadId, name });
  }

  /** Archive a persisted Codex thread without deleting its history. */
  async archiveThread(threadId: string): Promise<void> {
    await this.request("thread/archive", { threadId });
  }

  /** Restore a previously archived Codex thread. */
  async unarchiveThread(threadId: string): Promise<void> {
    await this.request("thread/unarchive", { threadId });
  }

  /** Permanently delete an archived local Codex thread through the app-server. */
  async deleteThread(threadId: string): Promise<void> {
    await this.request("thread/delete", { threadId });
  }

  /** Fork an idle persisted thread through the same Codex app-server process. */
  async forkThread(threadId: string, options: { ephemeral?: boolean; excludeTurns?: boolean } = {}): Promise<CodexThreadForkResponse> {
    const response = await this.request("thread/fork", { threadId, ...options }) as CodexThreadForkResponse;
    if (!response?.thread?.id) throw new AcpError("thread/fork returned no thread id");
    if (response.cwd) this.threadCwd.set(response.thread.id, response.cwd);
    if (response.model) this.threadModel.set(response.thread.id, response.model);
    return response;
  }

  /** Start Codex's experimental WebRTC voice transport on the existing thread. */
  async listRealtimeVoices(): Promise<{ voices: string[]; defaultVoice: string }> {
    const response = await this.request("thread/realtime/listVoices", {}) as {
      voices?: { v1?: unknown; v2?: unknown; v3?: unknown; defaultV1?: unknown; defaultV2?: unknown };
    };
    const source = response?.voices ?? {};
    const safeVoices = [source.v1, source.v2, source.v3]
      .flatMap((group) => Array.isArray(group) ? group : [])
      .filter((voice): voice is string => typeof voice === "string" && /^[a-z][a-z0-9_]{0,31}$/i.test(voice));
    const voices = [...new Set(safeVoices)].slice(0, 64);
    const preferred = [source.defaultV2, source.defaultV1].find((voice): voice is string =>
      typeof voice === "string" && voices.includes(voice));
    return { voices, defaultVoice: preferred ?? voices[0] ?? "" };
  }

  async startRealtime(threadId: string, offerSdp: string, voice?: string): Promise<string> {
    if (!/^[a-z0-9_-]{8,128}$/i.test(threadId)) throw new Error("Неверный сеанс Codex для голосового режима");
    if (typeof offerSdp !== "string" || offerSdp.length > 128_000 || !/^v=0\r?$/m.test(offerSdp) ||
        !/^m=audio\s/m.test(offerSdp) || !/^m=application\s/m.test(offerSdp)) {
      throw new Error("Браузер не сформировал корректное аудиосоединение");
    }
    if (voice !== undefined && (typeof voice !== "string" || !/^[a-z][a-z0-9_]{0,31}$/i.test(voice))) {
      throw new Error("Неверный голос Codex");
    }
    if (this.realtimeThreads.has(threadId)) throw new Error("Голосовой режим уже подключён к этому сеансу");

    let resolveSdp!: (sdp: string) => void;
    let rejectSdp!: (error: Error) => void;
    const answer = new Promise<string>((resolve, reject) => { resolveSdp = resolve; rejectSdp = reject; });
    const onNotification = (method: string, value: unknown) => {
      const params = value && typeof value === "object" ? value as Record<string, unknown> : {};
      if (params.threadId !== threadId) return;
      if (method === "thread/realtime/sdp") {
        const sdp = params.sdp;
        if (typeof sdp === "string" && sdp.length <= 128_000 && /^v=0\r?$/m.test(sdp)) {
          this.realtimeThreads.add(threadId);
          resolveSdp(sdp);
        } else rejectSdp(new Error("Неверный SDP-ответ Codex"));
      } else if (method === "thread/realtime/error" || method === "thread/realtime/closed") {
        rejectSdp(new Error("Codex закрыл голосовое соединение"));
      }
    };
    this.on("notification", onNotification);
    let timeout: NodeJS.Timeout | undefined;
    try {
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Codex не ответил на запрос голосового соединения")), 20_000);
        timeout.unref();
      });
      const startup = (async () => {
        await this.request("thread/realtime/start", {
          threadId,
          outputModality: "audio",
          transport: { type: "webrtc", sdp: offerSdp },
          ...(voice ? { voice } : {}),
        });
        return await answer;
      })();
      return await Promise.race([startup, timedOut]);
    } catch {
      this.realtimeThreads.delete(threadId);
      void this.request("thread/realtime/stop", { threadId }).catch(() => undefined);
      throw new AcpError("Codex не смог начать голосовой сеанс. Проверьте вход и поддержку Live в текущей версии Codex.");
    } finally {
      if (timeout) clearTimeout(timeout);
      this.off("notification", onNotification);
    }
  }

  /** Stop only the realtime transport attached to this existing thread. */
  async stopRealtime(threadId: string): Promise<void> {
    if (!/^[a-z0-9_-]{8,128}$/i.test(threadId)) throw new Error("Неверный сеанс Codex для остановки голоса");
    if (!this.realtimeThreads.has(threadId)) return;
    await this.request("thread/realtime/stop", { threadId });
    this.realtimeThreads.delete(threadId);
  }

  isRealtimeActive(threadId: string): boolean {
    return this.realtimeThreads.has(threadId);
  }

  hasActiveTurn(threadId: string): boolean {
    return this.turns.has(threadId);
  }

  async getThreadGoal(threadId: string): Promise<CodexThreadGoal | undefined> {
    const response = await this.request("thread/goal/get", { threadId }) as { goal?: CodexThreadGoal | null };
    return response?.goal ?? undefined;
  }

  async setThreadGoal(threadId: string, input: {
    objective?: string;
    status?: CodexThreadGoalStatus;
    tokenBudget?: number | null;
  }): Promise<CodexThreadGoal> {
    if (input.objective !== undefined && (!input.objective.trim() || input.objective.length > 1000)) {
      throw new Error("Цель должна содержать от 1 до 1000 символов");
    }
    if (input.status !== undefined && !["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(input.status)) {
      throw new Error("Неизвестный статус цели");
    }
    if (input.tokenBudget !== undefined && input.tokenBudget !== null &&
        (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget < 1 || input.tokenBudget > 1_000_000_000)) {
      throw new Error("Бюджет должен быть целым числом от 1 до 1 000 000 000 токенов");
    }
    if (input.objective === undefined && input.status === undefined && input.tokenBudget === undefined) {
      throw new Error("Укажите, что нужно изменить в цели");
    }
    const response = await this.request("thread/goal/set", { threadId, origin: "user", ...input }) as { goal?: CodexThreadGoal };
    if (!response?.goal) throw new AcpError("thread/goal/set returned no goal");
    return response.goal;
  }

  async clearThreadGoal(threadId: string): Promise<{ cleared: boolean }> {
    return await this.request("thread/goal/clear", { threadId, origin: "user" }) as { cleared: boolean };
  }

  async compactThread(threadId: string): Promise<void> {
    if (this.hasActiveTurn(threadId)) throw new Error("Нельзя сократить контекст во время активного хода Codex");
    await this.request("thread/compact/start", { threadId });
  }

  /** Start Codex's native reviewer on an existing thread. */
  async reviewThread(threadId: string, target: CodexReviewTarget, delivery: CodexReviewDelivery = "inline"): Promise<CodexReviewStartResponse> {
    const response = await this.request("review/start", { threadId, target, delivery }) as CodexReviewStartResponse;
    if (!response?.reviewThreadId || !response.turn?.id) throw new AcpError("review/start returned no review thread or turn");
    return response;
  }

  hasMode(id: string): boolean {
    return this.collaborationModes.has(id);
  }

  hasModel(id: string): boolean {
    if (!id || id === "auto") return true;
    if (this.availableModels.length === 0) return true;
    return this.availableModels.some((m) => m.modelId === id);
  }

  /** Read the live thread model and effort settings without hydrating history. */
  async readMobileThreadSettings(threadId: string): Promise<{ model?: string | null; effort?: string | null }> {
    if (!/^[a-z0-9_-]{8,128}$/i.test(threadId)) throw new Error("Неверный сеанс Codex для чтения настроек");
    const response = await this.request("thread/read", { threadId, includeTurns: false }) as {
      thread?: { id?: unknown; model?: unknown; reasoningEffort?: unknown; reasoning_effort?: unknown };
    };
    const thread = response?.thread;
    if (thread?.id !== threadId) throw new AcpError("Codex не подтвердил настройки выбранного сеанса");
    const model = typeof thread.model === "string" ? thread.model : thread.model === null ? null : undefined;
    const rawEffort = Object.prototype.hasOwnProperty.call(thread, "reasoningEffort")
      ? thread.reasoningEffort
      : thread.reasoning_effort;
    const effort = typeof rawEffort === "string" ? rawEffort : rawEffort === null ? null : undefined;
    if (model !== undefined) this.threadModel.set(threadId, model);
    if (effort !== undefined) this.threadEffort.set(threadId, effort);
    return { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) };
  }

  /** Persist mobile model/mode/reasoning choices on the owned native Codex thread. */
  async updateMobileThreadSettings(
    threadId: string,
    patch: { modelId?: string | null; modeId?: string | null; effort?: string | null },
  ): Promise<void> {
    if (!/^[a-z0-9_-]{8,128}$/i.test(threadId)) throw new Error("Неверный сеанс Codex для изменения настроек");
    if (patch.modelId === undefined && patch.modeId === undefined && patch.effort === undefined) {
      throw new Error("Выберите настройку Codex для изменения");
    }
    const modelId = patch.modelId === "default" ? null : patch.modelId;
    const modeId = patch.modeId === "default" ? null : patch.modeId;
    if (modelId !== undefined && modelId !== null && (!modelId.trim() || modelId.length > 160 || !this.hasModel(modelId))) {
      throw new Error("Эта модель сейчас недоступна");
    }
    if (modeId !== undefined && modeId !== null && (modeId.length > 100 || !this.hasMode(modeId))) {
      throw new Error("Этот режим сейчас недоступен");
    }
    if (patch.effort !== undefined && patch.effort !== null && !REASONING_LEVELS.includes(patch.effort as ReasoningEffort)) {
      throw new Error("Недопустимый уровень рассуждений");
    }

    const params: CodexThreadSettingsUpdateParams = { threadId };
    if (modelId !== undefined) params.model = modelId;
    if (patch.effort !== undefined) params.effort = patch.effort;
    if (modeId !== undefined) {
      if (modeId === null) params.collaborationMode = null;
      else {
        const mode = this.collaborationModes.get(modeId);
        if (!mode?.mode) throw new Error("Нативная настройка этого режима сейчас недоступна");
        const configuredModel = modelId !== undefined
          ? modelId
          : this.threadModel.has(threadId) ? this.threadModel.get(threadId) : this.currentModelId;
        const configuredEffort = patch.effort !== undefined
          ? patch.effort
          : this.threadEffort.get(threadId) ?? mode.reasoning_effort ?? null;
        params.collaborationMode = {
          mode: mode.mode,
          settings: {
            model: configuredModel ?? mode.model ?? "",
            reasoning_effort: configuredEffort,
            developer_instructions: null,
          },
        };
      }
    }
    await this.request("thread/settings/update", params);
    if (modelId !== undefined) this.threadModel.set(threadId, modelId);
    if (modeId !== undefined) this.threadMode.set(threadId, modeId);
    if (patch.effort !== undefined) this.threadEffort.set(threadId, patch.effort);
  }

  /** Resolve the model id to send for a thread: per-thread → default → none. */
  private modelFor(threadId: string | undefined): string | undefined {
    const pref = threadId && this.threadModel.has(threadId) ? this.threadModel.get(threadId) : this.currentModelId;
    if (!pref || pref === "auto") return undefined;
    return pref;
  }

  /**
   * Start a turn and resolve when Codex sends `turn/completed`. `turn/start`
   * returns immediately with an in-progress turn (whose id we keep for cancel);
   * completion arrives asynchronously as a notification.
   */
  prompt(sessionId: string, content: ContentBlock[]): Promise<PromptResult> {
    return new Promise<PromptResult>((resolve, reject) => {
      const start = Date.now();
      this.lastActivity.set(sessionId, start);
      const watch = setInterval(() => {
        const last = this.lastActivity.get(sessionId) ?? start;
        const idle = Date.now() - last;
        const total = Date.now() - start;
        if (this.promptMaxMs !== undefined && total > this.promptMaxMs) {
          void this.cancel(sessionId);
          this.finishTurn(sessionId, "reject", new Error(`Prompt exceeded the ${Math.round(this.promptMaxMs / 60_000)}min cap`));
        } else if (idle > this.promptIdleMs) {
          void this.cancel(sessionId);
          this.finishTurn(sessionId, "reject", new Error(`No agent activity for ${Math.round(idle / 1000)}s — giving up`));
        }
      }, 15_000);

      const prev = this.turns.get(sessionId);
      if (prev) {
        clearInterval(prev.watch);
        if (prev.terminalErrorTimer) clearTimeout(prev.terminalErrorTimer);
        prev.reject(new AcpError("superseded by a new turn"));
      }
      this.turns.set(sessionId, { threadId: sessionId, resolve, reject, watch, start });

      const params: CodexTurnStartParams = {
        threadId: sessionId,
        input: toCodexInput(content),
        cwd: this.threadCwd.get(sessionId),
        // Workspace writes and commands are already bounded by workspaceWrite.
        // Network can be enabled independently; explicit permission expansions
        // outside the workspace still go through the user's approval flow.
        approvalPolicy: "never",
        sandboxPolicy: this.opts.trustAllTools
          ? { type: "dangerFullAccess" }
          : { type: "workspaceWrite", writableRoots: [this.threadCwd.get(sessionId) ?? this.opts.workspace], networkAccess: this.opts.networkAccess ?? false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      };
      const model = this.modelFor(sessionId);
      if (model) params.model = model;
      const effort = this.threadEffort.get(sessionId);
      if (effort) params.effort = effort;
      const modeId = this.threadMode.has(sessionId) ? this.threadMode.get(sessionId) : this.currentModeId;
      const mode = this.collaborationModes.get(modeId ?? "");
      if (mode?.mode) {
        const modeModel = this.threadModel.has(sessionId) ? model : mode.model ?? model;
        const modeEffort = this.threadEffort.has(sessionId) ? effort ?? null : mode.reasoning_effort ?? null;
        params.collaborationMode = {
          mode: mode.mode,
          settings: {
            model: modeModel ?? "",
            reasoning_effort: modeEffort,
            developer_instructions: null,
          },
        };
      }

      void this.inputForThread(sessionId, content)
        .then((input) => {
          params.input = input;
          return this.request("turn/start", params);
        })
        .then((res) => {
          const turn = (res as CodexTurnResponse)?.turn;
          const p = this.turns.get(sessionId);
          if (p && turn?.id) p.turnId = turn.id;
        })
        .catch((err) => this.finishTurn(sessionId, "reject", err as Error));
    });
  }

  /** Resolve/reject the in-flight turn for a thread and clean it up. */
  private finishTurn(threadId: string, how: "resolve" | "reject", value: PromptResult | Error): void {
    const p = this.turns.get(threadId);
    if (!p) return;
    clearInterval(p.watch);
    if (p.terminalErrorTimer) clearTimeout(p.terminalErrorTimer);
    this.turns.delete(threadId);
    this.lastActivity.delete(threadId);
    if (how === "resolve") p.resolve(value as PromptResult);
    else p.reject(value as Error);
  }

  private threadByTurnId(turnId: string | undefined): string | undefined {
    if (!turnId) return undefined;
    for (const [tid, p] of this.turns) if (p.turnId === turnId) return tid;
    return undefined;
  }

  async cancel(sessionId: string): Promise<void> {
    const turnId = this.turns.get(sessionId)?.turnId;
    try {
      if (turnId) await this.request("turn/interrupt", { threadId: sessionId, turnId });
    } catch (e) {
      log.debug("interrupt failed:", (e as Error).message);
    }
  }

  /** True only while this shared app-server client owns a steerable turn. */
  canSteer(sessionId: string): boolean {
    return this.connected && !!this.turns.get(sessionId)?.turnId;
  }

  /** Add user guidance to the active turn without starting another turn. */
  async steer(sessionId: string, content: ContentBlock[]): Promise<void> {
    const active = this.turns.get(sessionId);
    if (!this.connected || !active?.turnId) throw new AcpError("Нет активной задачи Codex, которую можно направить");
    const expectedTurnId = active.turnId;
    const response = await this.request("turn/steer", {
      threadId: sessionId,
      expectedTurnId,
      input: await this.inputForThread(sessionId, content),
    }) as { turnId?: unknown };
    if (typeof response?.turnId !== "string" || response.turnId !== expectedTurnId) {
      throw new AcpError("Codex не подтвердил, к какой активной задаче применено направление");
    }
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    this.threadModel.set(sessionId, modelId);
    this.currentModelId = modelId;
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    if (!this.hasMode(modeId)) throw new AcpError(`Unknown Codex collaboration mode: ${modeId}`);
    this.threadMode.set(sessionId, modeId);
    this.currentModeId = modeId;
  }

  stop(): void {
    this.stopped = true;
    this.connected = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    void this.killCurrent();
  }

  async stopAndWait(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    await this.killCurrent();
  }

  async restart(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.stopped = true;
    this.restartAttempts = 0;
    await this.killCurrent();
    this.stopped = false;
    await this.connect();
    this.emit("restarted");
  }

  private killCurrent(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    this.transport = undefined;
    this.failAllPending(new Error("codex app-server is restarting"));
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(hard);
        resolve();
      };
      const hard = setTimeout(() => {
        try {
          if (process.platform === "win32" && proc.pid) killPid(proc.pid);
          else proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        setTimeout(done, 500);
      }, 4000);
      proc.once("exit", done);
      try {
        // On Windows a shell-launched codex runs under a cmd.exe wrapper, so kill
        // the whole tree (taskkill /T) — otherwise the codex.exe (and any tools
        // it spawned) would be orphaned on restart. On POSIX a plain signal to
        // the process group child suffices, with SIGKILL escalation above.
        if (process.platform === "win32" && proc.pid) killPid(proc.pid);
        else proc.kill();
      } catch {
        done();
      }
    });
  }

  // ── JSON-RPC plumbing (jsonrpc header omitted, matching Codex) ───────────────

  private send(msg: object): void {
    this.transport!.send(msg);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout after ${this.timeout}ms: ${method}`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, cleanup: () => clearTimeout(timer), method });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  private errorFrom(error: { code: number; message: string; data?: unknown }, method: string): AcpError {
    const e = toAcpError(error);
    log.warn(`${method} failed: ${e.message}`);
    return e;
  }

  private onMessage(msg: JsonRpcMessage): void {
    // Response to one of our requests.
    if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id) && msg.method === undefined) {
      const p = this.pending.get(msg.id)!;
      p.cleanup();
      this.pending.delete(msg.id);
      if (msg.error) p.reject(this.errorFrom(msg.error, p.method));
      else p.resolve(msg.result);
      return;
    }
    // Request from the server (has both id and method) — needs a response.
    if (msg.id !== undefined && msg.id !== null && msg.method) {
      void this.respondToServerRequest(msg.id, msg.method, (msg.params as Record<string, unknown>) || {});
      return;
    }
    // Notification (method, no id).
    if (msg.method) this.routeNotification(msg.method, msg.params);
  }

  private async respondToServerRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      if (method === "mcpServer/elicitation/request") {
        let result: CodexMcpElicitationResponse = { action: "decline", content: null };
        if (this.elicitationHandler) {
          try { result = await this.elicitationHandler(params); }
          catch { result = { action: "cancel", content: null }; }
        }
        this.send({ id, result });
        return;
      }
      if (method === "item/permissions/requestApproval") {
        const result = await decidePermissionsApproval(params, this.opts.trustAllTools, this.permissionHandler);
        this.send({ id, result });
        return;
      }
      if (method.endsWith("requestApproval") || method.includes("Approval")) {
        const decision = await decideApproval(method, params, this.opts.trustAllTools, this.permissionHandler);
        this.send({ id, result: { decision } });
        return;
      }
      const opts: ServerHandlerOptions = {
        workspace: this.opts.workspace,
        trustAllTools: this.opts.trustAllTools,
      };
      const result = await handleServerRequest(method, params, opts);
      this.send({ id, result });
    } catch (err) {
      this.send({ id, error: { code: -32601, message: (err as Error).message } });
    }
  }

  /** Decide a Codex exec/patch approval → "accept" | "acceptForSession" | "decline". */
  private routeNotification(method: string, params: unknown): void {
    const p = (params as Record<string, unknown>) ?? {};
    if ((method === "thread/realtime/closed" || method === "thread/realtime/error") && typeof p.threadId === "string") {
      this.realtimeThreads.delete(p.threadId);
    }
    const threadHint = this.resolveThread(p);
    if (threadHint) this.lastActivity.set(threadHint, Date.now());

    switch (method) {
      case "item/agentMessage/delta": {
        const tid = this.resolveThread(p, String(p.itemId ?? ""));
        if (tid && typeof p.delta === "string") this.emit("session-update", tid, textChunk(p.delta));
        break;
      }
      case "item/reasoning/summaryTextDelta": {
        const tid = this.resolveThread(p, String(p.itemId ?? ""));
        const text = p.summaryTextDelta as string | undefined;
        if (tid && typeof text === "string") this.emit("session-update", tid, reasoningSummaryChunk(text));
        break;
      }
      case "item/reasoning/textDelta": {
        const tid = this.resolveThread(p, String(p.itemId ?? ""));
        const text = p.textDelta as string | undefined;
        if (tid && typeof text === "string") this.emit("session-update", tid, thoughtChunk(text));
        break;
      }
      case "item/started":
      case "item/updated": {
        const item = p.item as CodexItem | undefined;
        const tid = threadHint;
        if (item?.id && tid) this.itemThread.set(item.id, tid);
        if (item && tid && String(item.type ?? item.itemType ?? "") === "commandExecution" && method === "item/started") {
          this.emit("session-update", tid, {
            sessionUpdate: "command_execution_started",
            toolCallId: item.id,
            rawInput: { command: commandString(item.command), cwd: item.cwd },
          });
        }
        if (item && tid) this.updateSubagents(item, tid);
        break;
      }
      case "item/completed": {
        const item = p.item as CodexItem | undefined;
        const tid = threadHint ?? (item?.id ? this.itemThread.get(item.id) : undefined);
        if (item && tid) {
          this.itemThread.set(item.id, tid);
          for (const u of itemToUpdates(item)) this.emit("session-update", tid, u);
          this.updateSubagents(item, tid);
        }
        break;
      }
      case "turn/started": {
        const turn = (p.turn as CodexTurn) ?? undefined;
        const tid = threadHint ?? turn?.threadId;
        if (tid && turn?.id) {
          const pend = this.turns.get(tid);
          if (pend && !pend.turnId) pend.turnId = turn.id;
        }
        break;
      }
      case "turn/completed":
      case "turn/failed":
        this.onTurnCompleted(p);
        break;
      case "error": {
        // Codex may report a terminal turn error without following it with
        // turn/completed. A retrying error is only an update; keep waiting.
        if (p.willRetry !== true) {
          const threadId = this.resolveThread(p);
          const pending = threadId ? this.turns.get(threadId) : undefined;
          const turnId = typeof p.turnId === "string" ? p.turnId : undefined;
          if (threadId && pending && (!turnId || !pending.turnId || pending.turnId === turnId)) {
            const error = p.error as { message?: unknown; codexErrorInfo?: unknown } | undefined;
            const message = typeof error?.message === "string" ? error.message : "Codex turn failed";
            pending.terminalError = new AcpError(message, undefined, { codexErrorInfo: error?.codexErrorInfo });
            // Usually turn/completed follows immediately. Give it a moment to
            // arrive so retries do not race the still-closing server turn.
            if (!pending.terminalErrorTimer) {
              pending.terminalErrorTimer = setTimeout(() => {
                if (this.turns.get(threadId) !== pending) return;
                void this.cancel(threadId);
                this.finishTurn(threadId, "reject", pending.terminalError!);
              }, 3_000);
            }
          }
        }
        break;
      }
      case "thread/tokenUsage/updated":
        this.onTokenUsage(p);
        break;
      case "skills/changed":
        void this.loadCapabilities();
        break;
      case "account/rateLimits/updated":
        this.emit("rate-limits", p.rateLimits);
        break;
      default:
        break;
    }
    this.emit("notification", method, params);
  }

  private onTurnCompleted(p: Record<string, unknown>): void {
    const turn = (p.turn as CodexTurn) ?? undefined;
    const threadId =
      (p.threadId as string | undefined) ??
      turn?.threadId ??
      this.threadByTurnId((turn?.id as string | undefined) ?? (p.turnId as string | undefined));
    if (!threadId) return;
    const pending = this.turns.get(threadId);
    if (pending?.terminalError) {
      this.finishTurn(threadId, "reject", pending.terminalError);
      return;
    }
    const status = turn?.status;
    if (status === "failed") {
      const msg = turnErrorMessage(turn) || "Codex turn failed";
      this.finishTurn(threadId, "reject", new AcpError(msg, -32603, { codexErrorInfo: turnErrorInfo(turn) }));
    } else {
      this.finishTurn(threadId, "resolve", { stopReason: status === "interrupted" ? "cancelled" : "end_turn" });
    }
  }

  private onTokenUsage(p: Record<string, unknown>): void {
    const threadId = (p.threadId as string | undefined) ?? this.singleActiveThread();
    if (!threadId) return;
    const usage = (p.usage ?? p.tokenUsage) as CodexTokenUsage | undefined;
    if (!usage) return;
    const used = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    const window = usage.contextWindow;
    const prev = this.metadata.get(threadId) ?? {};
    const pct = window && window > 0 ? Math.min(100, Math.round((used / window) * 100)) : prev.contextUsagePercentage;
    this.metadata.set(threadId, { ...prev, contextUsagePercentage: pct });
  }

  /**
   * Resolve which thread a notification belongs to. Order: explicit threadId →
   * turn.threadId → by turnId → by itemId → the single in-flight turn.
   */
  private resolveThread(p: Record<string, unknown>, itemId?: string): string | undefined {
    if (typeof p.threadId === "string") return p.threadId;
    const turn = p.turn as CodexTurn | undefined;
    if (turn?.threadId) return turn.threadId;
    const byTurn = this.threadByTurnId((turn?.id as string | undefined) ?? (p.turnId as string | undefined));
    if (byTurn) return byTurn;
    if (itemId && this.itemThread.has(itemId)) return this.itemThread.get(itemId);
    return this.singleActiveThread();
  }

  private singleActiveThread(): string | undefined {
    return this.turns.size === 1 ? [...this.turns.keys()][0] : undefined;
  }

  currentSubagents(): SubagentInfo[] {
    return [...this.subagents.values()];
  }

  currentPendingStages(): PendingStage[] {
    return [];
  }

  subagentById(sessionId: string): SubagentInfo | undefined {
    return this.subagents.get(sessionId);
  }

  private updateSubagents(item: CodexItem, parentThreadId: string): void {
    const type = String(item.type ?? item.itemType ?? "");
    if (type === "collabAgentToolCall") {
      for (const id of item.receiverThreadIds ?? []) {
        const state = item.agentsStates?.[id];
        this.subagents.set(id, {
          sessionId: id,
          sessionName: id.slice(0, 8),
          initialQuery: item.prompt ?? undefined,
          status: { type: state?.status ?? item.status, message: state?.message ?? undefined },
          group: parentThreadId,
        });
      }
    } else if (type === "subAgentActivity" && item.agentThreadId) {
      const existing = this.subagents.get(item.agentThreadId);
      this.subagents.set(item.agentThreadId, {
        ...existing,
        sessionId: item.agentThreadId,
        sessionName: existing?.sessionName ?? item.agentPath ?? item.agentThreadId.slice(0, 8),
        status: { type: item.kind ?? item.status },
        group: parentThreadId,
      });
    } else return;
    this.emit("subagents", this.currentSubagents(), []);
    const terminal = item.status === "completed" || item.status === "failed" || item.kind === "interrupted";
    if (terminal) {
      if (type === "collabAgentToolCall") {
        for (const id of item.receiverThreadIds ?? []) this.subagents.delete(id);
      } else if (item.agentThreadId) {
        this.subagents.delete(item.agentThreadId);
      }
      this.emit("subagents", this.currentSubagents(), []);
    }
  }

  metadataFor(sessionId: string | undefined): SessionMetadata | undefined {
    return sessionId ? this.metadata.get(sessionId) : undefined;
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      p.cleanup();
      p.reject(err);
    }
    this.pending.clear();
    for (const [, t] of this.turns) {
      clearInterval(t.watch);
      if (t.terminalErrorTimer) clearTimeout(t.terminalErrorTimer);
      t.reject(err);
    }
    this.turns.clear();
    this.lastActivity.clear();
  }
}

/** Extract a version-looking token from Codex's userAgent string. */
function parseVersion(userAgent?: string): string | undefined {
  if (!userAgent) return undefined;
  const m = userAgent.match(/\d+\.\d+\.\d+/);
  return m?.[0];
}
