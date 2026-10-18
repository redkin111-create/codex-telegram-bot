import assert from "node:assert/strict";
import test from "node:test";
import { AcpClient } from "../src/acp/client.js";

test("mobile model, mode and reasoning changes update native Codex thread settings", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const calls: Array<{ method: string; params: unknown }> = [];
  const internal = client as unknown as {
    collaborationModes: Map<string, { name: string; mode?: "default" | "plan" | null; model?: string | null; reasoning_effort?: string | null }>;
    request: (method: string, params: unknown) => Promise<unknown>;
  };
  client.availableModels = [{ modelId: "fixture-model", name: "Fixture model" }];
  internal.collaborationModes.set("plan", { name: "Plan", mode: "plan", model: "fixture-model", reasoning_effort: "high" });
  internal.request = async (method, params) => { calls.push({ method, params }); return {}; };

  await client.updateMobileThreadSettings("owned-thread", { modelId: "fixture-model", modeId: "plan", effort: "high" });

  assert.deepEqual(calls, [{
    method: "thread/settings/update",
    params: {
      threadId: "owned-thread",
      model: "fixture-model",
      effort: "high",
      collaborationMode: {
        mode: "plan",
        settings: { model: "fixture-model", reasoning_effort: "high", developer_instructions: null },
      },
    },
  }]);
});

test("mobile default selections clear native thread overrides and unavailable modes are rejected", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const calls: Array<{ method: string; params: unknown }> = [];
  const internal = client as unknown as {
    request: (method: string, params: unknown) => Promise<unknown>;
  };
  internal.request = async (method, params) => { calls.push({ method, params }); return {}; };

  await client.updateMobileThreadSettings("owned-thread", { modelId: null, modeId: null, effort: null });
  await assert.rejects(client.updateMobileThreadSettings("owned-thread", { modeId: "unavailable" }), /режим.*недоступен/i);
  assert.deepEqual(calls, [{
    method: "thread/settings/update",
    params: { threadId: "owned-thread", model: null, effort: null, collaborationMode: null },
  }]);
});

test("mobile thread settings are not cached when Codex rejects an update", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const internal = client as unknown as {
    threadModel: Map<string, string | null>;
    request: (method: string, params: unknown) => Promise<unknown>;
  };
  client.availableModels = [{ modelId: "fixture-model", name: "Fixture model" }];
  internal.request = async () => { throw new Error("Codex rejected settings"); };

  await assert.rejects(client.updateMobileThreadSettings("owned-thread", { modelId: "fixture-model" }), /Codex rejected settings/);
  assert.equal(internal.threadModel.has("owned-thread"), false);
});

test("mobile capabilities read and cache only settings confirmed for the requested Codex thread", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const internal = client as unknown as {
    request: (method: string, params: unknown) => Promise<unknown>;
    threadModel: Map<string, string | null>;
    threadEffort: Map<string, string | null>;
  };
  const responses: unknown[] = [
    { thread: { id: "owned-thread", model: "fixture-model", reasoningEffort: null } },
    { thread: { id: "other-thread", model: "attacker-model", reasoningEffort: "high" } },
  ];
  internal.request = async (method, params) => {
    assert.equal(method, "thread/read");
    assert.deepEqual(params, { threadId: "owned-thread", includeTurns: false });
    return responses.shift();
  };

  assert.deepEqual(await client.readMobileThreadSettings("owned-thread"), { model: "fixture-model", effort: null });
  assert.equal(internal.threadModel.get("owned-thread"), "fixture-model");
  assert.equal(internal.threadEffort.has("owned-thread"), true);
  assert.equal(internal.threadEffort.get("owned-thread"), null);
  await assert.rejects(client.readMobileThreadSettings("owned-thread"), /не подтвердил настройки/);
  assert.equal(internal.threadModel.has("attacker-model"), false);
});
