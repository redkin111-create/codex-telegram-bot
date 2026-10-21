import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { MobileAuthStore } from "../src/mobile/auth.js";
import { MobileSubmissionRejectedError } from "../src/mobile/submission.js";
import type { MobileAccountController } from "../src/mobile/accounts.js";
import { createMobileServer, type MobileServerOptions } from "../src/mobile/server.js";
import type { LiveEvent, TmaLiveFeed } from "../src/tma/live.js";

const allowedSession = "00000000-0000-4000-8000-000000000101";
const foreignSession = "00000000-0000-4000-8000-000000000202";
const secondOwnedSession = "00000000-0000-4000-8000-000000000303";

class FixtureFeed {
  readonly epoch = "1234567890abcdef12345678";
  readonly cursors: number[] = [];
  readonly replay: LiveEvent[] = [];
  private listeners = new Set<(event: LiveEvent) => void>();

  latestId() { return 9; }
  getStatus(_sessionId: string) { return undefined; }
  subscribe(sessionId: string, after: number, listener: (event: LiveEvent) => void) {
    this.cursors.push(after);
    this.listeners.add(listener);
    for (const event of this.replay) if (event.sessionId === sessionId && event.id > after) listener(event);
    return () => this.listeners.delete(listener);
  }
  publish(event: LiveEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

async function startFixture(extensions: Record<string, unknown> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-mobile-server-"));
  const auth = new MobileAuthStore(dataDir, { allowedOwners: new Set(["101"]) });
  const feed = new FixtureFeed();
  const calls: Array<{ op: string; userId: number; args: Record<string, unknown>; attachments?: unknown[] }> = [];
  let failNext = false;
  let nextSendResult: unknown = { result: "queued" };
  let nextExecutionError: Error | undefined;
  let mobileSendLookup: (ownerId: number, args: Record<string, unknown>) => { found: boolean; result?: unknown } = () => ({ found: false });
  let downloadValue: unknown = { name: "release.zip", size: 4, bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]) };
  let readImageValue: unknown = { name: "pixel.png", mime: "image/png", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64") };
  const settings = { model: "fixture-model", mode: "code", reasoning: "medium" };
  const approvalId = "44444444-4444-4444-8444-444444444444";
  const approvalDecisions: Array<{ ownerId: number; sessionId: string; id: string; optionId: string }> = [];
  const accountCalls: Array<{ ownerId: number; action?: unknown }> = [];
  let activeAccount = "account-personal-1";
  let autoRotate = false;
  let deviceLoginPending = false;
  let mobileOAuthResult: unknown = { authorizationUrl: "https://provider.example/authorize" };
  const accountController = {
    async snapshot(ownerId: number) {
      accountCalls.push({ ownerId });
      if (ownerId !== 101) throw new Error("Доступ к аккаунтам запрещён");
      return { loggedIn: true, activeAccountId: activeAccount, activeLabel: activeAccount, autoRotate,
        ...(deviceLoginPending ? { deviceLogin: { status: "pending", startedAt: "2026-10-18T00:00:00.000Z", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" } } : {}),
        accounts: [{ id: "account-personal-1", label: "Личный", savedAt: "2026-10-18T00:00:00.000Z", active: activeAccount === "account-personal-1" },
          { id: "account-work-001", label: "Работа", savedAt: "2026-10-17T00:00:00.000Z", active: activeAccount === "account-work-001" }] };
    },
    async execute(ownerId: number, action: unknown) {
      accountCalls.push({ ownerId, action });
      if (ownerId !== 101) throw new Error("Доступ к аккаунтам запрещён");
      const body = action as { action?: string; id?: string; label?: string; enabled?: boolean };
      if (body.action === "switch") activeAccount = body.id ?? activeAccount;
      if (body.action === "setAutoRotate") autoRotate = body.enabled === true;
      if (body.action === "startDeviceLogin") deviceLoginPending = true;
      return { snapshot: await accountController.snapshot(ownerId), message: "Действие аккаунта выполнено" };
    },
  } as unknown as MobileAccountController;
  const agent = {
    async canReadSession(id: string, ownerId: number) { return (id === allowedSession || id === secondOwnedSession) && ownerId === 101; },
    lookupMobileSend(ownerId: number, args: Record<string, unknown>) { return mobileSendLookup(ownerId, args); },
    async execute(job: { op: string; userId: number; args: Record<string, unknown> }, attachments?: unknown[]) {
      calls.push({ ...job, ...(attachments ? { attachments } : {}) });
      if (nextExecutionError) { const error = nextExecutionError; nextExecutionError = undefined; throw error; }
      if (failNext) { failNext = false; throw new Error("Codex runtime unavailable"); }
      if (job.op === "snapshot") return { projects: [{ path: "C:\\work\\demo", name: "demo" }], sessions: [{ id: allowedSession, title: "Demo" }] };
      if (job.op === "history") return { entries: [{ role: "assistant", text: "Safe fixture history" }], images: [] };
      if (job.op === "image") return { name: "screen.png", mime: "image/png", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64") };
      return job.op === "send" ? nextSendResult : { ok: true, op: job.op };
    },
    async executeMobile(job: { op: string; userId: number; args: Record<string, unknown> }) {
      calls.push(job);
      if (failNext) { failNext = false; throw new Error("Codex runtime unavailable"); }
      if (job.op === "mcpOAuthLogin") return mobileOAuthResult;
      if (job.op === "listThreadReadStates") return { states: {
        [allowedSession]: { firstUnread: { type: "turn", turnId: "turn-one" }, revision: "rev-one" },
        [foreignSession]: { firstUnread: null, revision: "rev-foreign" },
      } };
      if (job.op === "files" && job.args.offset === 250) return {
        project: "fixture", path: String(job.args.path ?? ""),
        entries: [{ name: "file-250.txt", kind: "file", size: 10, mtimeMs: 1 }], total: 260, nextOffset: 251,
      };
      if (job.op === "readImage") return readImageValue;
      if (job.op === "downloadFile") return downloadValue;
      if (job.op === "capabilities" && job.args.section === "skills") return {
        skills: [{ name: "fixture-skill", description: "Safe plain text", enabled: true, scope: "user", canToggle: true, invokable: true }],
      };
      if (job.op === "capabilities" && job.args.section === "apps") return {
        apps: [{ id: "fixture-app", name: "Fixture App", enabled: true, accessible: true, callable: true }], appsAvailable: true,
      };
      if (job.op === "capabilities" && job.args.section === "plugins") return {
        plugins: [], pluginCatalogAvailable: true, marketplaces: [],
      };
      if (job.op === "capabilities" && job.args.section === "mcp") return {
        mcpServers: [], mcpServersAvailable: true,
      };
      if (job.op === "capabilities") return {
        online: true, ...settings, models: [{ id: settings.model, name: "Fixture Model" }],
        modes: [{ id: settings.mode, name: "Code" }], reasoningLevels: ["low", "medium", "high"],
        skills: [{ name: "fixture-skill", description: "Safe plain text", enabled: true, scope: "user", canToggle: true, invokable: true }],
        mcpServersAvailable: true,
        mcpServers: [{ name: "fixture-mcp", status: "connected", authStatus: "oauth", tools: [], toolCount: 2, resourceCount: 0, resourceTemplateCount: 0, discoveryFailed: false }],
        limits: [], subagents: [], checkedAt: 1,
        plugins: [], pluginCatalogAvailable: false, marketplaces: [], apps: [], appsAvailable: false,
      };
      if (job.op === "setModel") settings.model = String(job.args.modelId);
      if (job.op === "setMode") settings.mode = String(job.args.modeId);
      if (job.op === "setReasoning") settings.reasoning = String(job.args.effort);
      return { ok: true, op: job.op };
    },
  };
  const options: MobileServerOptions = {
    auth,
    agent: agent as unknown as MobileServerOptions["agent"],
    accounts: accountController,
    feed: feed as unknown as TmaLiveFeed,
    approvals: {
      listFor(ownerId: number, sessionId: string) {
        return ownerId === 101 && sessionId === allowedSession ? [{ id: approvalId, title: "git status", kind: "execute", options: [{ id: "accept", label: "Разрешить" }, { id: "decline", label: "Отклонить" }] }] : [];
      },
      resolve(ownerId: number, sessionId: string, id: string, optionId: string) {
        if (ownerId !== 101 || sessionId !== allowedSession || id !== approvalId || !["accept", "decline"].includes(optionId)) return false;
        approvalDecisions.push({ ownerId, sessionId, id, optionId });
        return true;
      },
    },
    dataDir,
    staticRoot: join(dataDir, "no-static-app"),
    port: 0,
  };
  Object.assign(options, extensions);
  const server = createMobileServer(options);
  server.listen(options.port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  return { server, auth, feed, calls, approvalDecisions, approvalId, accountCalls, dataDir, origin, failNext: () => { failNext = true; },
    setNextSendResult: (value: unknown) => { nextSendResult = value; },
    setNextExecutionError: (value: Error) => { nextExecutionError = value; },
    setMobileSendLookup: (lookup: typeof mobileSendLookup) => { mobileSendLookup = lookup; },
    setMobileOAuthResult: (value: unknown) => { mobileOAuthResult = value; },
    setDownloadValue: (value: unknown) => { downloadValue = value; }, setReadImageValue: (value: unknown) => { readImageValue = value; } };
}

async function pair(origin: string, auth: MobileAuthStore) {
  const start = await fetch(origin + "/api/pairing/start", {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ deviceName: "Pixel fixture" }),
  });
  assert.equal(start.status, 201);
  const challenge = await start.json() as { code: string };
  const pairCookie = cookiePair(start.headers.get("set-cookie"), "__Host-codex-mobile-pair");
  assert.equal(auth.approvePairing(challenge.code, 101), true);
  const complete = await fetch(origin + "/api/pairing/status", {
    headers: { origin, cookie: pairCookie },
  });
  assert.equal(complete.status, 200);
  const login = await complete.json() as { status: string; csrfToken: string; device: { id: string } };
  assert.equal(login.status, "approved");
  const allCookies = complete.headers.get("set-cookie");
  const sessionCookie = cookiePair(allCookies, "__Host-codex-mobile-session");
  const csrfCookie = cookiePair(allCookies, "__Host-codex-mobile-csrf");
  return { sessionCookie: `${sessionCookie}; ${csrfCookie}`, csrfToken: login.csrfToken, deviceId: login.device.id };
}

function cookiePair(header: string | null, name: string): string {
  const pairs = (header ?? "").split(/,\s*(?=[^;=]+=)/).map((part) => part.split(";")[0] ?? "");
  const match = pairs.find((part) => part.startsWith(name + "="));
  assert.ok(match, `missing ${name} cookie`);
  return match;
}

async function cleanup(server: ReturnType<typeof createMobileServer>, dataDir: string) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataDir, { recursive: true, force: true });
}

test("mobile CSP allows xterm dynamic style attributes without enabling inline scripts", async () => {
  const f = await startFixture();
  try {
    const response = await fetch(f.origin + "/");
    const policy = response.headers.get("content-security-policy") ?? "";
    assert.match(policy, /style-src 'self'/);
    assert.match(policy, /style-src-attr 'unsafe-inline'/);
    assert.match(policy, /style-src-elem 'self'/);
    for (const hash of [
      "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
      "sha256-F0eMgzg/9KDZDnYmAjaV1/2SVRvtQav/R/mGbug/9vw=",
      "sha256-F373287esZMEf6fH5syQf9hJdPZHmyAKDxyt1H1UA40=",
      "sha256-ezbEZDDsGwbs2nP7zHAZYx+JLcKZYXQVoyLydn9yd/I=",
    ]) assert.ok(policy.includes(hash), `missing trusted xterm style hash ${hash}`);
    assert.doesNotMatch(policy, /style-src-elem[^;]*unsafe-inline/);
    assert.match(policy, /script-src 'self'(?:;|$)/);
    assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("private API and event stream reject requests without a paired device", async () => {
  const f = await startFixture();
  try {
    const snapshot = await fetch(f.origin + "/api/snapshot", { headers: { origin: f.origin } });
    assert.equal(snapshot.status, 401);
    const events = await fetch(f.origin + "/api/events", {
      method: "POST", headers: { origin: f.origin, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: allowedSession, after: 0, epoch: "" }),
    });
    assert.equal(events.status, 401);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("snapshot returns only authorized Codex read receipts and read-state changes require CSRF and ownership", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const snapshotResponse = await fetch(f.origin + "/api/snapshot", {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json() as { sessions: Array<{ id: string; readState?: { revision: string } }> };
    assert.equal(snapshot.sessions.find((session) => session.id === allowedSession)?.readState?.revision, "rev-one");
    assert.equal(snapshot.sessions.some((session) => session.id === foreignSession), false);

    const body = (sessionId: string, expectedRevision = "rev-one") => JSON.stringify({
      op: "updateThreadReadState", args: { sessionId, expectedRevision, operation: "read" },
    });
    const headers = { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" };
    assert.equal((await fetch(f.origin + "/api/operations", {
      method: "POST", headers, body: body(allowedSession),
    })).status, 403, "state changes need CSRF protection");
    const beforeForeign = f.calls.length;
    assert.equal((await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { ...headers, "x-csrf-token": login.csrfToken }, body: body(foreignSession),
    })).status, 403, "foreign sessions must be rejected before reaching the agent");
    assert.equal(f.calls.length, beforeForeign);
    const updated = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { ...headers, "x-csrf-token": login.csrfToken }, body: body(allowedSession, "stale-revision"),
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(f.calls.at(-1), {
      op: "updateThreadReadState", userId: 101,
      args: { sessionId: allowedSession, expectedRevision: "stale-revision", operation: "read" },
    });
  } finally { await cleanup(f.server, f.dataDir); }
});

test("account API requires a paired device, Origin and CSRF and delegates only the paired owner", async () => {
  const f = await startFixture();
  try {
    assert.equal((await fetch(f.origin + "/api/accounts")).status, 401);
    const login = await pair(f.origin, f.auth);
    const read = await fetch(f.origin + "/api/accounts", { headers: { origin: f.origin, cookie: login.sessionCookie } });
    assert.equal(read.status, 200);
    const snapshot = await read.json() as { accounts: Array<Record<string, unknown>> };
    assert.equal(snapshot.accounts.length, 2);
    assert.equal(JSON.stringify(snapshot).includes("fingerprint"), false);
    const body = JSON.stringify({ action: "switch", id: "account-work-001" });
    assert.equal((await fetch(f.origin + "/api/accounts", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body,
    })).status, 403);
    assert.equal((await fetch(f.origin + "/api/accounts", {
      method: "POST", headers: { origin: "https://attacker.invalid", cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body,
    })).status, 403);
    assert.equal(f.accountCalls.some((call) => call.action !== undefined), false);
    const changed = await fetch(f.origin + "/api/accounts", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body,
    });
    assert.equal(changed.status, 200);
    assert.equal(f.accountCalls.at(-1)?.ownerId, 101);
    assert.equal((await changed.json() as { snapshot: { activeAccountId: string } }).snapshot.activeAccountId, "account-work-001");

    const deviceLoginBody = JSON.stringify({ action: "startDeviceLogin" });
    const beforeDeviceLogin = f.accountCalls.filter((call) => call.action !== undefined).length;
    assert.equal((await fetch(f.origin + "/api/accounts", {
      method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: deviceLoginBody,
    })).status, 401);
    assert.equal((await fetch(f.origin + "/api/accounts", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: deviceLoginBody,
    })).status, 403);
    assert.equal((await fetch(f.origin + "/api/accounts", {
      method: "POST", headers: { origin: "https://attacker.invalid", cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: deviceLoginBody,
    })).status, 403);
    assert.equal(f.accountCalls.filter((call) => call.action !== undefined).length, beforeDeviceLogin);
    const deviceLogin = await fetch(f.origin + "/api/accounts", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: deviceLoginBody,
    });
    assert.equal(deviceLogin.status, 200);
    assert.equal(f.accountCalls.some((call) => call.ownerId === 101 && (call.action as { action?: string } | undefined)?.action === "startDeviceLogin"), true);
    assert.equal((await deviceLogin.json() as { snapshot: { deviceLogin: { status: string } } }).snapshot.deviceLogin.status, "pending");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("MCP config and shared Codex restart operations require paired session ownership and CSRF", async () => {
  const f = await startFixture();
  try {
    const body = (op: string, sessionId = allowedSession, extra: Record<string, unknown> = {}) => JSON.stringify({
      op, args: { sessionId, ...extra },
    });
    assert.equal((await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, "content-type": "application/json" },
      body: body("listMcpConfig"),
    })).status, 401);

    const login = await pair(f.origin, f.auth);
    const headers = { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" };
    assert.equal((await fetch(f.origin + "/api/operations", {
      method: "POST", headers, body: body("listMcpConfig"),
    })).status, 403);

    const beforeForeign = f.calls.length;
    const foreign = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { ...headers, "x-csrf-token": login.csrfToken },
      body: body("listMcpConfig", foreignSession),
    });
    assert.equal(foreign.status, 403);
    assert.equal(f.calls.length, beforeForeign, "foreign session requests must never reach the agent");

    const read = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { ...headers, "x-csrf-token": login.csrfToken },
      body: body("listMcpConfig"),
    });
    assert.equal(read.status, 200);
    assert.equal(f.calls.at(-1)?.op, "listMcpConfig");
    assert.equal(f.calls.at(-1)?.userId, 101);

    const forbiddenChange = await fetch(f.origin + "/api/operations", {
      method: "POST", headers, body: body("setMcpConfigEnabled", allowedSession, { name: "fixture", enabled: false }),
    });
    assert.equal(forbiddenChange.status, 403);
    const changed = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { ...headers, "x-csrf-token": login.csrfToken },
      body: body("setMcpConfigEnabled", allowedSession, { name: "fixture", scope: "workspace", enabled: false }),
    });
    assert.equal(changed.status, 200);
    assert.equal(f.calls.at(-1)?.op, "setMcpConfigEnabled");

    const removeBody = body("removeMcpConfigServer", allowedSession, { name: "fixture", scope: "workspace" });
    const removeWithoutCsrf = await fetch(f.origin + "/api/operations", { method: "POST", headers, body: removeBody });
    assert.equal(removeWithoutCsrf.status, 403);
    const beforeForeignRemove = f.calls.length;
    const foreignRemove = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { ...headers, "x-csrf-token": login.csrfToken },
      body: body("removeMcpConfigServer", foreignSession, { name: "fixture", scope: "workspace" }),
    });
    assert.equal(foreignRemove.status, 403);
    assert.equal(f.calls.length, beforeForeignRemove, "foreign session MCP removal must never reach the agent");
    const removed = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { ...headers, "x-csrf-token": login.csrfToken }, body: removeBody,
    });
    assert.equal(removed.status, 200);
    assert.equal(f.calls.at(-1)?.op, "removeMcpConfigServer");

    const addBody = body("addMcpConfigServer", allowedSession, {
      name: "from_phone", scope: "workspace", transport: "stdio", command: "node", args: ["server.js"], env: { TOKEN: "fixture-secret" },
    });
    const addWithoutCsrf = await fetch(f.origin + "/api/operations", { method: "POST", headers, body: addBody });
    assert.equal(addWithoutCsrf.status, 403);
    const addWrongOrigin = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { ...headers, origin: "https://attacker.example", "x-csrf-token": login.csrfToken }, body: addBody,
    });
    assert.equal(addWrongOrigin.status, 403);
    const beforeForeignAdd = f.calls.length;
    const foreignAdd = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { ...headers, "x-csrf-token": login.csrfToken },
      body: body("addMcpConfigServer", foreignSession, { name: "foreign", scope: "workspace", transport: "stdio", command: "node" }),
    });
    assert.equal(foreignAdd.status, 403);
    assert.equal(f.calls.length, beforeForeignAdd);
    const added = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { ...headers, "x-csrf-token": login.csrfToken }, body: addBody,
    });
    assert.equal(added.status, 200);
    assert.equal(f.calls.at(-1)?.op, "addMcpConfigServer");
    assert.equal(f.calls.at(-1)?.userId, 101);
    assert.doesNotMatch(await added.text(), /fixture-secret/);

    const restart = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { ...headers, "x-csrf-token": login.csrfToken },
      body: body("restartCodex"),
    });
    assert.equal(restart.status, 200);
    assert.equal(f.calls.at(-1)?.op, "restartCodex");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("mobile document uploads require CSRF and an owned session, then attach server-prepared text to one send", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = new URL("/api/attachments", f.origin);
    url.searchParams.set("sessionId", allowedSession);
    url.searchParams.set("name", "notes.md");
    const bytes = "# Mobile attachment\nReview this change safely.";
    const upload = (headers: Record<string, string> = {}) => fetch(url, {
      method: "POST",
      headers: { origin: f.origin, "content-type": "text/markdown", ...headers },
      body: bytes,
    });

    assert.equal((await upload()).status, 401);
    assert.equal((await upload({ cookie: login.sessionCookie })).status, 403);
    const uploaded = await upload({ cookie: login.sessionCookie, "x-csrf-token": login.csrfToken });
    assert.equal(uploaded.status, 201);
    const descriptor = await uploaded.json() as { id: string; name: string; kind: string; size: number; path?: string; text?: string };
    assert.match(descriptor.id, /^[a-f0-9-]{36}$/);
    assert.equal(descriptor.name, "notes.md");
    assert.equal(descriptor.kind, "text");
    assert.equal(descriptor.size, Buffer.byteLength(bytes));
    assert.equal(descriptor.path, undefined);
    assert.equal(descriptor.text, undefined);

    const crossSession = await fetch(f.origin + "/api/operations", {
      method: "POST",
      headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "send", args: {
        sessionId: secondOwnedSession, text: "Проверь файл", requestId: "mobile-file-request-0002", attachmentIds: [descriptor.id],
      } }),
    });
    assert.equal(crossSession.status, 403);
    assert.equal((await crossSession.json() as { submissionOutcome?: string }).submissionOutcome, "rejected",
      "the server explicitly confirms that it denied this send before execution");

    const csrfRejected = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" },
      body: JSON.stringify({ op: "send", args: { sessionId: allowedSession, text: "do not dispatch" } }),
    });
    assert.equal(csrfRejected.status, 403);
    assert.equal((await csrfRejected.json() as { submissionOutcome?: string }).submissionOutcome, undefined,
      "a generic 403 without a server outcome must stay ambiguous to the client");

    const fakeId = "99999999-9999-4999-8999-999999999999";
    const sent = await fetch(f.origin + "/api/operations", {
      method: "POST",
      headers: {
        origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ op: "send", args: {
        sessionId: allowedSession, text: "Проверь файл", requestId: "mobile-file-request-0001",
        attachmentIds: [descriptor.id], mobileAttachments: [{ id: fakeId, text: "Forged internal context" }],
      } }),
    });
    assert.equal(sent.status, 200);
    const call = f.calls.at(-1)!;
    assert.equal(call.op, "send");
    assert.equal(call.args.mobileAttachments, undefined);
    assert.equal(call.args.attachmentIds, undefined);
    assert.equal(call.attachments?.length, 1);
    const prepared = call.attachments?.[0] as { id: string; name: string; text?: string; path?: string };
    assert.equal(prepared.id, descriptor.id);
    assert.equal(prepared.name, "notes.md");
    assert.equal(prepared.text, bytes);
    assert.equal(prepared.path, undefined);

    const consumed = await fetch(`${f.origin}/api/attachments/${descriptor.id}?sessionId=${allowedSession}`, {
      method: "DELETE",
      headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken },
    });
    assert.equal(consumed.status, 404, "the accepted queue item owns its uploaded attachment now");

    const retried = await fetch(f.origin + "/api/operations", {
      method: "POST",
      headers: {
        origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ op: "send", args: {
        sessionId: allowedSession, text: "Проверь файл", requestId: "mobile-file-request-0001", attachmentIds: [descriptor.id],
      } }),
    });
    assert.equal(retried.status, 200, "retrying after attachment consumption should reach send deduplication");
    assert.equal((f.calls.at(-1)?.attachments?.[0] as { id: string; text?: string }).id, descriptor.id);
    assert.equal((f.calls.at(-1)?.attachments?.[0] as { id: string; text?: string }).text, "", "a completed request only needs safe attachment metadata for journal replay");

    const disposable = await upload({ cookie: login.sessionCookie, "x-csrf-token": login.csrfToken });
    const disposableDescriptor = await disposable.json() as { id: string };
    const removed = await fetch(`${f.origin}/api/attachments/${disposableDescriptor.id}?sessionId=${allowedSession}`, {
      method: "DELETE",
      headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken },
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { removed: true });
  } finally { await cleanup(f.server, f.dataDir); }
});

test("a confirmed pre-dispatch rejection tells mobile it is safe to unlock and remove the attachment", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const uploadUrl = new URL("/api/attachments", f.origin);
    uploadUrl.searchParams.set("sessionId", allowedSession);
    uploadUrl.searchParams.set("name", "retry.txt");
    const upload = await fetch(uploadUrl, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "text/plain" },
      body: "keep this draft",
    });
    const attachment = await upload.json() as { id: string };
    f.setNextExecutionError(new MobileSubmissionRejectedError("Codex сейчас офлайн"));
    const response = await fetch(f.origin + "/api/operations", {
      method: "POST",
      headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "send", args: {
        sessionId: allowedSession, text: "Прочитай файл", requestId: "mobile-file-refused-0001", attachmentIds: [attachment.id],
      } }),
    });

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "Codex сейчас офлайн", submissionOutcome: "rejected" });
    const removed = await fetch(`${f.origin}/api/attachments/${attachment.id}?sessionId=${allowedSession}`, {
      method: "DELETE",
      headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken },
    });
    assert.deepEqual(await removed.json(), { removed: true }, "the rejected request must release its upload claim");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("a blocked send is a confirmed refusal and leaves its attachment available for correction", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const uploadUrl = new URL("/api/attachments", f.origin);
    uploadUrl.searchParams.set("sessionId", allowedSession);
    uploadUrl.searchParams.set("name", "retry.txt");
    const upload = await fetch(uploadUrl, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "text/plain" },
      body: "keep this draft",
    });
    const attachment = await upload.json() as { id: string };
    f.setNextSendResult({ result: "blocked" });
    const response = await fetch(f.origin + "/api/operations", {
      method: "POST",
      headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "send", args: {
        sessionId: allowedSession, text: "Прочитай файл", requestId: "mobile-file-blocked-0001", attachmentIds: [attachment.id],
      } }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: "blocked" });
    const removed = await fetch(`${f.origin}/api/attachments/${attachment.id}?sessionId=${allowedSession}`, {
      method: "DELETE",
      headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken },
    });
    assert.deepEqual(await removed.json(), { removed: true });
  } finally { await cleanup(f.server, f.dataDir); }
});

test("a durable attachment send replay is checked before resolving expired upload IDs", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const attachmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    f.setMobileSendLookup((ownerId, args) => {
      assert.equal(ownerId, 101);
      assert.equal(args.requestId, "mobile-restart-request-01");
      assert.deepEqual(args.attachmentIds, [attachmentId]);
      return { found: true, result: { result: "already-sent" } };
    });
    const response = await fetch(f.origin + "/api/operations", {
      method: "POST",
      headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "send", args: {
        sessionId: allowedSession, text: "Проверь файл", requestId: "mobile-restart-request-01", attachmentIds: [attachmentId],
      } }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: "already-sent" });
    assert.equal(f.calls.some((call) => call.op === "send"), false, "a replay must return before missing upload IDs can block or resend it");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("an accepted attachment send survives a dropped HTTP response and replays the same request once", async () => {
  const requestId = "mobile-lost-response-0001";
  const acceptedResult = { result: "ran" };
  let dispatchCount = 0;
  let accepted!: () => void;
  let finished!: () => void;
  const acceptedSignal = new Promise<void>((resolve) => { accepted = resolve; });
  const finishedSignal = new Promise<void>((resolve) => { finished = resolve; });
  let recordedResult: unknown;
  const agent = {
    async canReadSession(sessionId: string, ownerId: number) {
      return ownerId === 101 && sessionId === allowedSession;
    },
    lookupMobileSend(ownerId: number, args: Record<string, unknown>) {
      assert.equal(ownerId, 101);
      assert.equal(args.requestId, requestId);
      return recordedResult === undefined ? { found: false } : { found: true, result: recordedResult };
    },
    async execute(job: { op: string; userId: number; args: Record<string, unknown> }, attachments?: Array<{ id: string }>) {
      assert.equal(job.op, "send");
      assert.equal(job.args.requestId, requestId);
      assert.equal(attachments?.length, 1);
      dispatchCount++;
      recordedResult = acceptedResult;
      accepted();
      await new Promise((resolve) => setTimeout(resolve, 150));
      finished();
      return acceptedResult;
    },
  };
  const f = await startFixture({ agent });
  try {
    const login = await pair(f.origin, f.auth);
    const uploadUrl = new URL("/api/attachments", f.origin);
    uploadUrl.searchParams.set("sessionId", allowedSession);
    uploadUrl.searchParams.set("name", "queued.txt");
    const upload = await fetch(uploadUrl, {
      method: "POST",
      headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "text/plain" },
      body: "Queued work must retain this file.",
    });
    assert.equal(upload.status, 201);
    const attachment = await upload.json() as { id: string };
    const headers = {
      origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken,
      "content-type": "application/json",
    };
    const body = JSON.stringify({ op: "send", args: {
      sessionId: allowedSession, text: "Use the queued file", requestId, attachmentIds: [attachment.id],
    } });
    const controller = new AbortController();
    const firstResponse = fetch(f.origin + "/api/operations", {
      method: "POST", headers, body, signal: controller.signal,
    });
    await acceptedSignal;
    controller.abort();
    await assert.rejects(firstResponse, (error: unknown) => error instanceof Error && error.name === "AbortError");
    await finishedSignal;

    const replay = await fetch(f.origin + "/api/operations", { method: "POST", headers, body });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), acceptedResult);
    assert.equal(dispatchCount, 1, "retrying the lost response must not execute the accepted job again");
    const consumed = await fetch(`${f.origin}/api/attachments/${attachment.id}?sessionId=${allowedSession}`, {
      method: "DELETE", headers,
    });
    assert.equal(consumed.status, 404, "the accepted job keeps ownership of its attachment after the client disconnects");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("mobile attachment upload rejects foreign sessions, unsupported binaries and invalid PDF signatures", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const upload = (sessionId: string, name: string, type: string, body: Uint8Array | string) => {
      const url = new URL("/api/attachments", f.origin);
      url.searchParams.set("sessionId", sessionId);
      url.searchParams.set("name", name);
      return fetch(url, {
        method: "POST",
        headers: {
          origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken,
          "content-type": type,
        },
        body,
      });
    };
    assert.equal((await upload(foreignSession, "notes.md", "text/markdown", "private" )).status, 403);
    assert.equal((await upload(allowedSession, "payload.exe", "application/octet-stream", new Uint8Array([0, 1, 2, 3]))).status, 415);
    assert.equal((await upload(allowedSession, "broken.pdf", "application/pdf", "not a pdf" )).status, 415);
    const pdf = Buffer.from("%PDF-1.7\nfixture document");
    const accepted = await upload(allowedSession, "report.pdf", "application/pdf", pdf);
    assert.equal(accepted.status, 201);
    const descriptor = await accepted.json() as { id: string; kind: string; path?: string };
    assert.equal(descriptor.kind, "document");
    assert.equal(descriptor.path, undefined);
    assert.equal(f.calls.length, 0);

    const sent = await fetch(f.origin + "/api/operations", {
      method: "POST",
      headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "send", args: {
        sessionId: allowedSession, text: "Прочитай PDF", requestId: "mobile-pdf-request-0001", attachmentIds: [descriptor.id],
      } }),
    });
    assert.equal(sent.status, 200);
    const prepared = f.calls.at(-1)?.attachments?.[0] as { path?: string; name: string; text?: string };
    assert.equal(prepared.name, "report.pdf");
    assert.equal(prepared.text, undefined);
    assert.ok(prepared.path);
    const relativePath = relative(join(f.dataDir, "telegram-incoming"), prepared.path!);
    assert.ok(relativePath && !relativePath.startsWith(".."));
    assert.equal(JSON.stringify(descriptor).includes(prepared.path), false);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("reverse-proxy loopback headers cannot reach the laptop-only pairing approval channel", async () => {
  const f = await startFixture();
  try {
    const start = await fetch(f.origin + "/api/pairing/start", {
      method: "POST", headers: { origin: f.origin, "content-type": "application/json" },
      body: JSON.stringify({ deviceName: "Pixel fixture" }),
    });
    const { code: _code } = await start.json() as { code: string };
    const pairCookie = cookiePair(start.headers.get("set-cookie"), "__Host-codex-mobile-pair");
    const response = await fetch(f.origin + "/_local/pairings/approve", {
      method: "POST", headers: { "x-forwarded-for": "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ code: _code, ownerId: 101 }),
    });
    assert.equal(response.status, 404);
    const pairingState = await fetch(f.origin + "/api/pairing/status", { headers: { origin: f.origin, cookie: pairCookie } });
    assert.deepEqual(await pairingState.json(), { status: "pending" });
  } finally { await cleanup(f.server, f.dataDir); }
});

test("pairing cookie becomes a Secure HttpOnly session and reads the shared Codex catalogue", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const me = await fetch(f.origin + "/api/session", {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(me.status, 200);
    assert.equal((await me.json() as { device: { id: string } }).device.id, login.deviceId);
    const snapshot = await fetch(f.origin + "/api/snapshot", {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.deepEqual(await snapshot.json(), {
      projects: [{ path: "C:\\work\\demo", name: "demo" }],
      sessions: [{ id: allowedSession, title: "Demo", readState: { firstUnread: { type: "turn", turnId: "turn-one" }, revision: "rev-one" }, liveStatus: "unknown", liveLabel: "Статус неизвестен" }],
    });
    assert.equal(f.calls.at(-1)?.userId, 101);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("capabilities are authenticated and session-scoped before reaching the shared agent", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const capabilities = await fetch(f.origin + `/api/capabilities?sessionId=${allowedSession}`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(capabilities.status, 200);
    const result = await capabilities.json() as { models: Array<{ id: string }>; skills: Array<{ name: string }>; mcpServers: Array<{ toolCount: number }> };
    assert.equal(result.models[0]?.id, "fixture-model");
    assert.equal(result.skills[0]?.name, "fixture-skill");
    assert.equal(result.mcpServers[0]?.toolCount, 2);
    const foreign = await fetch(f.origin + `/api/capabilities?sessionId=${foreignSession}`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(foreign.status, 403);
    assert.equal(f.calls.filter((call) => call.op === "capabilities").length, 1);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("skill and app capability sections stay owner-scoped and reject invalid or sessionless requests", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const skills = await fetch(f.origin + `/api/capabilities?sessionId=${allowedSession}&section=skills`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(skills.status, 200);
    assert.deepEqual(await skills.json(), {
      skills: [{ name: "fixture-skill", description: "Safe plain text", enabled: true, scope: "user", canToggle: true, invokable: true }],
    });
    assert.deepEqual(f.calls.at(-1)?.args, { sessionId: allowedSession, section: "skills" });

    const apps = await fetch(f.origin + `/api/capabilities?sessionId=${allowedSession}&section=apps`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(apps.status, 200);
    assert.deepEqual(await apps.json(), {
      apps: [{ id: "fixture-app", name: "Fixture App", enabled: true, accessible: true, callable: true }], appsAvailable: true,
    });
    assert.deepEqual(f.calls.at(-1)?.args, { sessionId: allowedSession, section: "apps" });

    const callCount = f.calls.length;
    const foreign = await fetch(f.origin + `/api/capabilities?sessionId=${foreignSession}&section=skills`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(foreign.status, 403);
    const invalid = await fetch(f.origin + `/api/capabilities?sessionId=${allowedSession}&section=unknown`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(invalid.status, 400);
    const sessionless = await fetch(f.origin + "/api/capabilities?section=skills", {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(sessionless.status, 400);
    assert.equal(f.calls.length, callCount);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("plugin and MCP capability sections are authenticated and restricted to owned sessions", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const plugins = await fetch(f.origin + `/api/capabilities?sessionId=${allowedSession}&section=plugins`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(plugins.status, 200);
    assert.deepEqual(await plugins.json(), { plugins: [], pluginCatalogAvailable: true, marketplaces: [] });
    assert.deepEqual(f.calls.at(-1)?.args, { sessionId: allowedSession, section: "plugins" });

    const mcp = await fetch(f.origin + `/api/capabilities?sessionId=${allowedSession}&section=mcp`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(mcp.status, 200);
    assert.deepEqual(await mcp.json(), { mcpServers: [], mcpServersAvailable: true });
    assert.deepEqual(f.calls.at(-1)?.args, { sessionId: allowedSession, section: "mcp" });

    const callCount = f.calls.length;
    const foreign = await fetch(f.origin + `/api/capabilities?sessionId=${foreignSession}&section=mcp`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(foreign.status, 403);
    assert.equal(f.calls.length, callCount);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("Codex preference changes require an authorized session and device CSRF token", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const denied = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" },
      body: JSON.stringify({ op: "setReasoning", args: { sessionId: allowedSession, effort: "high" } }),
    });
    assert.equal(denied.status, 403);
    const foreign = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "setReasoning", args: { sessionId: foreignSession, effort: "high" } }),
    });
    assert.equal(foreign.status, 403);
    const updated = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "setReasoning", args: { sessionId: allowedSession, effort: "high" } }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json() as { ok: boolean }).ok, true);
    assert.equal(f.calls.filter((call) => call.op === "setReasoning").length, 1);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("voice transcription requires an authorized owned session and device CSRF token", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const args = { sessionId: allowedSession, mimeType: "audio/webm", data: Buffer.from("fixture").toString("base64") };
    const noCsrf = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" },
      body: JSON.stringify({ op: "transcribeAudio", args }),
    });
    assert.equal(noCsrf.status, 403);
    const foreign = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "transcribeAudio", args: { ...args, sessionId: foreignSession } }),
    });
    assert.equal(foreign.status, 403);
    const accepted = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "transcribeAudio", args }),
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json() as { op: string }).op, "transcribeAudio");
    assert.equal(f.calls.filter((call) => call.op === "transcribeAudio").length, 1);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("skill changes require the paired device, same Origin, CSRF and an owned session", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const body = (sessionId = allowedSession) => JSON.stringify({
      op: "setSkillEnabled", args: { sessionId, name: "fixture-skill", enabled: false },
    });
    const anonymous = await fetch(url, {
      method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: body(),
    });
    assert.equal(anonymous.status, 401);
    const noCsrf = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: body(),
    });
    assert.equal(noCsrf.status, 403);
    const foreign = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body(foreignSession),
    });
    assert.equal(foreign.status, 403);
    const updated = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body(),
    });
    assert.equal(updated.status, 200);
    assert.equal(f.calls.filter((call) => call.op === "setSkillEnabled").length, 1);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("steer requests require an authenticated device, same Origin, CSRF and session ownership", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const body = JSON.stringify({ op: "steer", args: { sessionId: allowedSession, requestId: "steer-request-0001", text: "Stop after the test" } });
    const anonymous = await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body });
    assert.equal(anonymous.status, 401);
    const noCsrf = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body,
    });
    assert.equal(noCsrf.status, 403);
    const foreign = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "steer", args: { sessionId: foreignSession, requestId: "steer-request-0002", text: "Do not send" } }),
    });
    assert.equal(foreign.status, 403);
    const accepted = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body,
    });
    assert.equal(accepted.status, 200);
    assert.equal(f.calls.at(-1)?.op, "steer");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("fork requests require a paired owner, same Origin and a device CSRF token", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const payload = (sessionId = allowedSession) => JSON.stringify({ op: "forkThread", args: { sessionId } });
    const anonymous = await fetch(url, {
      method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: payload(),
    });
    assert.equal(anonymous.status, 401);
    const noCsrf = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: payload(),
    });
    assert.equal(noCsrf.status, 403);
    const foreign = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: payload(foreignSession),
    });
    assert.equal(foreign.status, 403);
    const accepted = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: payload(),
    });
    assert.equal(accepted.status, 200);
    assert.equal(f.calls.at(-1)?.op, "forkThread");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("goal changes require an authenticated device, same Origin and CSRF", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const body = JSON.stringify({ op: "setGoal", args: { sessionId: allowedSession, objective: "Finish the mobile flow", tokenBudget: 5000 } });
    const anonymous = await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body });
    assert.equal(anonymous.status, 401);
    const noCsrf = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body,
    });
    assert.equal(noCsrf.status, 403);
    const changed = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body,
    });
    assert.equal(changed.status, 200);
    assert.equal(f.calls.at(-1)?.op, "setGoal");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("manual compaction requires a paired device, same Origin and CSRF", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const body = JSON.stringify({ op: "compactThread", args: { sessionId: allowedSession } });
    const anonymous = await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body });
    assert.equal(anonymous.status, 401);
    const noCsrf = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body,
    });
    assert.equal(noCsrf.status, 403);
    const accepted = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body,
    });
    assert.equal(accepted.status, 200);
    assert.equal(f.calls.at(-1)?.op, "compactThread");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("plugin changes require the paired device, same Origin, CSRF and an owned session", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const body = (sessionId = allowedSession) => JSON.stringify({ op: "installPlugin", args: { sessionId, pluginId: "fixture-plugin", marketplace: "official" } });
    const anonymous = await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: body() });
    assert.equal(anonymous.status, 401);
    const noCsrf = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: body() });
    assert.equal(noCsrf.status, 403);
    const wrongOrigin = await fetch(url, { method: "POST", headers: { origin: "https://attacker.example", cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(wrongOrigin.status, 403);
    const foreign = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body(foreignSession) });
    assert.equal(foreign.status, 403);
    assert.equal(f.calls.filter((call) => call.op === "installPlugin").length, 0);
    const accepted = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(accepted.status, 200);
    assert.equal(f.calls.at(-1)?.op, "installPlugin");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("plugin enablement is a protected per-session operation", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const body = (sessionId = allowedSession) => JSON.stringify({
      op: "setPluginEnabled", args: { sessionId, pluginId: "fixture-plugin", enabled: false },
    });
    const anonymous = await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: body() });
    assert.equal(anonymous.status, 401);
    const noCsrf = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: body() });
    assert.equal(noCsrf.status, 403);
    const wrongOrigin = await fetch(url, { method: "POST", headers: { origin: "https://attacker.example", cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(wrongOrigin.status, 403);
    const foreign = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body(foreignSession) });
    assert.equal(foreign.status, 403);
    assert.equal(f.calls.filter((call) => call.op === "setPluginEnabled").length, 0);
    const accepted = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(accepted.status, 200);
    assert.equal(f.calls.at(-1)?.op, "setPluginEnabled");
    assert.equal(f.calls.at(-1)?.userId, 101);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("marketplace changes require the paired owner, exact Origin, CSRF and an owned session", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const body = (sessionId = allowedSession) => JSON.stringify({ op: "addMarketplace", args: {
      sessionId, source: "fixture/mobile-tools", refName: "stable",
    } });
    const anonymous = await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: body() });
    assert.equal(anonymous.status, 401);
    const noCsrf = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: body() });
    assert.equal(noCsrf.status, 403);
    const wrongOrigin = await fetch(url, { method: "POST", headers: { origin: "https://attacker.example", cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(wrongOrigin.status, 403);
    const foreign = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body(foreignSession) });
    assert.equal(foreign.status, 403);
    const approved = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(approved.status, 200);
    assert.equal(f.calls.at(-1)?.op, "addMarketplace");
    assert.equal(f.calls.at(-1)?.userId, 101);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("MCP tool calls require a paired owner, exact Origin, CSRF and an owned session", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const body = (sessionId = allowedSession) => JSON.stringify({ op: "callMcpTool", args: {
      sessionId, server: "fixture-mcp", tool: "read_status", arguments: { query: "latest" },
    } });
    const anonymous = await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: body() });
    assert.equal(anonymous.status, 401);
    const noCsrf = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: body() });
    assert.equal(noCsrf.status, 403);
    const wrongOrigin = await fetch(url, { method: "POST", headers: { origin: "https://attacker.example", cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(wrongOrigin.status, 403);
    const foreign = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body(foreignSession) });
    assert.equal(foreign.status, 403);
    const approved = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(approved.status, 200);
    assert.equal(f.calls.at(-1)?.op, "callMcpTool");
    assert.equal(f.calls.at(-1)?.userId, 101);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("MCP resource reads require a paired owner, exact Origin, CSRF and an owned session", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const body = (sessionId = allowedSession) => JSON.stringify({ op: "readMcpResource", args: {
      sessionId, resourceId: "fixture-resource-reference", parameters: { account_id: "phone entered" },
    } });
    const anonymous = await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: body() });
    assert.equal(anonymous.status, 401);
    const noCsrf = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: body() });
    assert.equal(noCsrf.status, 403);
    const wrongOrigin = await fetch(url, { method: "POST", headers: { origin: "https://attacker.example", cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(wrongOrigin.status, 403);
    const foreign = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body(foreignSession) });
    assert.equal(foreign.status, 403);
    const approved = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(approved.status, 200);
    assert.equal(f.calls.at(-1)?.op, "readMcpResource");
    assert.equal(f.calls.at(-1)?.userId, 101);
    assert.deepEqual(f.calls.at(-1)?.args.parameters, { account_id: "phone entered" });
  } finally { await cleanup(f.server, f.dataDir); }
});

test("MCP OAuth requests require the paired device, same Origin, CSRF and an owned session", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const body = (sessionId = allowedSession) => JSON.stringify({ op: "mcpOAuthLogin", args: { sessionId, name: "fixture-mcp" } });
    const anonymous = await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: body() });
    assert.equal(anonymous.status, 401);
    const noCsrf = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: body() });
    assert.equal(noCsrf.status, 403);
    const wrongOrigin = await fetch(url, { method: "POST", headers: { origin: "https://attacker.example", cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(wrongOrigin.status, 403);
    const foreign = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body(foreignSession) });
    assert.equal(foreign.status, 403);
    assert.equal(f.calls.filter((call) => call.op === "mcpOAuthLogin").length, 0);
    const accepted = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(accepted.status, 200);
    assert.equal(f.calls.at(-1)?.op, "mcpOAuthLogin");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("MCP OAuth from an allowed remote Origin relays only its matching callback to the Codex loopback listener", async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  reservation.close();
  await once(reservation, "close");

  const remoteOrigin = `http://phone.localhost:${port}`;
  const f = await startFixture({ port, allowedOrigins: [remoteOrigin] });
  const callbackServer = createServer();
  let callbackPath = "";
  callbackServer.on("request", (req, res) => {
    const callback = new URL(req.url ?? "/", "http://127.0.0.1");
    callbackPath = req.url ?? "";
    res.statusCode = callback.searchParams.has("error") ? 400 : 200;
    res.end("private-provider-error-detail");
  });
  callbackServer.listen(0, "127.0.0.1");
  await once(callbackServer, "listening");
  const callbackAddress = callbackServer.address();
  assert.ok(callbackAddress && typeof callbackAddress !== "string");
  const redirectUri = `http://127.0.0.1:${callbackAddress.port}/callback/fixture-id`;
  const authorizationUrl = new URL("https://provider.example/authorize");
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("state", "expected-state");
  f.setMobileOAuthResult({ authorizationUrl: authorizationUrl.href });
  try {
    const login = await pair(f.origin, f.auth);
    const response = await fetch(f.origin + "/api/operations", {
      method: "POST",
      headers: {
        origin: remoteOrigin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ op: "mcpOAuthLogin", args: { sessionId: allowedSession, name: "fixture-mcp" } }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { callbackRelayAvailable?: boolean }).callbackRelayAvailable, true);
    assert.equal(f.calls.filter((call) => call.op === "mcpOAuthLogin").length, 1);

    const relay = (callbackUrl: string, headers: Record<string, string> = {}) => fetch(f.origin + "/api/mcp/oauth/callback", {
      method: "POST",
      headers: { origin: remoteOrigin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json", ...headers },
      body: JSON.stringify({ sessionId: allowedSession, name: "fixture-mcp", callbackUrl }),
    });
    const wrongState = await relay(`${redirectUri}?code=fixture-secret-code&state=wrong-state`);
    assert.equal(wrongState.status, 400);
    assert.equal(callbackPath, "");
    const wrongOrigin = await relay(`${redirectUri}?code=fixture-secret-code&state=expected-state`, { origin: "https://attacker.example" });
    assert.equal(wrongOrigin.status, 403);
    const otherLoopbackHost = await relay(`http://localhost:${callbackAddress.port}/callback/fixture-id?code=fixture-secret-code&state=expected-state`);
    assert.equal(otherLoopbackHost.status, 400);
    assert.equal(callbackPath, "");
    const missingCsrf = await relay(`${redirectUri}?code=fixture-secret-code&state=expected-state`, { "x-csrf-token": "wrong" });
    assert.equal(missingCsrf.status, 403);
    assert.equal(callbackPath, "");
    const foreign = await fetch(f.origin + "/api/mcp/oauth/callback", {
      method: "POST",
      headers: { origin: remoteOrigin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: foreignSession, name: "fixture-mcp", callbackUrl: `${redirectUri}?code=fixture-secret-code&state=expected-state` }),
    });
    assert.equal(foreign.status, 403);
    assert.equal(callbackPath, "");

    const completed = await relay(`${redirectUri}?code=fixture-secret-code&state=expected-state`);
    assert.equal(completed.status, 200);
    const completedText = await completed.text();
    assert.deepEqual(JSON.parse(completedText), { forwarded: true });
    assert.equal(callbackPath, "/callback/fixture-id?code=fixture-secret-code&state=expected-state");
    assert.doesNotMatch(completedText, /fixture-secret-code/);
    assert.equal((await relay(`${redirectUri}?code=fixture-secret-code&state=expected-state`)).status, 409);

    const secondLogin = await fetch(f.origin + "/api/operations", {
      method: "POST",
      headers: { origin: remoteOrigin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "mcpOAuthLogin", args: { sessionId: allowedSession, name: "fixture-mcp" } }),
    });
    assert.equal(secondLogin.status, 200);
    const providerError = await relay(`${redirectUri}?error=access_denied&error_description=private-provider-error-detail&state=expected-state`);
    assert.equal(providerError.status, 409);
    const providerErrorText = await providerError.text();
    assert.match(providerErrorText, /Codex отклонил callback/i);
    assert.doesNotMatch(providerErrorText, /private-provider-error-detail|access_denied|expected-state/);
  } finally {
    callbackServer.closeAllConnections();
    await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
    await cleanup(f.server, f.dataDir);
  }
});

test("MCP OAuth PAR relay remains disabled when the Codex listener cannot be inspected", async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  reservation.close();
  await once(reservation, "close");

  const remoteOrigin = `http://phone.localhost:${port}`;
  const f = await startFixture({ port, allowedOrigins: [remoteOrigin] });
  f.setMobileOAuthResult({ authorizationUrl: "https://provider.example/authorize?request_uri=opaque" });
  try {
    const login = await pair(f.origin, f.auth);
    const response = await fetch(f.origin + "/api/operations", {
      method: "POST",
      headers: { origin: remoteOrigin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "mcpOAuthLogin", args: { sessionId: allowedSession, name: "fixture-mcp" } }),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json() as { error: string }).error, /callback|возврат/i);
    assert.equal(f.calls.filter((call) => call.op === "mcpOAuthLogin").length, 1);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("MCP OAuth PAR relay accepts only a loopback listener explicitly confirmed as Codex-owned", async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  reservation.close();
  await once(reservation, "close");

  const remoteOrigin = `http://phone.localhost:${port}`;
  const callbackServer = createServer();
  let callbackPath = "";
  callbackServer.on("request", (req, res) => {
    callbackPath = req.url ?? "";
    res.statusCode = 200;
    res.end("ok");
  });
  callbackServer.listen(0, "127.0.0.1");
  await once(callbackServer, "listening");
  const callbackAddress = callbackServer.address();
  assert.ok(callbackAddress && typeof callbackAddress !== "string");
  const callbackPort = callbackAddress.port;
  const f = await startFixture({
    port,
    allowedOrigins: [remoteOrigin],
    isCodexOAuthCallbackListener: async (callback: URL) => callback.hostname === "127.0.0.1" && Number(callback.port) === callbackPort,
  });
  f.setMobileOAuthResult({ authorizationUrl: "https://provider.example/authorize?client_id=codex&request_uri=urn%3Arequest&state=expected-state" });
  try {
    const login = await pair(f.origin, f.auth);
    const headers = {
      origin: remoteOrigin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken,
      "content-type": "application/json",
    };
    const started = await fetch(f.origin + "/api/operations", {
      method: "POST", headers,
      body: JSON.stringify({ op: "mcpOAuthLogin", args: { sessionId: allowedSession, name: "fixture-mcp" } }),
    });
    assert.equal(started.status, 200);
    const startedBody = await started.json() as { callbackRelayAvailable: boolean; callbackRelayMode: string };
    assert.equal(startedBody.callbackRelayAvailable, true);
    assert.equal(startedBody.callbackRelayMode, "codex-loopback");

    const relay = (callbackUrl: string) => fetch(f.origin + "/api/mcp/oauth/callback", {
      method: "POST", headers,
      body: JSON.stringify({ sessionId: allowedSession, name: "fixture-mcp", callbackUrl }),
    });
    const wrongPort = await relay(`http://127.0.0.1:${callbackPort + 1}/callback/id?code=secret&state=expected-state`);
    assert.equal(wrongPort.status, 400);
    assert.equal(callbackPath, "");
    const wrongPath = await relay(`http://127.0.0.1:${callbackPort}/admin?code=secret&state=expected-state`);
    assert.equal(wrongPath.status, 400);
    assert.equal(callbackPath, "");
    const completed = await relay(`http://127.0.0.1:${callbackPort}/callback/id?code=secret&state=expected-state`);
    assert.equal(completed.status, 200);
    assert.deepEqual(await completed.json(), { forwarded: true });
    assert.equal(callbackPath, "/callback/id?code=secret&state=expected-state");
  } finally {
    callbackServer.closeAllConnections();
    await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
    await cleanup(f.server, f.dataDir);
  }
});

test("realtime voice start and stop require paired Origin, CSRF and ownership of the target session", async () => {
  const f = await startFixture();
  try {
    const url = f.origin + "/api/operations";
    const body = (op: "startRealtime" | "stopRealtime", sessionId = allowedSession) => JSON.stringify({
      op, args: { sessionId, ...(op === "startRealtime" ? { sdp: "v=0\\r\\nm=audio" } : {}) },
    });
    for (const op of ["startRealtime", "stopRealtime"] as const) {
      assert.equal((await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: body(op) })).status, 401);
    }
    const login = await pair(f.origin, f.auth);
    for (const op of ["startRealtime", "stopRealtime"] as const) {
      const payload = body(op);
      const noCsrf = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: payload });
      assert.equal(noCsrf.status, 403, `${op} requires CSRF`);
      const wrongOrigin = await fetch(url, { method: "POST", headers: { origin: "https://attacker.example", cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: payload });
      assert.equal(wrongOrigin.status, 403, `${op} requires an allowed Origin`);
      const foreign = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body(op, foreignSession) });
      assert.equal(foreign.status, 403, `${op} cannot target another owner's session`);
      const approved = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: payload });
      assert.equal(approved.status, 200, `${op} is accepted for the authorized session`);
      assert.equal(f.calls.at(-1)?.op, op);
    }
  } finally { await cleanup(f.server, f.dataDir); }
});

test("listing Codex realtime voice choices requires an authenticated session, allowed Origin, CSRF and session ownership", async () => {
  const f = await startFixture();
  try {
    const url = f.origin + "/api/operations";
    const body = (sessionId = allowedSession) => JSON.stringify({ op: "listRealtimeVoices", args: { sessionId } });
    assert.equal((await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: body() })).status, 401);
    const login = await pair(f.origin, f.auth);
    assert.equal((await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: body() })).status, 403);
    const foreign = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body(foreignSession) });
    assert.equal(foreign.status, 403);
    const listed = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(listed.status, 200);
    assert.equal(f.calls.at(-1)?.op, "listRealtimeVoices");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("stopping a Codex background process requires the paired device, Origin, CSRF and its owned session", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const body = (sessionId = allowedSession) => JSON.stringify({ op: "stopBackgroundTerminal", args: { sessionId, processId: "42" } });
    const anonymous = await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: body() });
    assert.equal(anonymous.status, 401);
    const noCsrf = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: body() });
    assert.equal(noCsrf.status, 403);
    const wrongOrigin = await fetch(url, { method: "POST", headers: { origin: "https://attacker.example", cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(wrongOrigin.status, 403);
    const foreign = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body(foreignSession) });
    assert.equal(foreign.status, 403);
    assert.equal(f.calls.filter((call) => call.op === "stopBackgroundTerminal").length, 0);
    const accepted = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(accepted.status, 200);
    assert.equal(f.calls.at(-1)?.op, "stopBackgroundTerminal");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("listing Codex background processes requires an authenticated device and an owned session", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const body = (sessionId = allowedSession) => JSON.stringify({ op: "listBackgroundTerminals", args: { sessionId } });
    const anonymous = await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: body() });
    assert.equal(anonymous.status, 401);
    const noCsrf = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: body() });
    assert.equal(noCsrf.status, 403);
    const foreign = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body(foreignSession) });
    assert.equal(foreign.status, 403);
    assert.equal(f.calls.filter((call) => call.op === "listBackgroundTerminals").length, 0);
    const accepted = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(accepted.status, 200);
    assert.equal(f.calls.at(-1)?.op, "listBackgroundTerminals");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("editable-turn reads and edit-and-retry are paired, session-scoped and CSRF protected", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const read = (sessionId = allowedSession) => JSON.stringify({ op: "listEditableTurns", args: { sessionId } });
    const mutation = (sessionId = allowedSession) => JSON.stringify({ op: "editAndRetry", args: {
      sessionId, turnId: "11111111-1111-4111-8111-111111111111", text: "Заменённый запрос", requestId: "mobile-edit-request-0001",
    } });

    const anonymousRead = await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: read() });
    assert.equal(anonymousRead.status, 401);
    const foreignRead = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: read(foreignSession),
    });
    assert.equal(foreignRead.status, 403);
    const allowedRead = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: read(),
    });
    assert.equal(allowedRead.status, 200);
    assert.equal((await allowedRead.json() as { op: string }).op, "listEditableTurns");

    const anonymousMutation = await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: mutation() });
    assert.equal(anonymousMutation.status, 401);
    const noCsrf = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: mutation(),
    });
    assert.equal(noCsrf.status, 403);
    const wrongOrigin = await fetch(url, {
      method: "POST", headers: { origin: "https://attacker.example", cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: mutation(),
    });
    assert.equal(wrongOrigin.status, 403);
    const foreignMutation = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: mutation(foreignSession),
    });
    assert.equal(foreignMutation.status, 403);
    assert.equal(f.calls.filter((call) => call.op === "editAndRetry").length, 0);

    const accepted = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: mutation(),
    });
    assert.equal(accepted.status, 200);
    assert.equal(f.calls.at(-1)?.op, "editAndRetry");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("worktree creation requires the paired device, same Origin, CSRF and an owned session", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const body = (sessionId = allowedSession) => JSON.stringify({ op: "createWorktree", args: { sessionId, branchName: "phone/experiment" } });
    const anonymous = await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: body() });
    assert.equal(anonymous.status, 401);
    const noCsrf = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: body() });
    assert.equal(noCsrf.status, 403);
    const foreign = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body(foreignSession) });
    assert.equal(foreign.status, 403);
    assert.equal(f.calls.filter((call) => call.op === "createWorktree").length, 0);
    const accepted = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(accepted.status, 200);
    assert.equal(f.calls.at(-1)?.op, "createWorktree");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("Git pull requires an authenticated device, exact Origin, CSRF and an owned session", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const body = (sessionId = allowedSession) => JSON.stringify({ op: "gitPull", args: { sessionId } });
    assert.equal((await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: body() })).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: body() })).status, 403);
    assert.equal((await fetch(url, { method: "POST", headers: { origin: "https://attacker.example", cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() })).status, 403);
    assert.equal((await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body(foreignSession) })).status, 403);
    assert.equal(f.calls.filter((call) => call.op === "gitPull").length, 0);
    const accepted = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(accepted.status, 200);
    assert.equal(f.calls.at(-1)?.op, "gitPull");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("native session search requires a paired device, same Origin and CSRF without requiring a selected session", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const body = JSON.stringify({ op: "searchThreads", args: { query: "older" } });
    const anonymous = await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body });
    assert.equal(anonymous.status, 401);
    const noCsrf = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body });
    assert.equal(noCsrf.status, 403);
    const wrongOrigin = await fetch(url, { method: "POST", headers: { origin: "https://attacker.example", cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body });
    assert.equal(wrongOrigin.status, 403);
    const accepted = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body });
    assert.equal(accepted.status, 200);
    assert.equal(f.calls.at(-1)?.op, "searchThreads");
    assert.deepEqual(f.calls.at(-1)?.args, { query: "older" });
  } finally { await cleanup(f.server, f.dataDir); }
});

test("full conversation search requires the paired device, same Origin, CSRF and an owned session", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const body = (sessionId = allowedSession) => JSON.stringify({ op: "searchHistory", args: { sessionId, query: "older phrase" } });
    const anonymous = await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: body() });
    assert.equal(anonymous.status, 401);
    const noCsrf = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: body() });
    assert.equal(noCsrf.status, 403);
    const wrongOrigin = await fetch(url, { method: "POST", headers: { origin: "https://attacker.example", cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(wrongOrigin.status, 403);
    const foreign = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body(foreignSession) });
    assert.equal(foreign.status, 403);
    assert.equal(f.calls.filter((call) => call.op === "searchHistory").length, 0);
    const accepted = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(accepted.status, 200);
    assert.equal(f.calls.at(-1)?.op, "searchHistory");
    assert.deepEqual(f.calls.at(-1)?.args, { sessionId: allowedSession, query: "older phrase" });
  } finally { await cleanup(f.server, f.dataDir); }
});

test("older screenshot pages require an authenticated device and an owned session", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const body = (sessionId = allowedSession) => JSON.stringify({ op: "listOlderScreenshots", args: { sessionId } });
    const anonymous = await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: body() });
    assert.equal(anonymous.status, 401);
    const noCsrf = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: body() });
    assert.equal(noCsrf.status, 403);
    const wrongOrigin = await fetch(url, { method: "POST", headers: { origin: "https://attacker.example", cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(wrongOrigin.status, 403);
    const foreign = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body(foreignSession) });
    assert.equal(foreign.status, 403);
    assert.equal(f.calls.filter((call) => call.op === "listOlderScreenshots").length, 0);
    const accepted = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(accepted.status, 200);
    assert.equal(f.calls.at(-1)?.op, "listOlderScreenshots");
    assert.deepEqual(f.calls.at(-1)?.args, { sessionId: allowedSession });
  } finally { await cleanup(f.server, f.dataDir); }
});

test("unfiltered session pages require the paired device, allowed Origin and CSRF", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const body = JSON.stringify({ op: "listMoreThreads", args: { offset: 500, archived: false } });
    const anonymous = await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body });
    assert.equal(anonymous.status, 401);
    const noCsrf = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body });
    assert.equal(noCsrf.status, 403);
    const wrongOrigin = await fetch(url, { method: "POST", headers: { origin: "https://attacker.example", cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body });
    assert.equal(wrongOrigin.status, 403);
    const accepted = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body });
    assert.equal(accepted.status, 200);
    assert.equal(f.calls.at(-1)?.op, "listMoreThreads");
    assert.deepEqual(f.calls.at(-1)?.args, { offset: 500, archived: false });
  } finally { await cleanup(f.server, f.dataDir); }
});

test("native review requires a paired device, same Origin, CSRF and an owned session", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const args = { sessionId: allowedSession, target: { type: "uncommittedChanges" }, delivery: "inline" };
    const payload = JSON.stringify({ op: "reviewThread", args });
    const anonymous = await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: payload });
    assert.equal(anonymous.status, 401);
    const noCsrf = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: payload });
    assert.equal(noCsrf.status, 403);
    const foreign = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "reviewThread", args: { ...args, sessionId: foreignSession } }),
    });
    assert.equal(foreign.status, 403);
    const accepted = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: payload,
    });
    assert.equal(accepted.status, 200);
    assert.equal(f.calls.at(-1)?.op, "reviewThread");
    assert.deepEqual(f.calls.at(-1)?.args, args);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("terminal commands require the paired device, same Origin, CSRF and an owned session", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const body = (sessionId = allowedSession) => JSON.stringify({ op: "terminalExec", args: { sessionId, command: "Write-Output fixture" } });
    const anonymous = await fetch(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: body() });
    assert.equal(anonymous.status, 401);
    const noCsrf = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: body() });
    assert.equal(noCsrf.status, 403);
    const foreign = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body(foreignSession) });
    assert.equal(foreign.status, 403);
    assert.equal(f.calls.filter((call) => call.op === "terminalExec").length, 0);
    const accepted = await fetch(url, { method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: body() });
    assert.equal(accepted.status, 200);
    assert.equal(f.calls.at(-1)?.op, "terminalExec");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("interactive terminal operations require the paired device, CSRF and an owned session", async () => {
  const f = await startFixture();
  try {
    const payload = JSON.stringify({ op: "terminalStart", args: { sessionId: allowedSession } });
    const anonymous = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: payload,
    });
    assert.equal(anonymous.status, 401);
    const login = await pair(f.origin, f.auth);
    const started = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json", "x-csrf-token": login.csrfToken }, body: payload,
    });
    assert.equal(started.status, 200);
    assert.equal((await started.json() as { op: string }).op, "terminalStart");
    assert.equal(f.calls.at(-1)?.userId, 101);
    const noCsrf = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: payload,
    });
    assert.equal(noCsrf.status, 403);
    const beforeForeign = f.calls.filter((call) => call.op.startsWith("terminal")).length;
    const foreign = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json", "x-csrf-token": login.csrfToken },
      body: JSON.stringify({ op: "terminalStart", args: { sessionId: foreignSession } }),
    });
    assert.equal(foreign.status, 403);
    assert.equal(f.calls.filter((call) => call.op.startsWith("terminal")).length, beforeForeign);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("terminal shell options require the paired device, Origin and an owned session", async () => {
  const f = await startFixture();
  try {
    const url = f.origin + "/api/operations";
    const payload = (sessionId = allowedSession) => JSON.stringify({ op: "listTerminalShells", args: { sessionId } });
    const anonymous = await fetch(url, {
      method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: payload(),
    });
    assert.equal(anonymous.status, 401);

    const login = await pair(f.origin, f.auth);
    const headers = { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" };
    const noCsrf = await fetch(url, { method: "POST", headers, body: payload() });
    assert.equal(noCsrf.status, 403);

    const beforeForeign = f.calls.length;
    const foreign = await fetch(url, {
      method: "POST", headers: { ...headers, "x-csrf-token": login.csrfToken }, body: payload(foreignSession),
    });
    assert.equal(foreign.status, 403);
    assert.equal(f.calls.length, beforeForeign, "foreign session shell options must not reach the agent");

    const accepted = await fetch(url, {
      method: "POST", headers: { ...headers, "x-csrf-token": login.csrfToken }, body: payload(),
    });
    assert.equal(accepted.status, 200);
    assert.equal(f.calls.at(-1)?.op, "listTerminalShells");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("archive, restore, rename and delete actions require a paired owner, Origin and CSRF", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const payload = (op: string, sessionId = allowedSession) => JSON.stringify({ op, args: { sessionId, name: "Renamed session" } });
    const anonymous = await fetch(url, {
      method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: payload("archiveThread"),
    });
    assert.equal(anonymous.status, 401);
    const noCsrf = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: payload("archiveThread"),
    });
    assert.equal(noCsrf.status, 403);
    const foreign = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: payload("unarchiveThread", foreignSession),
    });
    assert.equal(foreign.status, 403);
    for (const op of ["renameThread", "archiveThread", "unarchiveThread", "deleteThread"]) {
      const result = await fetch(url, {
        method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: payload(op),
      });
      assert.equal(result.status, 200);
      assert.equal(f.calls.at(-1)?.op, op);
    }
  } finally { await cleanup(f.server, f.dataDir); }
});

test("mobile approval cards are session scoped and decisions require Origin plus CSRF", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const list = await fetch(f.origin + `/api/approvals?sessionId=${allowedSession}`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(list.status, 200);
    assert.equal((await list.json() as { approvals: Array<{ id: string }> }).approvals[0]?.id, f.approvalId);
    const foreign = await fetch(f.origin + `/api/approvals?sessionId=${foreignSession}`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(foreign.status, 403);
    const payload = JSON.stringify({ sessionId: allowedSession, optionId: "accept" });
    const noCsrf = await fetch(f.origin + `/api/approvals/${f.approvalId}`, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: payload,
    });
    assert.equal(noCsrf.status, 403);
    const decision = await fetch(f.origin + `/api/approvals/${f.approvalId}`, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: payload,
    });
    assert.equal(decision.status, 200);
    assert.deepEqual(f.approvalDecisions, [{ ownerId: 101, sessionId: allowedSession, id: f.approvalId, optionId: "accept" }]);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("MCP elicitation forms require the paired owner, session, Origin and CSRF", async () => {
  const decisions: Array<{ ownerId: number; sessionId: string; id: string; action: string; content?: unknown }> = [];
  const elicitation = {
    id: "55555555-5555-4555-8555-555555555555", serverName: "fixture-account", message: "Enter account id",
    mode: "form", fields: [{ name: "account_id", label: "Account id", type: "string", required: true }],
  };
  const f = await startFixture({
    elicitations: {
      listFor(ownerId: number, sessionId: string) { return ownerId === 101 && sessionId === allowedSession ? [elicitation] : []; },
      resolve(ownerId: number, sessionId: string, id: string, action: string, content: unknown) {
        if (ownerId !== 101 || sessionId !== allowedSession || id !== elicitation.id) return false;
        decisions.push({ ownerId, sessionId, id, action, ...(content !== undefined ? { content } : {}) });
        return true;
      },
    },
  });
  try {
    const login = await pair(f.origin, f.auth);
    const list = await fetch(f.origin + `/api/elicitations?sessionId=${allowedSession}`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json() as { elicitations: unknown[] }).elicitations, [elicitation]);

    const foreign = await fetch(f.origin + `/api/elicitations?sessionId=${foreignSession}`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(foreign.status, 403);
    const payload = JSON.stringify({ sessionId: allowedSession, action: "accept", content: { account_id: "customer-7" } });
    const noCsrf = await fetch(f.origin + `/api/elicitations/${elicitation.id}`, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: payload,
    });
    assert.equal(noCsrf.status, 403);
    const answer = await fetch(f.origin + `/api/elicitations/${elicitation.id}`, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: payload,
    });
    assert.equal(answer.status, 200);
    assert.deepEqual(decisions, [{ ownerId: 101, sessionId: allowedSession, id: elicitation.id, action: "accept", content: { account_id: "customer-7" } }]);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("project file reads and writes use the authorized session and write CSRF checks", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const files = await fetch(f.origin + `/api/files?sessionId=${allowedSession}&path=src`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(files.status, 200);
    assert.equal((await files.json() as { op: string }).op, "files");
    const foreign = await fetch(f.origin + `/api/file?sessionId=${foreignSession}&path=private.txt`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(foreign.status, 403);
    const payload = JSON.stringify({ op: "writeFile", args: { sessionId: allowedSession, path: "src/main.ts", content: "new", expectedHash: "0".repeat(64) } });
    const noCsrf = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: payload,
    });
    assert.equal(noCsrf.status, 403);
    const write = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: payload,
    });
    assert.equal(write.status, 200);
    assert.equal((await write.json() as { ok: boolean }).ok, true);
    assert.equal(f.calls.at(-1)?.op, "writeFile");
    const createPayload = JSON.stringify({ op: "createFile", args: { sessionId: allowedSession, path: "src/new.ts", content: "" } });
    const noCreateCsrf = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: createPayload,
    });
    assert.equal(noCreateCsrf.status, 403);
    const foreignCreate = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "createFile", args: { sessionId: foreignSession, path: "new.ts", content: "" } }),
    });
    assert.equal(foreignCreate.status, 403);
    const create = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: createPayload,
    });
    assert.equal(create.status, 200);
    assert.equal(f.calls.at(-1)?.op, "createFile");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("project downloads require an authenticated device and an owned session, and return safe attachment headers", async () => {
  const f = await startFixture();
  try {
    const url = (sessionId: string) => f.origin + `/api/file-download?sessionId=${sessionId}&path=assets%2Frelease.zip`;
    const anonymous = await fetch(url(allowedSession));
    assert.equal(anonymous.status, 401);
    const login = await pair(f.origin, f.auth);
    const beforeForeign = f.calls.filter((call) => call.op === "downloadFile").length;
    const foreign = await fetch(url(foreignSession), { headers: { origin: f.origin, cookie: login.sessionCookie } });
    assert.equal(foreign.status, 403);
    assert.equal(f.calls.filter((call) => call.op === "downloadFile").length, beforeForeign);

    const downloaded = await fetch(url(allowedSession), { headers: { origin: f.origin, cookie: login.sessionCookie } });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-type"), "application/octet-stream");
    assert.match(downloaded.headers.get("content-disposition") ?? "", /attachment; filename="release\.zip"/);
    assert.equal(downloaded.headers.get("x-content-type-options"), "nosniff");
    assert.equal(downloaded.headers.get("cache-control"), "no-store");
    assert.deepEqual([...new Uint8Array(await downloaded.arrayBuffer())], [0x50, 0x4b, 0x03, 0x04]);
    assert.equal(f.calls.at(-1)?.op, "downloadFile");

    f.setDownloadValue({ name: 'bad"name\r\nX-Evil: yes.zip', size: 4, bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]) });
    const unsafeName = await fetch(url(allowedSession), { headers: { origin: f.origin, cookie: login.sessionCookie } });
    const disposition = unsafeName.headers.get("content-disposition") ?? "";
    assert.equal(unsafeName.status, 200);
    assert.equal(disposition.includes("\r"), false);
    assert.equal(disposition.includes("\n"), false);
    assert.match(disposition, /filename\*=UTF-8''/);

    f.setDownloadValue({ name: "release.zip", size: 4, bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]) });
    f.failNext();
    const codexFailure = await fetch(url(allowedSession), { headers: { origin: f.origin, cookie: login.sessionCookie } });
    assert.equal(codexFailure.status, 502);
    assert.deepEqual(await codexFailure.json(), { error: "Не удалось скачать файл из проекта" });
  } finally { await cleanup(f.server, f.dataDir); }
});

test("project folder listing pages carry a validated offset to the existing agent", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + `/api/files?sessionId=${allowedSession}&path=src&offset=250`;
    const page = await fetch(url, { headers: { origin: f.origin, cookie: login.sessionCookie } });
    assert.equal(page.status, 200);
    assert.deepEqual(await page.json(), {
      project: "fixture", path: "src", entries: [{ name: "file-250.txt", kind: "file", size: 10, mtimeMs: 1 }], total: 260, nextOffset: 251,
    });
    assert.equal(f.calls.at(-1)?.op, "files");
    assert.equal(f.calls.at(-1)?.args.offset, 250);

    const invalid = await fetch(f.origin + `/api/files?sessionId=${allowedSession}&offset=1.5`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(invalid.status, 400);
    assert.equal(f.calls.at(-1)?.args.offset, 250, "invalid page offsets must not reach the Codex agent");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("project directory creation requires a paired device, CSRF and an owned session", async () => {
  const f = await startFixture();
  try {
    const payload = JSON.stringify({ op: "createDirectory", args: { sessionId: allowedSession, path: "src/new-folder" } });
    const unauthenticated = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: payload,
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(f.calls.length, 0);
    const login = await pair(f.origin, f.auth);
    const noCsrf = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: payload,
    });
    assert.equal(noCsrf.status, 403);
    const foreign = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "createDirectory", args: { sessionId: foreignSession, path: "new-folder" } }),
    });
    assert.equal(foreign.status, 403);
    assert.equal(f.calls.length, 0);
    const created = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: payload,
    });
    assert.equal(created.status, 200);
    assert.equal(f.calls.at(-1)?.op, "createDirectory");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("project rename and deletion are paired, CSRF protected and session scoped", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    for (const op of ["renameProjectEntry", "deleteProjectEntry"] as const) {
      const args = { sessionId: allowedSession, path: "src/main.ts", expectedKind: "file", expectedSize: 20, expectedMtimeMs: 1, ...(op === "renameProjectEntry" ? { newName: "mobile.ts" } : {}) };
      const payload = JSON.stringify({ op, args });
      const unauthenticated = await fetch(f.origin + "/api/operations", {
        method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: payload,
      });
      assert.equal(unauthenticated.status, 401);
      const noCsrf = await fetch(f.origin + "/api/operations", {
        method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: payload,
      });
      assert.equal(noCsrf.status, 403);
      const foreign = await fetch(f.origin + "/api/operations", {
        method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ op, args: { ...args, sessionId: foreignSession } }),
      });
      assert.equal(foreign.status, 403);
      const authorized = await fetch(f.origin + "/api/operations", {
        method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: payload,
      });
      assert.equal(authorized.status, 200);
      assert.equal(f.calls.at(-1)?.op, op);
    }
  } finally { await cleanup(f.server, f.dataDir); }
});

test("Git conflict-stage reads require a paired device and an owned session", async () => {
  const f = await startFixture();
  try {
    const path = encodeURIComponent("src/conflict.ts");
    const unauthenticated = await fetch(f.origin + `/api/git/conflict-stages?sessionId=${allowedSession}&path=${path}`);
    assert.equal(unauthenticated.status, 401);
    assert.equal(f.calls.length, 0);

    const login = await pair(f.origin, f.auth);
    const stages = await fetch(f.origin + `/api/git/conflict-stages?sessionId=${allowedSession}&path=${path}`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(stages.status, 200);
    assert.equal((await stages.json() as { op: string }).op, "gitConflictStages");
    assert.deepEqual(f.calls.at(-1), { op: "gitConflictStages", userId: 101, args: { sessionId: allowedSession, path: "src/conflict.ts" } });

    const foreign = await fetch(f.origin + `/api/git/conflict-stages?sessionId=${foreignSession}&path=${path}`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(foreign.status, 403);
    assert.equal(f.calls.length, 1);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("binary conflict resolution requires paired-device CSRF and an owned session", async () => {
  const f = await startFixture();
  try {
    const payload = JSON.stringify({ op: "gitResolveConflictStage", args: { sessionId: allowedSession, path: "assets/icon.bin", stage: "theirs", expectedHash: "a".repeat(64) } });
    const unauthenticated = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: payload,
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(f.calls.length, 0);

    const login = await pair(f.origin, f.auth);
    const noCsrf = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: payload,
    });
    assert.equal(noCsrf.status, 403);
    const foreign = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "gitResolveConflictStage", args: { sessionId: foreignSession, path: "assets/icon.bin", stage: "theirs", expectedHash: "a".repeat(64) } }),
    });
    assert.equal(foreign.status, 403);
    assert.equal(f.calls.length, 0);
    const authorized = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: payload,
    });
    assert.equal(authorized.status, 200);
    assert.equal(f.calls.at(-1)?.op, "gitResolveConflictStage");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("Git status and diffs are exposed only for the paired owner's session", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const status = await fetch(f.origin + `/api/git/status?sessionId=${allowedSession}`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { op: string }).op, "gitStatus");
    const writePayload = JSON.stringify({ op: "gitStage", args: { sessionId: allowedSession, path: "src/main.ts" } });
    const noCsrf = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: writePayload,
    });
    assert.equal(noCsrf.status, 403);
    const foreignWrite = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "gitStage", args: { sessionId: foreignSession, path: "private.txt" } }),
    });
    assert.equal(foreignWrite.status, 403);
    const stage = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: writePayload,
    });
    assert.equal(stage.status, 200);
    assert.equal(f.calls.at(-1)?.op, "gitStage");
    const switchPayload = JSON.stringify({ op: "gitSwitchBranch", args: { sessionId: allowedSession, name: "release/candidate" } });
    const switchNoCsrf = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: switchPayload,
    });
    assert.equal(switchNoCsrf.status, 403);
    const switchForeign = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "gitSwitchBranch", args: { sessionId: foreignSession, name: "release/candidate" } }),
    });
    assert.equal(switchForeign.status, 403);
    const switchAllowed = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: switchPayload,
    });
    assert.equal(switchAllowed.status, 200);
    assert.equal(f.calls.at(-1)?.op, "gitSwitchBranch");
    const trackPayload = JSON.stringify({ op: "gitTrackRemoteBranch", args: { sessionId: allowedSession, remoteBranch: "origin/feature/mobile" } });
    const trackNoCsrf = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: trackPayload,
    });
    assert.equal(trackNoCsrf.status, 403);
    const trackForeign = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "gitTrackRemoteBranch", args: { sessionId: foreignSession, remoteBranch: "origin/feature/mobile" } }),
    });
    assert.equal(trackForeign.status, 403);
    const trackAllowed = await fetch(f.origin + "/api/operations", {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: trackPayload,
    });
    assert.equal(trackAllowed.status, 200);
    assert.equal(f.calls.at(-1)?.op, "gitTrackRemoteBranch");
    for (const op of ["gitFetch", "gitPush"] as const) {
      const remotePayload = JSON.stringify({ op, args: { sessionId: allowedSession, remoteName: "origin" } });
      const remoteNoCsrf = await fetch(f.origin + "/api/operations", {
        method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: remotePayload,
      });
      assert.equal(remoteNoCsrf.status, 403, `${op} requires CSRF`);
      const remoteWrongOrigin = await fetch(f.origin + "/api/operations", {
        method: "POST", headers: { origin: "https://attacker.example", cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: remotePayload,
      });
      assert.equal(remoteWrongOrigin.status, 403, `${op} requires the allowed Origin`);
      const remoteForeign = await fetch(f.origin + "/api/operations", {
        method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ op, args: { sessionId: foreignSession, remoteName: "origin" } }),
      });
      assert.equal(remoteForeign.status, 403, `${op} cannot target another owner's session`);
      const remoteAllowed = await fetch(f.origin + "/api/operations", {
        method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: remotePayload,
      });
      assert.equal(remoteAllowed.status, 200, `${op} is accepted for the authorized session`);
      assert.equal(f.calls.at(-1)?.op, op);
    }
    const fileDiff = await fetch(f.origin + `/api/git/diff?sessionId=${allowedSession}&path=src%2Fmain.ts&previousPath=src%2Fold-main.ts`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(fileDiff.status, 200);
    assert.equal(f.calls.at(-1)?.op, "gitDiff");
    assert.equal(f.calls.at(-1)?.args.path, "src/main.ts");
    assert.equal(f.calls.at(-1)?.args.previousPath, "src/old-main.ts");
    const diffCallsBeforeForeignRead = f.calls.filter((call) => call.op === "gitDiff").length;
    const diff = await fetch(f.origin + `/api/git/diff?sessionId=${foreignSession}`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(diff.status, 403);
    assert.equal(f.calls.filter((call) => call.op === "gitDiff").length, diffCallsBeforeForeignRead);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("screenshots are served only for an authorized session with an image content type", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const image = await fetch(f.origin + `/api/image?sessionId=${allowedSession}&path=${encodeURIComponent("C:\\work\\demo\\screen.png")}`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [137, 80, 78, 71, 13, 10, 26, 10]);
    const foreign = await fetch(f.origin + `/api/image?sessionId=${foreignSession}&path=x`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(foreign.status, 403);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("project image previews require an authorized session and return raster bytes", async () => {
  const f = await startFixture();
  try {
    const anonymous = await fetch(f.origin + `/api/project-image?sessionId=${allowedSession}&path=assets%2Fpixel.png`);
    assert.equal(anonymous.status, 401);
    const login = await pair(f.origin, f.auth);
    const beforeForeign = f.calls.filter((call) => call.op === "readImage").length;
    const foreign = await fetch(f.origin + `/api/project-image?sessionId=${foreignSession}&path=assets%2Fpixel.png`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(foreign.status, 403);
    assert.equal(f.calls.filter((call) => call.op === "readImage").length, beforeForeign);
    const image = await fetch(f.origin + `/api/project-image?sessionId=${allowedSession}&path=assets%2Fpixel.png`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(f.calls.at(-1)?.op, "readImage");
    f.setReadImageValue({ mime: "image/svg+xml", data: Buffer.from("<svg onload=alert(1) />").toString("base64") });
    const activeContent = await fetch(f.origin + `/api/project-image?sessionId=${allowedSession}&path=assets%2Fpixel.png`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(activeContent.status, 415);
    assert.notEqual(activeContent.headers.get("content-type"), "image/svg+xml");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("foreign session identifiers are denied before history reaches the existing agent", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const response = await fetch(f.origin + `/api/history/${foreignSession}`, {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(response.status, 403);
    assert.equal(f.calls.some((call) => call.op === "history"), false);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("section inventory is authenticated and section changes require Origin, CSRF and owned sessions", async () => {
  const f = await startFixture();
  try {
    const url = f.origin + "/api/operations";
    const anonymous = await fetch(url, {
      method: "POST", headers: { origin: f.origin, "content-type": "application/json" },
      body: JSON.stringify({ op: "listThreadSections", args: {} }),
    });
    assert.equal(anonymous.status, 401);

    const login = await pair(f.origin, f.auth);
    const list = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "listThreadSections", args: {} }),
    });
    assert.equal(list.status, 200);
    assert.equal((await list.json() as { op: string }).op, "listThreadSections");

    const createPayload = JSON.stringify({ op: "createThreadSection", args: { name: "На проверку" } });
    const noCsrf = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: createPayload,
    });
    assert.equal(noCsrf.status, 403);
    const badOrigin = await fetch(url, {
      method: "POST", headers: { origin: "https://attacker.invalid", cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: createPayload,
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(f.calls.some((call) => call.op === "createThreadSection"), false);

    const created = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" }, body: createPayload,
    });
    assert.equal(created.status, 200);
    assert.equal(f.calls.at(-1)?.op, "createThreadSection");
    assert.equal(f.calls.at(-1)?.userId, 101);
    assert.equal(f.calls.at(-1)?.args.sessionId, undefined);

    const beforeMove = f.calls.filter((call) => call.op === "moveThreadToSection").length;
    const foreignMove = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "moveThreadToSection", args: { sessionId: foreignSession, sectionId: "section-1" } }),
    });
    assert.equal(foreignMove.status, 403);
    assert.equal(f.calls.filter((call) => call.op === "moveThreadToSection").length, beforeMove);
    const ownedMove = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ op: "moveThreadToSection", args: { sessionId: allowedSession, sectionId: "section-1" } }),
    });
    assert.equal(ownedMove.status, 200);
    assert.equal(f.calls.at(-1)?.op, "moveThreadToSection");
    assert.equal(f.calls.at(-1)?.args.sessionId, allowedSession);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("mutations require both an allowed Origin and the device CSRF token", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const url = f.origin + "/api/operations";
    const payload = JSON.stringify({ op: "send", args: { sessionId: allowedSession, text: "hello" } });
    const badOrigin = await fetch(url, {
      method: "POST", headers: { origin: "https://attacker.invalid", cookie: login.sessionCookie, "content-type": "application/json", "x-csrf-token": login.csrfToken }, body: payload,
    });
    assert.equal(badOrigin.status, 403);
    const noCsrf = await fetch(url, {
      method: "POST", headers: { origin: f.origin, cookie: login.sessionCookie, "content-type": "application/json" }, body: payload,
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(f.calls.some((call) => call.op === "send"), false);
  } finally { await cleanup(f.server, f.dataDir); }
});

test("authenticated event stream resumes its cursor and closes when the client disconnects", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    const controller = new AbortController();
    const response = await fetch(f.origin + "/api/events", {
      method: "POST", signal: controller.signal,
      headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: allowedSession, after: 7, epoch: f.feed.epoch }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /event: hello/);
    assert.deepEqual(f.feed.cursors, [7]);
    await reader.cancel();
    controller.abort();
  } finally { await cleanup(f.server, f.dataDir); }
});

test("mobile event stream sends replay gaps as sync_required events", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    f.feed.replay.push({ id: 8, sessionId: allowedSession, kind: "sync", at: 1 });
    const controller = new AbortController();
    const response = await fetch(f.origin + "/api/events", {
      method: "POST", signal: controller.signal,
      headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: allowedSession, after: 7, epoch: f.feed.epoch }),
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    let frame = "";
    for (let index = 0; index < 4 && !frame.includes("event: sync_required"); index++) {
      const part = await reader.read();
      if (part.done) break;
      frame += new TextDecoder().decode(part.value);
    }
    assert.match(frame, /id: 8\nevent: sync_required\ndata: \{\}/);
    assert.doesNotMatch(frame, /"kind":"sync"/, "the client needs the named recovery event, not an ordinary rejected event");
    await reader.cancel();
    controller.abort();
  } finally { await cleanup(f.server, f.dataDir); }
});

test("event stream closes cleanly when replay hits response backpressure", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    f.feed.replay.push(...Array.from({ length: 160 }, (_, index) => ({
      id: index + 1, sessionId: allowedSession, kind: "text" as const, text: "x".repeat(4096), at: index + 1,
    })));
    const response = await fetch(f.origin + "/api/events", {
      method: "POST",
      headers: { origin: f.origin, cookie: login.sessionCookie, "x-csrf-token": login.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: allowedSession, after: 0, epoch: f.feed.epoch }),
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    let bytes = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
    }
    assert.ok(bytes > 0, "the replay should deliver buffered events before reconnecting");
  } finally { await cleanup(f.server, f.dataDir); }
});

test("Codex failures remain visible as a controlled service error", async () => {
  const f = await startFixture();
  try {
    const login = await pair(f.origin, f.auth);
    f.failNext();
    const response = await fetch(f.origin + "/api/snapshot", {
      headers: { origin: f.origin, cookie: login.sessionCookie },
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json() as { error: string }).error, "Codex runtime unavailable");
  } finally { await cleanup(f.server, f.dataDir); }
});
