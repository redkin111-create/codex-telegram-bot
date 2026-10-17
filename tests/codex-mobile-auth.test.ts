import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MobileAuthStore } from "../src/mobile/auth.js";

async function withStore(run: (store: MobileAuthStore, dataDir: string) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-mobile-auth-"));
  try {
    await run(new MobileAuthStore(dataDir, { allowedOwners: new Set(["101", "202"]) }), dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("CLI-approved pairing creates a browser session without Telegram initData", async () => {
  await withStore(async (auth) => {
    const challenge = auth.beginPairing("Pixel 7");
    assert.match(challenge.code, /^[A-Z2-9]{10}$/);
    assert.equal(auth.approvePairing(challenge.code, 101), true);

    const result = auth.completePairing(challenge.pairingCookie);
    assert.equal(result?.status, "approved");
    if (result?.status !== "approved") return;
    assert.equal(result.device.name, "Pixel 7");
    assert.equal(auth.authenticate(result.cookieValue)?.ownerId, 101);
    assert.equal(auth.verifyCsrf(result.device.id, result.csrfToken), true);
    assert.equal(auth.completePairing(challenge.pairingCookie), undefined, "approval is delivered once");
  });
});

test("pairing rejects owners outside the existing allowlist", async () => {
  await withStore(async (auth) => {
    const challenge = auth.beginPairing("Unpaired phone");
    assert.throws(() => auth.approvePairing(challenge.code, 303), /owner/i);
    assert.equal(auth.completePairing(challenge.pairingCookie)?.status, "pending");
  });
});

test("pairing code expires and cannot be approved after its deadline", async () => {
  let now = 1_800_000_000_000;
  const dataDir = await mkdtemp(join(tmpdir(), "codex-mobile-expiry-"));
  try {
    const auth = new MobileAuthStore(dataDir, { allowedOwners: new Set(["101"]), now: () => now, pairingTtlMs: 100 });
    const challenge = auth.beginPairing("Pixel 7");
    now += 101;
    assert.equal(auth.approvePairing(challenge.code, 101), false);
    assert.equal(auth.completePairing(challenge.pairingCookie), undefined);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("revoking a device immediately removes its cookie and CSRF authority", async () => {
  await withStore(async (auth) => {
    const challenge = auth.beginPairing("Pixel 7");
    auth.approvePairing(challenge.code, 101);
    const login = auth.completePairing(challenge.pairingCookie);
    assert.equal(login?.status, "approved");
    if (login?.status !== "approved") return;

    assert.equal(auth.revokeDevice(101, login.device.id), true);
    assert.equal(auth.authenticate(login.cookieValue), undefined);
    assert.equal(auth.verifyCsrf(login.device.id, login.csrfToken), false);
    assert.equal(auth.revokeDevice(202, login.device.id), false);
  });
});

test("device persistence stores only hashes of browser and CSRF secrets", async () => {
  await withStore(async (auth, dataDir) => {
    const challenge = auth.beginPairing("Pixel 7");
    auth.approvePairing(challenge.code, 101);
    const login = auth.completePairing(challenge.pairingCookie);
    assert.equal(login?.status, "approved");
    if (login?.status !== "approved") return;
    const contents = await readFile(join(dataDir, "mobile-devices.json"), "utf8");
    assert.equal(contents.includes(login.cookieValue), false);
    assert.equal(contents.includes(login.csrfToken), false);
    assert.equal(contents.includes(challenge.pairingCookie), false);
  });
});
