import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMobileMcpConfigServer, listMobileMcpConfig, removeMobileMcpConfigServer, restartMobileCodex, setMobileMcpConfigEnabled } from "../src/mobile/mcp-config.js";

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

test("mobile MCP inventory shows both safe config scopes and marks the effective entry", async () => {
  await withConfigFixture(({ root, global, workspace }) => {
    mkdirSync(join(root, ".codex"));
    writeFileSync(global, `[mcp_servers.shared]\ncommand = "secret-command"\nargs = ["--token", "hidden-arg"]\nenv = { API_KEY = "hidden-secret" }\n\n[mcp_servers.global-only]\nurl = "https://private.example/token"\n`);
    writeFileSync(workspace, `[mcp_servers.shared]\nurl = "https://workspace-secret.example/key"\nenabled = false\n\n[mcp_servers.workspace-only]\ncommand = "local-secret-command"\n`);

    const servers = listMobileMcpConfig(root);
    assert.deepEqual(servers, [
      { name: "global-only", scope: "global", enabled: true, transport: "http", effective: true },
      { name: "shared", scope: "global", enabled: true, transport: "stdio", effective: false },
      { name: "shared", scope: "workspace", enabled: false, transport: "http", effective: true },
      { name: "workspace-only", scope: "workspace", enabled: true, transport: "stdio", effective: true },
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
    assert.deepEqual(disabled, { name: "review", scope: "workspace", enabled: false, transport: "stdio", effective: true, restartRequired: true });
    const updated = readFileSync(workspace, "utf8");
    assert.match(updated, /enabled = false/);
    assert.match(updated, /command = "reviewer"/);
    assert.match(updated, /voice = true/);

    const enabled = setMobileMcpConfigEnabled(root, "review", true);
    assert.equal(enabled.enabled, true);
    assert.equal(readFileSync(workspace, "utf8").includes("enabled = false"), false);
  });
});

test("mobile MCP add writes a workspace stdio server without exposing secrets", async () => {
  await withConfigFixture(({ root, workspace }) => {
    mkdirSync(join(root, ".codex"));
    writeFileSync(workspace, "[features]\nvoice = true\n");
    const added = addMobileMcpConfigServer(root, {
      name: "local_review",
      scope: "workspace",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@example/review-mcp"],
      env: { REVIEW_TOKEN: "do-not-return-this" },
    });
    assert.deepEqual(added, { name: "local_review", scope: "workspace", enabled: true, transport: "stdio", effective: true, restartRequired: true });
    const text = readFileSync(workspace, "utf8");
    assert.match(text, /\[features\]\nvoice = true/);
    assert.match(text, /\[mcp_servers\.local_review\]/);
    assert.match(text, /args = \["-y", "@example\/review-mcp"\]/);
    assert.match(text, /env = \{ REVIEW_TOKEN = "do-not-return-this" \}/);
    assert.deepEqual(listMobileMcpConfig(root), [
      { name: "local_review", scope: "workspace", enabled: true, transport: "stdio", effective: true },
    ]);
    assert.equal(JSON.stringify(added).includes("do-not-return-this"), false);
  });
});

test("mobile MCP removal deletes one exact scope including nested tables and preserves other TOML", async () => {
  await withConfigFixture(({ root, global, workspace }) => {
    mkdirSync(join(root, ".codex"));
    writeFileSync(global, `[mcp_servers.review]\ncommand = "global-review"\n`);
    writeFileSync(workspace, `# Project settings\n[mcp_servers.review]\ncommand = "project-review"\n\n[mcp_servers.review.env]\nTOKEN = "secret"\n\n[mcp_servers.other]\ncommand = "keep-me"\n\n[features]\nvoice = true\n`);

    const removed = removeMobileMcpConfigServer(root, "review", "workspace");
    assert.deepEqual(removed, { name: "review", scope: "workspace", removed: true, restartRequired: true });
    const text = readFileSync(workspace, "utf8");
    assert.doesNotMatch(text, /project-review|\[mcp_servers\.review(?:\.env)?\]|TOKEN =/);
    assert.match(text, /\[mcp_servers\.other\]\ncommand = "keep-me"/);
    assert.match(text, /\[features\]\nvoice = true/);
    assert.deepEqual(listMobileMcpConfig(root), [
      { name: "other", scope: "workspace", enabled: true, transport: "stdio", effective: true },
      { name: "review", scope: "global", enabled: true, transport: "stdio", effective: true },
    ]);
  });
});

test("mobile MCP removal rejects invalid, missing, and unsafe config targets", async () => {
  await withConfigFixture(({ root, workspace }) => {
    mkdirSync(join(root, ".codex"));
    writeFileSync(workspace, `[mcp_servers.review]\ncommand = "reviewer"\n`);
    assert.throws(() => removeMobileMcpConfigServer(root, "../config", "workspace"), /имя MCP-сервера/i);
    assert.throws(() => removeMobileMcpConfigServer(root, "missing", "workspace"), /MCP-сервер не найден/i);
    assert.throws(() => removeMobileMcpConfigServer(root, "review", "global"), /MCP-сервер не найден/i);
  });
});

test("mobile MCP removal can remove a shadowed global entry without removing the project override", async () => {
  await withConfigFixture(({ root, global, workspace }) => {
    mkdirSync(join(root, ".codex"));
    writeFileSync(global, `[mcp_servers.shared]\ncommand = "global-secret"\n`);
    writeFileSync(workspace, `[mcp_servers.shared]\ncommand = "project-server"\n`);

    const removed = removeMobileMcpConfigServer(root, "shared", "global");
    assert.deepEqual(removed, { name: "shared", scope: "global", removed: true, restartRequired: true });
    assert.equal(readFileSync(global, "utf8").includes("global-secret"), false);
    assert.match(readFileSync(workspace, "utf8"), /project-server/);
    assert.deepEqual(listMobileMcpConfig(root), [
      { name: "shared", scope: "workspace", enabled: true, transport: "stdio", effective: true },
    ]);
  });
});

test("mobile MCP add writes an HTTPS global server with bearer token environment name", async () => {
  await withConfigFixture(({ root, global }) => {
    const added = addMobileMcpConfigServer(root, {
      name: "remote_docs",
      scope: "global",
      transport: "http",
      url: "https://mcp.example.test/mcp?tenant=demo",
      bearerTokenEnvVar: "DOCS_MCP_TOKEN",
    });
    assert.deepEqual(added, { name: "remote_docs", scope: "global", enabled: true, transport: "http", effective: true, restartRequired: true });
    const text = readFileSync(global, "utf8");
    assert.match(text, /url = "https:\/\/mcp\.example\.test\/mcp\?tenant=demo"/);
    assert.match(text, /bearer_token_env_var = "DOCS_MCP_TOKEN"/);
    assert.equal(JSON.stringify(added).includes("tenant=demo"), false);
  });
});

test("mobile MCP add validates names, transport data, URL safety, and duplicate names", async () => {
  await withConfigFixture(({ root, workspace }) => {
    mkdirSync(join(root, ".codex"));
    writeFileSync(workspace, "[mcp_servers.exists]\ncommand = \"safe\"\n");
    const base = { scope: "workspace" as const, transport: "stdio" as const, command: "node" };
    assert.throws(() => addMobileMcpConfigServer(root, { ...base, name: "../escape" }), /имя MCP-сервера/i);
    assert.throws(() => addMobileMcpConfigServer(root, { ...base, name: "exists" }), /уже существует/i);
    assert.throws(() => addMobileMcpConfigServer(root, { scope: "global", transport: "http", name: "plain", url: "http://192.0.2.10/mcp" }), /HTTPS|локальн/i);
    assert.throws(() => addMobileMcpConfigServer(root, { scope: "global", transport: "http", name: "creds", url: "https://user:pass@mcp.example.test/mcp" }), /адрес MCP/i);
    assert.throws(() => addMobileMcpConfigServer(root, { ...base, name: "bad_env", env: { "NOT-AN-ENV": "x" } }), /переменн/i);
    assert.throws(() => addMobileMcpConfigServer(root, { ...base, name: "bad_arg", args: ["ok\n[mcp_servers.evil]"] }), /аргумент/i);
  });
});

test("mobile MCP add rejects workspace config directory and global config file symlink escapes", async () => {
  await withConfigFixture(({ root }) => {
    const outside = join(root, "outside");
    const project = join(root, "project");
    mkdirSync(outside);
    mkdirSync(project);
    symlinkSync(outside, join(project, ".codex"), "junction");
    assert.throws(() => addMobileMcpConfigServer(project, {
      name: "escaped", scope: "workspace", transport: "stdio", command: "node",
    }), /за пределы проекта|ссылк|внутри проекта/i);
  });

  await withConfigFixture(({ root, global }) => {
    const outside = join(root, "outside-config.toml");
    writeFileSync(outside, "[mcp_servers.keep]\ncommand = \"safe\"\n");
    symlinkSync(outside, global, "file");
    assert.throws(() => addMobileMcpConfigServer(root, {
      name: "unsafe_global", scope: "global", transport: "stdio", command: "node",
    }), /обычным файлом/i);
    assert.equal(readFileSync(outside, "utf8").includes("unsafe_global"), false);
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
