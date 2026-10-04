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
import { EventEmitter } from "node:events";
import { codexLaunchInfo, codexSpawn } from "../app/codex-cli.js";
import { createLogger } from "../logger.js";
import { killPid } from "../sessions/process.js";
import { AcpError, isAccountExhaustedError, isContextExhaustedError, isTransientAcpError, toAcpError } from "./errors.js";
import { decideApproval, decidePermissionsApproval } from "./approvals.js";
import { handleServerRequest, type ServerHandlerOptions } from "./server-handlers.js";
import { JsonRpcTransport } from "./transport.js";
import {
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
  CodexMcpServerStatus,
  CodexAccountInfo,
  CodexRateLimitSnapshot,
  CodexModelInfo,
  CodexModelListResult,
  CodexThreadResponse,
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

/** Per-thread metadata (context usage %, effort, credits) surfaced to the UI. */
export interface SessionMetadata {
  contextUsagePercentage?: number;
  effort?: string;
  credits?: number;
}

// Re-exported so existing importers of these from "../acp/client.js" keep working.
export { AcpError, isAccountExhaustedError, isContextExhaustedError, isTransientAcpError };

export interface AcpClientOptions {
  codexCliPath: string;
  workspace: string;
  /** When true, run every command/edit with no approval prompts (full auto). */
  trustAllTools: boolean;
  /** Optional CODEX_HOME override (config/sessions/auth live here). */
  codexHome?: string;
  requestTimeoutMs?: number;
  autoRestart?: boolean;
  /** Reject a turn only after this long with no streaming activity. */
  promptIdleTimeoutMs?: number;
  /** Absolute safety cap for a single turn. */
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
  private readonly promptMaxMs: number;
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
  private readonly threadModel = new Map<string, string>();
  private readonly threadMode = new Map<string, string>();
  private readonly collaborationModes = new Map<string, CodexCollaborationModeInfo>();
  private readonly subagents = new Map<string, SubagentInfo>();
  /** itemId -> threadId, so text/reasoning deltas route to the right thread. */
  private readonly itemThread = new Map<string, string>();

  permissionHandler?: (params: RequestPermissionParams) => Promise<PermissionOutcome>;

  get isConnected(): boolean {
    return this.connected;
  }

  constructor(private readonly opts: AcpClientOptions) {
    super();
    this.setMaxListeners(0);
    this.timeout = opts.requestTimeoutMs ?? 120_000;
    this.promptIdleMs = opts.promptIdleTimeoutMs ?? 900_000;
    this.promptMaxMs = opts.promptMaxMs ?? 60 * 60_000;
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
    const response = await this.request("project/list", {}) as CodexProjectListResponse;
    const projects = response?.projects ?? response?.data ?? [];
    return Array.isArray(projects) ? projects.filter((p) => typeof p?.id === "string") : [];
  }

  /** List persisted Codex threads with the app-server's native filters. */
  async listThreads(params: CodexThreadListParams = {}): Promise<CodexThreadSummary[]> {
    const response = await this.request("thread/list", params) as CodexThreadListResponse;
    const threads = response?.threads ?? response?.data ?? [];
    return Array.isArray(threads) ? threads.filter((t) => typeof t?.id === "string") : [];
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
      const response = await this.request("thread/list", pageParams) as CodexThreadListResponse;
      const threads = response?.threads ?? response?.data ?? [];
      if (Array.isArray(threads)) {
        for (const thread of threads) if (typeof thread?.id === "string") byId.set(thread.id, thread);
      }
      const next = response?.nextCursor ?? undefined;
      if (!next || next === cursor || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    return [...byId.values()];
  }

  hasMode(id: string): boolean {
    return this.collaborationModes.has(id);
  }

  hasModel(id: string): boolean {
    if (!id || id === "auto") return true;
    if (this.availableModels.length === 0) return true;
    return this.availableModels.some((m) => m.modelId === id);
  }

  /** Resolve the model id to send for a thread: per-thread → default → none. */
  private modelFor(threadId: string | undefined): string | undefined {
    const pref = (threadId && this.threadModel.get(threadId)) || this.currentModelId;
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
        if (total > this.promptMaxMs) {
          this.finishTurn(sessionId, "reject", new Error(`Prompt exceeded the ${Math.round(this.promptMaxMs / 60_000)}min cap`));
          void this.cancel(sessionId);
        } else if (idle > this.promptIdleMs) {
          this.finishTurn(sessionId, "reject", new Error(`No agent activity for ${Math.round(idle / 1000)}s — giving up`));
          void this.cancel(sessionId);
        }
      }, 15_000);

      const prev = this.turns.get(sessionId);
      if (prev) {
        clearInterval(prev.watch);
        prev.reject(new AcpError("superseded by a new turn"));
      }
      this.turns.set(sessionId, { threadId: sessionId, resolve, reject, watch, start });

      const params: CodexTurnStartParams = {
        threadId: sessionId,
        input: toCodexInput(content),
        cwd: this.threadCwd.get(sessionId),
        // Workspace writes and commands are already bounded by workspaceWrite.
        // Avoid a Telegram prompt for every in-project action; explicit
        // request_permissions_tool expansions (outside paths/network) still
        // go through the user's one-time approval flow.
        approvalPolicy: "never",
        sandboxPolicy: this.opts.trustAllTools
          ? { type: "dangerFullAccess" }
          : { type: "workspaceWrite", writableRoots: [this.threadCwd.get(sessionId) ?? this.opts.workspace], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      };
      const model = this.modelFor(sessionId);
      if (model) params.model = model;
      const mode = this.collaborationModes.get(this.threadMode.get(sessionId) ?? "");
      if (mode?.mode) {
        params.collaborationMode = {
          mode: mode.mode,
          settings: {
            model: mode.model ?? model ?? "",
            reasoning_effort: mode.reasoning_effort ?? null,
            developer_instructions: null,
          },
        };
      }

      this.request("turn/start", params)
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
      t.reject(err);
    }
    this.turns.clear();
  }
}

/** Extract a version-looking token from Codex's userAgent string. */
function parseVersion(userAgent?: string): string | undefined {
  if (!userAgent) return undefined;
  const m = userAgent.match(/\d+\.\d+\.\d+/);
  return m?.[0];
}
