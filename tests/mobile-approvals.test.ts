import assert from "node:assert/strict";
import test from "node:test";
import { MobileApprovalBroker } from "../src/mobile/approvals.js";
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
  };
  const waiting = broker.handle(commandRequest);
  const approval = broker.listFor(101, sessionId)[0]!;
  assert.deepEqual(approval.options.map((option) => option.id), ["accept", "acceptForSession", "decline"]);
  assert.equal(approval.options[1]?.label, "Разрешить для сеанса");
  assert.equal(broker.resolve(101, sessionId, approval.id, "acceptForSession"), true);
  assert.deepEqual(await waiting, { outcome: { outcome: "selected", optionId: "acceptForSession" } });
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
