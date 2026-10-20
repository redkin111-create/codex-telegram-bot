import assert from "node:assert/strict";
import { test } from "node:test";
import { runMobileTerminalCommand } from "../src/tma/mobile-terminal.js";
import { resolveMobileTerminalShell } from "../src/tma/mobile-terminal-shell.js";

test("Windows shell selection resolves only to supported local shells", () => {
  const env = { ComSpec: "C:\\Windows\\System32\\cmd.exe", SystemRoot: "C:\\Windows" };

  assert.deepEqual(resolveMobileTerminalShell("cmd", "win32", env), {
    id: "cmd",
    label: "Командная строка (cmd)",
    executable: "C:\\Windows\\System32\\cmd.exe",
    args: [],
  });
  assert.deepEqual(resolveMobileTerminalShell("powershell", "win32", env), {
    id: "powershell",
    label: "Windows PowerShell",
    executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    args: ["-NoProfile"],
  });
});

test("mobile shell selection rejects an arbitrary executable path", () => {
  assert.throws(
    () => resolveMobileTerminalShell("C:\\Users\\Public\\payload.exe", "win32", {}),
    /Недоступная оболочка терминала/,
  );
});

test("non-Windows systems expose only their configured default shell", () => {
  assert.deepEqual(resolveMobileTerminalShell("default", "linux", { SHELL: "/bin/zsh" }), {
    id: "default",
    label: "zsh",
    executable: "/bin/zsh",
    args: [],
  });
  assert.throws(
    () => resolveMobileTerminalShell("powershell", "linux", { SHELL: "/bin/zsh" }),
    /Недоступная оболочка терминала/,
  );
});

test("PowerShell cmdlet failures return a failing exit code", { skip: process.platform !== "win32" }, async () => {
  const missing = `C:\\codex-mobile-missing-${Date.now()}\\file.txt`;
  const result = await runMobileTerminalCommand(process.cwd(), `Get-Item -LiteralPath '${missing}'`);

  assert.notEqual(result.exitCode, 0);
  assert.notEqual(result.stderr, "");
});
