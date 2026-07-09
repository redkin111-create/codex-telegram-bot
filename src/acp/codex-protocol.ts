/**
 * Codex app-server (`codex app-server`) wire protocol types — JSON-RPC 2.0 over
 * stdio (the `jsonrpc` header is omitted on the wire, matching Codex).
 *
 * These are the SERVER-side shapes as spoken by Codex. They are translated into
 * the bot's internal, Kiro-shaped `SessionUpdate` events (see ./translate.ts)
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

// ── threads (≈ Kiro sessions) ────────────────────────────────────────────────

export interface CodexSandboxPolicy {
  type: "read-only" | "workspace-write" | "danger-full-access";
  writableRoots?: string[];
  networkAccess?: boolean;
}

export type CodexApprovalPolicy = "never" | "on-request" | "untrusted";

export interface CodexThreadStartParams {
  model?: string;
  cwd?: string;
  sandboxPolicy?: CodexSandboxPolicy;
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

// ── turns (≈ Kiro prompt/turn) ───────────────────────────────────────────────

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
}

export type CodexTurnStatus = "inProgress" | "completed" | "interrupted" | "failed";

export interface CodexTurn {
  id: string;
  threadId?: string;
  status?: CodexTurnStatus;
  error?: { message?: string; code?: number } | string;
  items?: CodexItem[];
  [k: string]: unknown;
}

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
  nextCursor?: string;
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
