/**
 * Codex app-server (`codex app-server`) wire protocol types — JSON-RPC 2.0 over
 * stdio (the `jsonrpc` header is omitted on the wire, matching Codex).
 *
 * These are the SERVER-side shapes as spoken by Codex. They are translated into
 * the bot's protocol-neutral `SessionUpdate` events (see ./translate.ts)
 * so the whole downstream render/runtime layer stays protocol-agnostic.
 *
 * @see openai/codex — codex-rs/app-server-protocol/src/protocol/v2.rs
 */

// ── handshake ────────────────────────────────────────────────────────────────

export interface CodexInitializeParams {
  clientInfo: { name: string; title?: string; version?: string };
  capabilities?: {
    experimentalApi?: boolean;
    optOutNotificationMethods?: string[];
    requestAttestation?: boolean;
  };
}

export interface CodexInitializeResult {
  /** Codex's own user-agent string. */
  userAgent?: string;
  /** Absolute path of the resolved CODEX_HOME (holds sessions/, auth.json…). */
  codexHome?: string;
}

// ── threads ──────────────────────────────────────────────────────────────────

export interface CodexSandboxPolicy {
  type: "readOnly" | "workspaceWrite" | "dangerFullAccess" | "externalSandbox";
  writableRoots?: string[];
  networkAccess?: boolean;
  excludeTmpdirEnvVar?: boolean;
  excludeSlashTmp?: boolean;
}

export type CodexApprovalPolicy = "never" | "on-request" | "untrusted";

export interface CodexThreadStartParams {
  model?: string;
  cwd?: string;
  /** thread/start uses the compact SandboxMode enum, unlike turn/start. */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
}

export interface CodexThread {
  id: string;
  [k: string]: unknown;
}

export interface CodexThreadResponse {
  thread: CodexThread;
}

export interface CodexThreadResumeParams {
  threadId: string;
}

/** Minimal app-server catalogue shapes used by the Telegram pickers. */
export interface CodexProjectSummary {
  id: string;
  name?: string;
  roots?: Array<string | { path?: string; root?: string }>;
  position?: number;
  /** Unix timestamps in seconds, as returned by project/list. */
  createdAt: number;
  updatedAt: number;
  recencyAt: number | null;
  metadata?: Record<string, unknown>;
}

export interface CodexProjectListResponse {
  projects?: CodexProjectSummary[];
  data?: CodexProjectSummary[];
  nextCursor?: string | null;
}

export type CodexThreadSourceKind =
  | "cli" | "vscode" | "exec" | "appServer" | "subAgent" | "subAgentReview"
  | "subAgentCompact" | "subAgentThreadSpawn" | "subAgentOther" | "unknown";

export type CodexSubAgentSource =
  | "review"
  | "compact"
  | "memoryConsolidation"
  | { threadSpawn: {
      parentThreadId: string;
      depth: number;
      agentPath?: string | null;
      agentNickname?: string | null;
      agentRole?: string | null;
    } }
  | { other: string };

/** SessionSource's wire shape: scalar sources or tagged custom/subAgent objects. */
export type CodexThreadSource =
  | "cli" | "vscode" | "exec" | "appServer" | "unknown"
  | { custom: string }
  | { subAgent: CodexSubAgentSource };

export interface CodexThreadSummary {
  id: string;
  sessionId?: string;
  name?: string;
  preview?: string;
  cwd?: string;
  /** Unix timestamps in seconds, as returned by thread/list. */
  createdAt: number;
  updatedAt: number;
  recencyAt: number | null;
  status?: string | { type?: string };
  source?: CodexThreadSource;
  projectId?: string;
  parentThreadId?: string;
  ephemeral?: boolean;
}

export interface CodexThreadListParams {
  cursor?: string;
  limit?: number;
  sortKey?: "created_at" | "updated_at" | "recency_at" | "section_position";
  sortDirection?: "asc" | "desc";
  sourceKinds?: CodexThreadSourceKind[];
  archived?: boolean;
  cwd?: string | string[];
  useStateDbOnly?: boolean;
  searchTerm?: string;
}

export interface CodexThreadListResponse {
  threads?: CodexThreadSummary[];
  data?: CodexThreadSummary[];
  nextCursor?: string | null;
}

// ── turns ────────────────────────────────────────────────────────────────────

export type CodexUserInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

export interface CodexTurnStartParams {
  threadId: string;
  input: CodexUserInput[];
  cwd?: string;
  model?: string;
  effort?: string;
  approvalPolicy?: CodexApprovalPolicy;
  sandboxPolicy?: CodexSandboxPolicy;
  clientUserMessageId?: string;
  collaborationMode?: {
    mode: "default" | "plan";
    settings: { model: string; reasoning_effort: string | null; developer_instructions: string | null };
  };
}

export type CodexTurnStatus = "inProgress" | "completed" | "interrupted" | "failed";

export interface CodexTurn {
  id: string;
  threadId?: string;
  status?: CodexTurnStatus;
  error?: { message?: string; codexErrorInfo?: CodexErrorInfo; additionalDetails?: string | null } | string;
  items?: CodexItem[];
  [k: string]: unknown;
}

export type CodexErrorInfo =
  | "contextWindowExceeded"
  | "sessionBudgetExceeded"
  | "usageLimitExceeded"
  | "serverOverloaded"
  | "unauthorized"
  | "internalServerError"
  | string
  | { httpConnectionFailed?: { httpStatusCode?: number | null } }
  | { responseStreamConnectionFailed?: { httpStatusCode?: number | null } }
  | { responseStreamDisconnected?: { httpStatusCode?: number | null } };

export interface CodexTurnResponse {
  turn: CodexTurn;
}

export interface CodexTurnNotification {
  threadId?: string;
  turn: CodexTurn;
}

export interface CodexTurnInterruptParams {
  threadId: string;
  turnId: string;
}

// ── items (assistant messages, reasoning, commands, file changes…) ───────────

export type CodexItemType =
  | "agentMessage"
  | "reasoning"
  | "commandExecution"
  | "fileChange"
  | "mcpToolCall"
  | "webSearch"
  | "fileSearch"
  | "todoList"
  | "error"
  | string;

export interface CodexFileChange {
  path: string;
  kind?: "add" | "delete" | "update" | "rename" | string;
  diff?: string;
  movePath?: string;
}

export interface CodexItem {
  id: string;
  type?: CodexItemType;
  itemType?: CodexItemType;
  status?: "inProgress" | "completed" | "failed" | "declined" | string;
  // agentMessage
  text?: string;
  // commandExecution
  command?: string | string[];
  cwd?: string;
  aggregatedOutput?: string;
  exitCode?: number;
  durationMs?: number;
  // fileChange
  changes?: CodexFileChange[];
  // mcpToolCall
  server?: string;
  tool?: string;
  invocation?: { server?: string; tool?: string; arguments?: unknown };
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  // dynamicToolCall / collaboration items
  namespace?: string | null;
  senderThreadId?: string;
  receiverThreadIds?: string[];
  prompt?: string | null;
  agentsStates?: Record<string, { status?: string; message?: string | null }>;
  agentThreadId?: string;
  agentPath?: string;
  kind?: string;
  // webSearch / fileSearch
  query?: string;
  [k: string]: unknown;
}

export interface CodexItemNotification {
  threadId?: string;
  turnId?: string;
  item: CodexItem;
}

export interface CodexAgentMessageDelta {
  itemId: string;
  delta: string;
}

export interface CodexReasoningDelta {
  itemId: string;
  summaryTextDelta?: string;
  textDelta?: string;
}

export interface CodexCommandOutputDelta {
  itemId: string;
  delta: string; // base64-encoded stdout/stderr
}

// ── token usage ──────────────────────────────────────────────────────────────

export interface CodexTokenUsageUpdate {
  threadId?: string;
  usage?: CodexTokenUsage;
  tokenUsage?: CodexTokenUsage;
  [k: string]: unknown;
}

export interface CodexTokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  contextWindow?: number;
  [k: string]: unknown;
}

// ── model catalogue ──────────────────────────────────────────────────────────

export interface CodexModelListResult {
  data?: CodexModelInfo[];
  models?: CodexModelInfo[];
  nextCursor?: string | null;
}

export interface CodexModelInfo {
  id: string;
  model?: string;
  displayName?: string;
  description?: string;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  isDefault?: boolean;
}

export interface CodexCollaborationModeInfo {
  name: string;
  mode?: "default" | "plan" | null;
  model?: string | null;
  reasoning_effort?: string | null;
}

export interface CodexCollaborationModeListResult {
  data?: CodexCollaborationModeInfo[];
}

export interface CodexSkillInfo {
  name: string;
  description?: string;
  path?: string;
  enabled?: boolean;
}

export interface CodexMcpServerStatus {
  name: string;
  tools?: Record<string, unknown>;
  resources?: unknown[];
  resourceTemplates?: unknown[];
  authStatus?: unknown;
}

export interface CodexAccountInfo {
  type: "apiKey" | "chatgpt" | "amazonBedrock";
  email?: string | null;
  planType?: string;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface CodexRateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string | null } | null;
  rateLimitReachedType?: string | null;
}

// ── server → client approval requests ────────────────────────────────────────

export interface CodexCommandApprovalRequest {
  itemId: string;
  threadId: string;
  turnId: string;
  reason?: string;
  command?: string | string[];
  cwd?: string;
}

export interface CodexFileChangeApprovalRequest {
  itemId: string;
  threadId: string;
  turnId: string;
  reason?: string;
  changes?: CodexFileChange[];
}

export type CodexApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
