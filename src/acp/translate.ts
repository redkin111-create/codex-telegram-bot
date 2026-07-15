/**
 * Translate Codex app-server events into the bot's protocol-neutral
 * `SessionUpdate` events. Everything downstream (streamer, tool-call renderer,
 * file-summary, progress) consumes these — so the protocol swap is contained
 * entirely to the ACP layer.
 *
 * Mapping summary:
 *   • item/agentMessage/delta          → agent_message_chunk
 *   • item/reasoning/*Delta            → agent_thought_chunk
 *   • item/completed (commandExecution)→ tool_call (kind "execute")
 *   • item/completed (fileChange)      → one tool_call per file (kind edit/…)
 *   • item/completed (mcpToolCall/…)   → tool_call (kind other/fetch/search)
 *
 * Tool calls are emitted only on `item/completed` (not `item/started`): the
 * runtime renders the FIRST update per toolCallId, so a single completed event
 * yields one clean block with the final ✅/❌ status and full command/diff.
 */
import type { CodexFileChange, CodexItem, CodexTurn, CodexUserInput } from "./codex-protocol.js";
import type { ContentBlock, SessionUpdate, ToolCallContent } from "./types.js";

/** Internal tool-call status from a Codex item status. */
function mapItemStatus(status?: string): "in_progress" | "completed" | "failed" {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "declined":
      return "failed";
    default:
      return "in_progress";
  }
}

/** Flatten a Codex command (string or argv array) into a single command line. */
export function commandString(command: unknown): string {
  if (typeof command === "string") return command;
  if (Array.isArray(command)) return command.map((c) => String(c)).join(" ");
  return "";
}

function firstLine(s: string): string {
  const line = s.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > 120 ? line.slice(0, 117) + "…" : line;
}

function itemType(item: CodexItem): string {
  return String(item.type ?? item.itemType ?? "");
}

/** A streamed assistant-text chunk. */
export function textChunk(text: string): SessionUpdate {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

/** A streamed reasoning/thinking chunk. */
export function thoughtChunk(text: string): SessionUpdate {
  return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } };
}

/**
 * Convert a completed Codex item into zero or more internal tool-call updates.
 * `agentMessage`/`reasoning` items return [] (their text was already streamed
 * via deltas, so re-emitting would duplicate the reply).
 */
export function itemToUpdates(item: CodexItem): SessionUpdate[] {
  const type = itemType(item);
  const status = mapItemStatus(item.status);

  switch (type) {
    case "commandExecution": {
      const cmd = commandString(item.command);
      return [
        {
          sessionUpdate: "tool_call",
          toolCallId: item.id,
          kind: "execute",
          status,
          title: firstLine(cmd) || "Command",
          rawInput: { command: cmd, cwd: item.cwd },
        },
      ];
    }

    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return changes.map((c, i) => fileChangeUpdate(item.id, i, c, status));
    }

    case "mcpToolCall": {
      const server = str(item.server) || str(item.invocation?.server);
      const tool = str(item.tool) || str(item.invocation?.tool) || "tool";
      const name = server ? `${server}/${tool}` : tool;
      return [
        {
          sessionUpdate: "tool_call",
          toolCallId: item.id,
          kind: "other",
          status,
          title: name,
          rawInput: { tool_name: name, server, tool, arguments: item.arguments ?? item.invocation?.arguments },
        },
      ];
    }

    case "dynamicToolCall": {
      const tool = str(item.tool) || "tool";
      const name = item.namespace ? `${item.namespace}/${tool}` : tool;
      return [{
        sessionUpdate: "tool_call",
        toolCallId: item.id,
        kind: "other",
        status,
        title: name,
        rawInput: { tool_name: name, arguments: item.arguments },
      }];
    }

    case "collabAgentToolCall":
      return [{
        sessionUpdate: "tool_call",
        toolCallId: item.id,
        kind: "other",
        status,
        title: `Agent ${str(item.tool) || "collaboration"}`,
        rawInput: { tool_name: "subagent", prompt: item.prompt, agents: item.receiverThreadIds },
      }];

    case "webSearch":
      return [
        {
          sessionUpdate: "tool_call",
          toolCallId: item.id,
          kind: "fetch",
          status,
          title: item.query ? `Web search: ${item.query}` : "Web search",
          rawInput: { query: str(item.query) },
        },
      ];

    case "fileSearch":
      return [
        {
          sessionUpdate: "tool_call",
          toolCallId: item.id,
          kind: "search",
          status,
          title: item.query ? `Search: ${item.query}` : "File search",
          rawInput: { query: str(item.query) },
        },
      ];

    default:
      // agentMessage, reasoning, todoList, error, … — nothing to render here.
      return [];
  }
}

function fileChangeUpdate(
  itemId: string,
  idx: number,
  c: CodexFileChange,
  status: "in_progress" | "completed" | "failed",
): SessionUpdate {
  const k = String(c.kind ?? "update").toLowerCase();
  const kind = k === "delete" ? "delete" : k === "rename" || k === "move" ? "move" : "edit";
  const verb = k === "add" ? "Create" : k === "delete" ? "Delete" : k === "rename" || k === "move" ? "Rename" : "Edit";
  const content: ToolCallContent[] = c.diff ? [{ type: "diff", path: c.path, unified: c.diff }] : [];
  return {
    sessionUpdate: "tool_call",
    toolCallId: `${itemId}:${idx}`,
    kind,
    status,
    title: `${verb} ${c.path}`,
    // `changeKind` lets file-summary classify created/edited/deleted/moved
    // precisely without needing old/new text (Codex only sends a unified diff).
    rawInput: { path: c.path, changeKind: k },
    content_blocks: content,
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Map internal prompt content blocks to Codex `turn/start` input items. */
export function toCodexInput(content: ContentBlock[]): CodexUserInput[] {
  const out: CodexUserInput[] = [];
  for (const b of content) {
    if (b.type === "image" && typeof b.data === "string" && b.data) {
      const mime = typeof b.mimeType === "string" && b.mimeType ? b.mimeType : "image/png";
      out.push({ type: "image", url: `data:${mime};base64,${b.data}` });
    } else if (b.type === "resource" && typeof b.text === "string" && b.text) {
      out.push({ type: "text", text: b.text });
    } else {
      const text = typeof b.text === "string" ? b.text : "";
      if (text) out.push({ type: "text", text });
    }
  }
  if (out.length === 0) out.push({ type: "text", text: "" });
  return out;
}

/** Best-effort human-readable message from a failed Codex turn. */
export function turnErrorMessage(turn: CodexTurn | undefined): string {
  if (!turn) return "";
  const e = turn.error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof e.message === "string") return e.message;
  return "";
}

/** Structured Codex error classification, when app-server supplies it. */
export function turnErrorInfo(turn: CodexTurn | undefined): unknown {
  const e = turn?.error;
  return e && typeof e === "object" ? e.codexErrorInfo : undefined;
}
