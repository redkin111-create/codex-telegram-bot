import assert from "node:assert/strict";
import { createConnection } from "node:net";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MobileAuthStore } from "../src/mobile/auth.js";
import {
  approveMobilePairing,
  getOrCreateMobileAdminToken,
  mobileControlAddress,
  startMobileControlChannel,
} from "../src/mobile/control.js";

test("mobile admin token is generated once and kept out of the repository data format", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-mobile-control-"));
  try {
    const first = await getOrCreateMobileAdminToken(dir);
    const second = await getOrCreateMobileAdminToken(dir);
    assert.match(first, /^[A-Za-z0-9_-]{40,60}$/);
    assert.equal(first, second);
    assert.equal(await readFile(join(dir, "mobile-admin-token"), "utf8"), first);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Windows CLI approval uses a separate local IPC channel and completes pairing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-mobile-cli-"));
  const auth = new MobileAuthStore(dir, { allowedOwners: new Set(["101"]) });
  const adminToken = await getOrCreateMobileAdminToken(dir);
  const challenge = auth.beginPairing("Pixel fixture");
  const control = await startMobileControlChannel({ auth, dataDir: dir, adminToken });
  try {
    assert.equal(control.address, mobileControlAddress(dir));
    await approveMobilePairing({ code: challenge.code, ownerId: 101, dataDir: dir });
    const login = auth.completePairing(challenge.pairingCookie);
    assert.equal(login?.status, "approved");
  } finally {
    await control.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("local IPC refuses approval requests without the stored local token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-mobile-ipc-auth-"));
  const auth = new MobileAuthStore(dir, { allowedOwners: new Set(["101"]) });
  const challenge = auth.beginPairing("Untrusted local client");
  const control = await startMobileControlChannel({ auth, dataDir: dir, adminToken: "expected-control-token" });
  try {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(mobileControlAddress(dir));
      let body = "";
      socket.once("connect", () => socket.end(JSON.stringify({ token: "wrong-token", code: challenge.code, ownerId: 101 }) + "\n"));
      socket.on("data", (chunk) => { body += chunk.toString("utf8"); });
      socket.once("end", () => resolve(body));
      socket.once("error", reject);
    });
    assert.deepEqual(JSON.parse(response), { status: 401, message: "Локальный ключ Codex Mobile не принят" });
    assert.equal(auth.completePairing(challenge.pairingCookie)?.status, "pending");
  } finally {
    await control.close();
    await rm(dir, { recursive: true, force: true });
  }
});
