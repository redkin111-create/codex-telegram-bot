import assert from "node:assert/strict";
import test from "node:test";
import { MobileApprovalBroker, MobileElicitationBroker } from "../src/mobile/approvals.js";
import type { RequestPermissionParams } from "../src/acp/types.js";
import type { RuntimeRegistry } from "../src/bot/registry.js";
import type { TmaLiveFeed } from "../src/tma/live.js";

const sessionId = "55555555-5555-4555-8555-555555555555";

function fixture(active = true) {
  const published: Array<{ sessionId: string; payload: Record<string, unknown> }> = [];
  const statuses: string[] = [];
  const feed = {
    hasSubscribers: () => active,
    publish: (id: string, payload: Record<string, unknown>) => published.push({ sessionId: id, payload }),
    status: (_id: string, status: string) => statuses.push(status),
  } as unknown as TmaLiveFeed;
  const registry = { ownerChatForSession: (id: string) => id === sessionId ? 101 : undefined } as unknown as RuntimeRegistry;
  return { feed, registry, published, statuses };
}

const request: RequestPermissionParams = {
  sessionId,
  toolCall: { toolCallId: "approval-item", title: "git status", kind: "execute", rawInput: { command: "git status" } },
  options: [{ optionId: "accept", name: "Разрешить один раз" }, { optionId: "decline", name: "Отклонить" }],
  permissions: { fileSystem: { read: [{ type: "special", value: { kind: "project_roots" } }] } },
  reason: "Codex хочет прочитать файлы проекта",
};

test("active phone receives an owner-scoped approval and only an advertised choice resolves it", async () => {
  const f = fixture();
  const broker = new MobileApprovalBroker(f.feed, f.registry, new Set(["101"]), undefined, 1000);
  const waiting = broker.handle(request);
  const view = broker.listFor(101, sessionId)[0]!;
  assert.equal(view.title, "git status");
  assert.match(view.summary ?? "", /папка проекта/);
  assert.equal(broker.listFor(202, sessionId).length, 0);
  assert.equal(broker.resolve(202, sessionId, view.id, "accept"), false);
  assert.equal(broker.resolve(101, "66666666-6666-4666-8666-666666666666", view.id, "accept"), false);
  assert.equal(broker.resolve(101, sessionId, view.id, "made-up"), false);
  assert.equal(broker.resolve(101, sessionId, view.id, "accept"), true);
  assert.deepEqual(await waiting, { outcome: { outcome: "selected", optionId: "accept" } });
  assert.equal(f.published[0]?.payload.kind, "approval");
});

test("mobile command approval offers a separate session-scoped allow choice", async () => {
  const f = fixture();
  const broker = new MobileApprovalBroker(f.feed, f.registry, new Set(["101"]), undefined, 1000);
  const commandRequest: RequestPermissionParams = {
    sessionId,
    toolCall: { toolCallId: "approval-command", title: "npm test", kind: "execute" },
    options: [{ optionId: "accept", name: "Разрешить один раз" }, { optionId: "decline", name: "Отклонить" }],
    mobileOptions: [{ optionId: "codex-mobile-session-allow", name: "Разрешить для сеанса" }],
  };
  const waiting = broker.handle(commandRequest);
  const approval = broker.listFor(101, sessionId)[0]!;
  assert.deepEqual(approval.options.map((option) => option.id), ["accept", "codex-mobile-session-allow", "decline"]);
  assert.equal(approval.options[1]?.label, "Разрешить для сеанса");
  assert.equal(broker.resolve(101, sessionId, approval.id, "codex-mobile-session-allow"), true);
  assert.deepEqual(await waiting, { outcome: { outcome: "selected", optionId: "codex-mobile-session-allow" } });
});

test("mobile approval broker never invents a session grant missing from Codex choices", async () => {
  const f = fixture();
  const broker = new MobileApprovalBroker(f.feed, f.registry, new Set(["101"]), undefined, 1000);
  const waiting = broker.handle({
    sessionId,
    toolCall: { title: "npm test", kind: "execute" },
    options: [{ optionId: "accept", name: "Разрешить один раз" }, { optionId: "decline", name: "Отклонить" }],
  });
  const approval = broker.listFor(101, sessionId)[0]!;
  assert.deepEqual(approval.options.map((option) => option.id), ["accept", "decline"]);
  assert.equal(broker.resolve(101, sessionId, approval.id, "decline"), true);
  assert.deepEqual(await waiting, { outcome: { outcome: "selected", optionId: "decline" } });
});

test("mobile MCP elicitation collects a bounded form for its owned session", async () => {
  const f = fixture();
  const broker = new MobileElicitationBroker(f.feed, f.registry, new Set(["101"]), 1000);
  const waiting = broker.handle({
    threadId: sessionId,
    serverName: "fixture-account",
    mode: "form",
    message: "Enter an account id",
    requestedSchema: {
      type: "object",
      properties: { account_id: { type: "string", title: "Account id", description: "The account to inspect", maxLength: 32 } },
      required: ["account_id"],
    },
  });
  const request = broker.listFor(101, sessionId)[0]!;
  assert.equal(request.serverName, "fixture-account");
  assert.deepEqual(request.fields, [{
    name: "account_id", label: "Account id", type: "string", required: true,
    description: "The account to inspect", maxLength: 32,
  }]);
  assert.equal(broker.resolve(202, sessionId, String(request.id), "accept", { account_id: "customer-7" }), false);
  assert.equal(broker.resolve(101, "66666666-6666-4666-8666-666666666666", String(request.id), "accept", { account_id: "customer-7" }), false);
  assert.equal(broker.resolve(101, sessionId, String(request.id), "accept", { account_id: "customer-7", extra: "not requested" }), false);
  assert.equal(broker.resolve(101, sessionId, String(request.id), "accept", { account_id: "customer-7" }), true);
  assert.deepEqual(await waiting, { action: "accept", content: { account_id: "customer-7" } });
  assert.equal(f.published[0]?.payload.kind, "elicitation");
  assert.equal("elicitation" in (f.published[0]?.payload ?? {}), false, "form values and callback URLs must stay out of replayable SSE history");
});

test("MCP elicitation declines schemas with constraints the phone cannot validate", async () => {
  const f = fixture();
  const broker = new MobileElicitationBroker(f.feed, f.registry, new Set(["101"]), 1000);
  const waiting = broker.handle({
    threadId: sessionId, serverName: "fixture-account", mode: "form", message: "Enter account id",
    requestedSchema: { type: "object", properties: { account_id: { type: "string", pattern: "^[A-Z]+$" } } },
  });
  const pending = broker.listFor(101, sessionId)[0];
  try { assert.equal(pending, undefined, "unsupported validation rules must not be dropped before acceptance"); }
  finally { if (pending) broker.resolve(101, sessionId, pending.id, "cancel"); }
  assert.deepEqual(await waiting, { action: "decline", content: null });
});

test("MCP URL elicitation is declined unless its provider link uses HTTPS", async () => {
  const f = fixture();
  const broker = new MobileElicitationBroker(f.feed, f.registry, new Set(["101"]));
  const result = await broker.handle({
    threadId: sessionId, serverName: "fixture-account", mode: "url", message: "Continue sign-in",
    url: "javascript:alert(1)",
  });
  assert.deepEqual(result, { action: "decline", content: null });
  assert.equal(broker.listFor(101, sessionId).length, 0);
  assert.equal(f.published.length, 0);
});

test("unanswered MCP elicitation expires as cancelled and is removed", async () => {
  const f = fixture();
  const broker = new MobileElicitationBroker(f.feed, f.registry, new Set(["101"]), 10);
  const waiting = broker.handle({
    threadId: sessionId, serverName: "fixture-account", mode: "url", message: "Continue sign-in",
    url: "https://accounts.example.test/authorize",
  });
  assert.equal(broker.listFor(101, sessionId).length, 1);
  assert.deepEqual(await waiting, { action: "cancel", content: null });
  assert.equal(broker.listFor(101, sessionId).length, 0);
});

test("requests without an active phone viewer retain the existing Telegram fallback", async () => {
  const f = fixture(false);
  let fallbackCalls = 0;
  const broker = new MobileApprovalBroker(f.feed, f.registry, new Set(["101"]), async () => {
    fallbackCalls++;
    return { outcome: { outcome: "selected", optionId: "decline" } };
  });
  assert.deepEqual(await broker.handle(request), { outcome: { outcome: "selected", optionId: "decline" } });
  assert.equal(fallbackCalls, 1);
  assert.equal(f.published.length, 0);
});

test("an unanswered phone approval expires to Telegram instead of claiming an allow", async () => {
  const f = fixture();
  const broker = new MobileApprovalBroker(f.feed, f.registry, new Set(["101"]), async () => ({
    outcome: { outcome: "selected", optionId: "decline" },
  }), 5);
  assert.deepEqual(await broker.handle(request), { outcome: { outcome: "selected", optionId: "decline" } });
  assert.equal(broker.listFor(101, sessionId).length, 0);
});
