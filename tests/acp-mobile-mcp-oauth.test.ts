import assert from "node:assert/strict";
import test from "node:test";
import { AcpClient } from "../src/acp/client.js";

test("mobile MCP sign-in uses Codex OAuth and only returns HTTPS authorization links", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const calls: Array<{ method: string; params: unknown }> = [];
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  internal.request = async (method, params) => {
    calls.push({ method, params });
    return { authorizationUrl: "https://login.example.invalid/authorize?state=fixture" };
  };

  const api = client as unknown as {
    startMobileMcpOAuthLogin?: (name: string, threadId: string) => Promise<{ authorizationUrl: string }>;
  };
  assert.equal(typeof api.startMobileMcpOAuthLogin, "function");
  assert.deepEqual(await api.startMobileMcpOAuthLogin!.call(client, "fixture-mcp", "thread-1"), {
    authorizationUrl: "https://login.example.invalid/authorize?state=fixture",
  });
  assert.deepEqual(calls, [{
    method: "mcpServer/oauth/login",
    params: { name: "fixture-mcp", threadId: "thread-1" },
  }]);

  internal.request = async () => ({ authorizationUrl: "http://login.example.invalid/authorize" });
  await assert.rejects(api.startMobileMcpOAuthLogin!.call(client, "fixture-mcp", "thread-1"), /HTTPS/);
  internal.request = async () => ({ authorizationUrl: "javascript:alert(1)" });
  await assert.rejects(api.startMobileMcpOAuthLogin!.call(client, "fixture-mcp", "thread-1"), /HTTPS/);
});
