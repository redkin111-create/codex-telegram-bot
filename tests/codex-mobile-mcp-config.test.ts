import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMobileMcpConfig, restartMobileCodex, setMobileMcpConfigEnabled } from "../src/mobile/mcp-config.js";

function withConfigFixture(run: (paths: { root: string; global: string; workspace: string }) => void | Promise<void>) {
  const previous = process.env.CODEX_HOME;
  const root = mkdtempSync(join(tmpdir(), "codex-mobile-mcp-"));
  const codexHome = join(root, "codex-home");
  const project = join(root, "project");
  mkdirSync(codexHome);
  mkdirSync(project);
  process.env.CODEX_HOME = codexHome;
  const paths = { root: project, global: join(codexHome, "config.toml"), workspace: join(project, ".codex", "config.toml") };
  return Promise.resolve(run(paths)).finally(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
}

test("mobile MCP inventory exposes only safe fields and workspace entries shadow global ones", async () => {
  await withConfigFixture(({ root, global, workspace }) => {
    mkdirSync(join(root, ".codex"));
    writeFileSync(global, `[mcp_servers.shared]\ncommand = "secret-command"\nargs = ["--token", "hidden-arg"]\nenv = { API_KEY = "hidden-secret" }\n\n[mcp_servers.global-only]\nurl = "https://private.example/token"\n`);
    writeFileSync(workspace, `[mcp_servers.shared]\nurl = "https://workspace-secret.example/key"\nenabled = false\n\n[mcp_servers.workspace-only]\ncommand = "local-secret-command"\n`);

    const servers = listMobileMcpConfig(root);
    assert.deepEqual(servers, [
      { name: "global-only", scope: "global", enabled: true, transport: "http" },
      { name: "shared", scope: "workspace", enabled: false, transport: "http" },
      { name: "workspace-only", scope: "workspace", enabled: true, transport: "stdio" },
    ]);
    const serialized = JSON.stringify(servers);
    for (const secret of ["secret-command", "hidden-arg", "hidden-secret", "private.example", "workspace-secret", "config.toml"]) {
      assert.equal(serialized.includes(secret), false, `mobile response must not contain ${secret}`);
    }
  });
});

test("mobile MCP toggle reuses Codex config writer and preserves unrelated settings", async () => {
  await withConfigFixture(({ root, workspace }) => {
    mkdirSync(join(root, ".codex"));
    const original = `[mcp_servers.review]\ncommand = "reviewer"\nargs = ["--safe"]\n\n[features]\nvoice = true\n`;
    writeFileSync(workspace, original);

    const disabled = setMobileMcpConfigEnabled(root, "review", false);
    assert.deepEqual(disabled, { name: "review", scope: "workspace", enabled: false, transport: "stdio", restartRequired: true });
    const updated = readFileSync(workspace, "utf8");
    assert.match(updated, /enabled = false/);
    assert.match(updated, /command = "reviewer"/);
    assert.match(updated, /voice = true/);

    const enabled = setMobileMcpConfigEnabled(root, "review", true);
    assert.equal(enabled.enabled, true);
    assert.equal(readFileSync(workspace, "utf8").includes("enabled = false"), false);
  });
});

test("mobile MCP changes reject unsafe names, missing servers, and workspace config symlink escapes", async () => {
  await withConfigFixture(({ root, workspace }) => {
    mkdirSync(join(root, ".codex"));
    writeFileSync(workspace, `[mcp_servers.review]\ncommand = "reviewer"\n`);
    assert.throws(() => setMobileMcpConfigEnabled(root, "../config", false), /имя MCP-сервера/i);
    assert.throws(() => setMobileMcpConfigEnabled(root, "missing", false), /MCP-сервер не найден/i);
  });

  await withConfigFixture(({ root }) => {
    const outside = join(root, "outside");
    const project = join(root, "project");
    mkdirSync(outside);
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(join(outside, "config.toml"), `[mcp_servers.outside]\nurl = "https://secret.example"\n`);
    rmSync(join(project, ".codex"), { recursive: true, force: true });
    symlinkSync(outside, join(project, ".codex"), "junction");
    assert.throws(() => listMobileMcpConfig(project), /за пределы проекта|ссылк/i);
  });
});

test("mobile MCP inventory hides names that could not be safely selected for a toggle", async () => {
  await withConfigFixture(({ root, workspace }) => {
    mkdirSync(join(root, ".codex"));
    writeFileSync(workspace, `[mcp_servers.<script>alert(1)</script>]\ncommand = "hidden"\n`);
    assert.deepEqual(listMobileMcpConfig(root), []);
  });
});

test("mobile Codex restart is refused while any session has active or queued work", async () => {
  let restarted = 0;
  const acp = { isConnected: true, hasInflightPrompt: () => false, async restart() { restarted++; } };
  let pending = true;
  await assert.rejects(() => restartMobileCodex(acp, { hasPendingWork: () => pending }), /ожидающие запросы/);
  assert.equal(restarted, 0);
  pending = false;
  await assert.rejects(() => restartMobileCodex({ ...acp, hasInflightPrompt: () => true }, { hasPendingWork: () => false }), /Codex занят/);
  assert.equal(restarted, 0);
  const result = await restartMobileCodex(acp, { hasPendingWork: () => false });
  assert.deepEqual(result, { restarted: true });
  assert.equal(restarted, 1);
});
