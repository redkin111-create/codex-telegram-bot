import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MobileAuthStore } from "../src/mobile/auth.js";
import { getOrCreateMobileAdminToken, startMobileControlChannel } from "../src/mobile/control.js";

test("codex-tg mobile approve uses the local IPC key and only an allowlisted owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-mobile-cli-command-"));
  const dataDir = join(dir, "data");
  const auth = new MobileAuthStore(dataDir, { allowedOwners: new Set(["101"]) });
  const token = await getOrCreateMobileAdminToken(dataDir);
  const challenge = auth.beginPairing("Pixel CLI test");
  const control = await startMobileControlChannel({ auth, dataDir, adminToken: token });
  try {
    const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), "mobile", "approve", challenge.code, "101"], {
      cwd: process.cwd(),
      env: { ...process.env, CODEX_TG_DIR: dir, DATA_DIR: dataDir, TELEGRAM_BOT_TOKEN: "12345:test-token", ALLOWED_USERS: "101" },
      windowsHide: true,
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    const [code] = await once(child, "exit") as [number | null];
    assert.equal(code, 0, output);
    assert.match(output, /подтвержден/i);
    assert.equal(auth.completePairing(challenge.pairingCookie)?.status, "approved");
  } finally {
    await control.close();
    await rm(dir, { recursive: true, force: true });
  }
});
