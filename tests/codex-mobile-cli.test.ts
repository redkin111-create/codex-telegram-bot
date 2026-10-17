import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateMobileAdminToken } from "../src/mobile/control.js";

test("codex-tg mobile approve uses the local CLI key and only an allowlisted owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-mobile-cli-command-"));
  const dataDir = join(dir, "data");
  const token = await getOrCreateMobileAdminToken(dataDir);
  let receivedAuthorization = "";
  let receivedBody: unknown;
  const server = createServer(async (req, res) => {
    receivedAuthorization = String(req.headers.authorization ?? "");
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    receivedBody = JSON.parse(Buffer.concat(parts).toString("utf8"));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ approved: true }));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), "mobile", "approve", "ABCD234567", "101"], {
      cwd: process.cwd(),
      env: { ...process.env, CODEX_TG_DIR: dir, DATA_DIR: dataDir, CODEX_MOBILE_PORT: String(address.port), TELEGRAM_BOT_TOKEN: "12345:test-token", ALLOWED_USERS: "101" },
      windowsHide: true,
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    const [code] = await once(child, "exit") as [number | null];
    assert.equal(code, 0, output);
    assert.match(output, /approved|подтвержден/i);
    assert.equal(receivedAuthorization, `Bearer ${token}`);
    assert.deepEqual(receivedBody, { code: "ABCD234567", ownerId: 101 });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
