import assert from "node:assert/strict";
import test from "node:test";
import { AcpClient } from "../src/acp/client.js";
import { normalizeMobileMcpServers } from "../src/mobile/integrations.js";

test("mobile MCP inventory includes a redacted bounded input schema only", () => {
  const result = normalizeMobileMcpServers([{
    name: "fixture-mcp", runtimeStatus: "connected", authStatus: "oauth", tools: {
      find_records: {
        description: "Find records",
        inputSchema: {
          type: "object", required: ["query"],
          properties: { query: { type: "string", description: "Search text", default: "private" } },
          $schema: "https://example.invalid/schema", examples: [{ query: "private" }],
        },
      },
    },
  }]);
  assert.deepEqual(result[0]?.tools[0]?.inputSchema, {
    type: "object", required: ["query"],
    properties: { query: { type: "string", description: "Search text" } },
  });
  assert.doesNotMatch(JSON.stringify(result), /private|example\.invalid/i);
});

test("mobile MCP call revalidates the live thread, bounds arguments, and returns inert output", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const calls: Array<{ method: string; params: unknown }> = [];
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  internal.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "mcpServerStatus/list") return { data: [{
      name: "fixture-mcp", runtimeStatus: "connected", tools: {
        read_status: { description: "Read a safe fixture status.", inputSchema: { type: "object" } },
      },
    }] };
    if (method === "mcpServer/tool/call") return {
      content: [
        { type: "text", text: "Found one record." },
        { type: "image", data: "do-not-forward-this-image" },
        { type: "resource_link", uri: "file:///private/secret" },
      ],
      structuredContent: { count: 1, ok: true }, isError: false, _meta: { authToken: "secret" },
    };
    throw new Error(`Unexpected ACP method: ${method}`);
  };
  const api = client as unknown as {
    callMobileMcpTool?: (threadId: string, server: string, tool: string, argumentsValue: unknown) => Promise<unknown>;
  };
  try {
    assert.equal(typeof api.callMobileMcpTool, "function");
    const result = await api.callMobileMcpTool!("thread-1", "fixture-mcp", "read_status", { query: "recent changes" });
  assert.deepEqual(result, {
      text: 'Found one record.\n\n{"count":1,"ok":true}', isError: false, truncated: false, omittedContentBlocks: 2,
  });
    assert.deepEqual(calls, [
      { method: "mcpServerStatus/list", params: { threadId: "thread-1", detail: "full", limit: 100 } },
      { method: "mcpServer/tool/call", params: {
        threadId: "thread-1", server: "fixture-mcp", tool: "read_status", arguments: { query: "recent changes" },
      } },
    ]);
    assert.doesNotMatch(JSON.stringify(result), /do-not-forward|private|authToken|secret/i);
    await assert.rejects(api.callMobileMcpTool!("thread-1", "fixture-mcp", "missing", {}), /не найден/i);
    await assert.rejects(api.callMobileMcpTool!("thread-1", "fixture-mcp", "read_status", null), /JSON-объект/i);
    await assert.rejects(api.callMobileMcpTool!("thread-1", "fixture-mcp", "read_status", { body: "x".repeat(33_000) }), /32 КБ/i);
    assert.equal(calls.filter((entry) => entry.method === "mcpServer/tool/call").length, 1);
  } finally { client.stop(); }
});

test("mobile MCP tool call refuses a disconnected server before invoking it", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  let called = false;
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  internal.request = async (method) => {
    if (method === "mcpServerStatus/list") return { data: [{
      name: "fixture-mcp", runtimeStatus: "authenticationRequired", tools: { read_status: {} },
    }] };
    called = true;
    return { content: [] };
  };
  const api = client as unknown as {
    callMobileMcpTool?: (threadId: string, server: string, tool: string, argumentsValue: unknown) => Promise<unknown>;
  };
  try {
    assert.equal(typeof api.callMobileMcpTool, "function");
    await assert.rejects(api.callMobileMcpTool!("thread-1", "fixture-mcp", "read_status", {}), /не подключён/i);
    assert.equal(called, false);
  } finally { client.stop(); }
});

test("mobile MCP resource reads revalidate the live resource and omit URI and binary content", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const calls: Array<{ method: string; params: unknown }> = [];
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  internal.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "mcpServerStatus/list") return { data: [{
      name: "fixture-mcp", runtimeStatus: "connected", resources: [
        { uri: "fixture://private/account", name: "Account notes", mimeType: "text/plain" },
      ],
    }] };
    if (method === "mcpServer/resource/read") return { contents: [
      { uri: "fixture://private/account", mimeType: "text/plain", text: "Fixture notes" },
      { uri: "fixture://private/image", mimeType: "image/png", blob: "private-binary" },
    ], originCallId: "private-call-id" };
    throw new Error(`Unexpected ACP method: ${method}`);
  };
  const api = client as unknown as {
    readMobileMcpResource?: (threadId: string, server: string, uri: string) => Promise<unknown>;
  };
  try {
    assert.equal(typeof api.readMobileMcpResource, "function");
    const result = await api.readMobileMcpResource!("thread-1", "fixture-mcp", "fixture://private/account");
    assert.deepEqual(result, { text: "Fixture notes", truncated: false, omittedContentBlocks: 1 });
    assert.doesNotMatch(JSON.stringify(result), /fixture:\/\/|private-binary|originCallId/i);
    await assert.rejects(api.readMobileMcpResource!("thread-1", "fixture-mcp", "fixture://private/not-listed"), /не найден/i);
    assert.equal(calls.filter((entry) => entry.method === "mcpServer/resource/read").length, 1);
    assert.deepEqual(calls[1], { method: "mcpServer/resource/read", params: {
      threadId: "thread-1", server: "fixture-mcp", uri: "fixture://private/account",
    } });
  } finally { client.stop(); }
});
