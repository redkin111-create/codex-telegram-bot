/**
 * Internal protocol type definitions consumed across the bot.
 *
 * These are the bot's protocol-neutral event shapes. The Codex app-server
 * client (see ./client.ts + ./translate.ts)
 * translates Codex's `thread`/`turn`/`item` events into these, so the whole
 * downstream render/runtime layer stays protocol-agnostic.
 */

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcResponse & JsonRpcNotification & { method?: string };

/** A content block in a prompt or message. */
export interface ContentBlock {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
  [k: string]: unknown;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean };
  };
  agentInfo?: { name?: string; version?: string };
  /** Absolute path of the resolved CODEX_HOME (from Codex's initialize result). */
  codexHome?: string;
}

export interface NewSessionResult {
  sessionId: string;
}

export interface PromptResult {
  stopReason?: string; // e.g. "end_turn", "cancelled", "max_tokens"
}

/** session/update notification payload. */
export interface SessionUpdate {
  sessionUpdate:
    | "agent_message_chunk"
    | "agent_thought_chunk"
    | "tool_call"
    | "tool_call_update"
    | "plan"
    | "user_message_chunk"
    | string;
  content?: ContentBlock;
  // tool_call / tool_call_update fields
  toolCallId?: string;
  title?: string;
  kind?: string; // "read" | "edit" | "execute" | "search" | ...
  status?: "pending" | "in_progress" | "completed" | "failed" | string;
  rawInput?: Record<string, unknown>;
  content_blocks?: ToolCallContent[];
  // Some tool updates also nest payloads under `content`.
  [k: string]: unknown;
}

/** A piece of tool-call content (text, diff, etc.). */
export interface ToolCallContent {
  type: "content" | "diff" | string;
  path?: string;
  oldText?: string | null;
  newText?: string;
  /** A pre-rendered unified diff string (Codex `fileChange` items ship this). */
  unified?: string;
  content?: ContentBlock;
  [k: string]: unknown;
}

export interface SessionNotificationParams {
  sessionId: string;
  update: SessionUpdate;
}

/** Permission request from the agent (server -> client). */
export interface RequestPermissionParams {
  sessionId: string;
  toolCall?: { toolCallId?: string; title?: string; kind?: string; rawInput?: Record<string, unknown> };
  options: Array<{ optionId: string; name: string; kind?: string }>;
  /** Exact Codex permission profile for item/permissions/requestApproval. */
  permissions?: Record<string, unknown>;
  reason?: string;
  cwd?: string;
}

export type PermissionOutcome =
  | { outcome: { outcome: "selected"; optionId: string } }
  | { outcome: { outcome: "cancelled" } };

/**
 * One subagent reported by Codex collaboration items.
 */
export interface SubagentInfo {
  /** The subagent's own session id (distinct from the parent session). */
  sessionId: string;
  sessionName?: string;
  agentName?: string;
  role?: string;
  initialQuery?: string;
  status?: { type?: string; message?: string };
  group?: string;
  dependsOn?: string[];
  hasLoop?: boolean;
  loopIteration?: number;
  loopMaxIterations?: number;
  createdAtMs?: number;
}

/** A not-yet-started pipeline stage reported alongside the subagent list. */
export interface PendingStage {
  name?: string;
  role?: string;
  agentName?: string;
  dependsOn?: string[];
  [k: string]: unknown;
}

export interface SubagentListUpdate {
  subagents?: SubagentInfo[];
  pendingStages?: PendingStage[];
}
