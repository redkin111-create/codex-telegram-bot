import assert from "node:assert/strict";
import test from "node:test";
import { MobileAccountController } from "../src/mobile/accounts.js";

const ownerId = 101;

function fixture(options: { busy?: boolean; queue?: boolean; loggedIn?: boolean } = {}) {
  const accounts = [
    { id: "account-personal-1", label: "Личный", email: "personal@example.test", accountType: "Plus", key: "secret-fingerprint", savedAt: "2026-10-18T00:00:00.000Z" },
    { id: "account-work-001", label: "Работа", email: "work@example.test", accountType: "Team", key: "other-fingerprint", savedAt: "2026-10-17T00:00:00.000Z" },
  ];
  let activeEmail = "personal@example.test";
  let loggedIn = options.loggedIn ?? true;
  let autoRotate = false;
  const calls: string[] = [];
  let busy = options.busy ?? false;
  let queue = options.queue ?? false;
  const accountManager = {
    list: () => [...accounts],
    get: (id: string) => accounts.find((account) => account.id === id),
    matchActive: (key?: string) => accounts.find((account) => account.email === key || account.key === key),
    autoRotateEnabled: () => autoRotate,
    setAutoRotate: (enabled?: boolean) => (autoRotate = enabled ?? !autoRotate),
    async captureCurrent() { calls.push("capture"); return accounts[0]!; },
    rename(id: string, label: string) { const account = accounts.find((entry) => entry.id === id); if (account) account.label = label; return account; },
    async forget(id: string) { const index = accounts.findIndex((entry) => entry.id === id); if (index < 0) return false; accounts.splice(index, 1); return true; },
  };
  const controller = new MobileAccountController({
    allowedOwners: new Set([String(ownerId)]),
    accounts: accountManager as never,
    usage: {
      async account() { return { email: activeEmail, accountType: "Plus", key: activeEmail === "personal@example.test" ? "personal@example.test" : "work@example.test" }; },
      async isLoggedIn() { return loggedIn; },
    } as never,
    rotator: {
      async runExclusive(id: string, operation: () => Promise<unknown>) {
        calls.push(`switch:${id}`);
        activeEmail = id === "account-work-001" ? "work@example.test" : "personal@example.test";
        loggedIn = true;
        return operation();
      },
    } as never,
    acp: { hasInflightPrompt: () => busy } as never,
    registry: { hasPendingWork: () => queue } as never,
  });
  return {
    controller,
    accounts,
    calls,
    setBusy(value: boolean) { busy = value; },
    setQueue(value: boolean) { queue = value; },
    setLoggedIn(value: boolean) { loggedIn = value; },
  };
}

test("mobile account snapshot is owner checked and never returns credential fingerprints", async () => {
  const f = fixture();
  const snapshot = await f.controller.snapshot(ownerId);
  assert.equal(snapshot.activeAccountId, "account-personal-1");
  assert.equal(snapshot.accounts[0]?.active, true);
  assert.equal(JSON.stringify(snapshot).includes("secret-fingerprint"), false);
  await assert.rejects(() => f.controller.snapshot(202), /Доступ к аккаунтам запрещён/);
});

test("mobile account labels and auto-rotate can be changed without exposing auth data", async () => {
  const f = fixture();
  const renamed = await f.controller.execute(ownerId, { action: "rename", id: "account-personal-1", label: "Основной" });
  assert.equal(renamed.snapshot.accounts[0]?.label, "Основной");
  const toggled = await f.controller.execute(ownerId, { action: "setAutoRotate", enabled: true });
  assert.equal(toggled.snapshot.autoRotate, true);
});

test("mobile account switch saves the current login, uses the shared rotator and reports live state", async () => {
  const f = fixture();
  const result = await f.controller.execute(ownerId, { action: "switch", id: "account-work-001" });
  assert.deepEqual(f.calls, ["capture", "switch:account-work-001"]);
  assert.equal(result.snapshot.activeAccountId, "account-work-001");
  assert.equal(result.snapshot.loggedIn, true);
});

test("mobile account switch is blocked while a turn or queued prompt could be interrupted", async () => {
  const active = fixture({ busy: true });
  await assert.rejects(() => active.controller.execute(ownerId, { action: "switch", id: "account-work-001" }), /Codex занят/);
  assert.deepEqual(active.calls, []);

  const queued = fixture({ queue: true });
  await assert.rejects(() => queued.controller.execute(ownerId, { action: "switch", id: "account-work-001" }), /ожидающие запросы/);
  assert.deepEqual(queued.calls, []);
});

test("mobile account actions validate ids and labels and refuse saving without a login", async () => {
  const f = fixture();
  await assert.rejects(() => f.controller.execute(ownerId, { action: "rename", id: "../../auth", label: "bad" }), /ID аккаунта/);
  await assert.rejects(() => f.controller.execute(ownerId, { action: "rename", id: "account-work-001", label: "  " }), /Название/);
  f.setLoggedIn(false);
  await assert.rejects(() => f.controller.execute(ownerId, { action: "saveCurrent" }), /нет активного входа/);
});
