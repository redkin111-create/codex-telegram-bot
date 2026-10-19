import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCodexPath } from "../src/config.js";

test("Mobile ACP selects an installed Codex CLI with its code-mode host", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-mobile-code-host-"));
  const pinned = join(root, "pinned");
  const usable = join(root, "usable");
  const binary = process.platform === "win32" ? "codex.exe" : "codex";
  const host = process.platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host";
  const requestedCli = join(pinned, binary);
  const fallbackCli = join(usable, binary);
  const previousPath = process.env.PATH;

  try {
    mkdirSync(pinned);
    mkdirSync(usable);
    writeFileSync(requestedCli, "requested cli");
    writeFileSync(fallbackCli, "usable cli");
    writeFileSync(join(usable, host), "code mode host");
    if (process.platform !== "win32") chmodSync(fallbackCli, 0o755);
    process.env.PATH = [usable, previousPath].filter(Boolean).join(delimiter);

    assert.equal(readFileSync(resolveCodexPath(requestedCli), "utf8"), "requested cli");
    const selected = resolveCodexPath(requestedCli, { requireCodeModeHost: true });

    assert.equal(readFileSync(selected, "utf8"), "usable cli");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Mobile ACP explicitly enables the Codex code-mode host", async () => {
  const acpClient = await import("../src/acp/client.js") as typeof import("../src/acp/client.js") & {
    buildAcpAppServerArgs?: (options: { trustAllTools: boolean; codeModeHost: boolean }) => string[];
  };

  assert.equal(typeof acpClient.buildAcpAppServerArgs, "function");
  assert.deepEqual(acpClient.buildAcpAppServerArgs!({ trustAllTools: false, codeModeHost: false }), [
    "app-server",
    "--enable",
    "request_permissions_tool",
  ]);
  assert.deepEqual(acpClient.buildAcpAppServerArgs!({ trustAllTools: false, codeModeHost: true }), [
    "app-server",
    "--enable",
    "request_permissions_tool",
    "--enable",
    "code_mode_host",
  ]);
});
