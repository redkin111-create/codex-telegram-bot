import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveMobilePairing, getOrCreateMobileAdminToken } from "../src/mobile/control.js";

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

test("Windows CLI approval sends the code only to the loopback service using its local token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-mobile-cli-"));
  const token = await getOrCreateMobileAdminToken(dir);
  let seenAuthorization = "";
  let seenBody: unknown;
  const server = createServer(async (req, res) => {
    seenAuthorization = String(req.headers.authorization ?? "");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    seenBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ approved: true }));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await approveMobilePairing({ code: "ABCD234567", ownerId: 101, dataDir: dir, port: address.port });
    assert.equal(seenAuthorization, `Bearer ${token}`);
    assert.deepEqual(seenBody, { code: "ABCD234567", ownerId: 101 });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
