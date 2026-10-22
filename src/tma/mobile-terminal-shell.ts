import { win32 } from "node:path";

export type MobileTerminalShellId = "cmd" | "powershell" | "default";

interface MobileTerminalShell {
  id: MobileTerminalShellId;
  label: string;
  executable: string;
  args: string[];
}

function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

export function mobileTerminalShells(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): MobileTerminalShell[] {
  if (platform === "win32") {
    const windows = env.SystemRoot || "C:\\Windows";
    return [
      { id: "cmd", label: "Командная строка (cmd)", executable: env.ComSpec || "cmd.exe", args: [] },
      {
        id: "powershell",
        label: "Windows PowerShell",
        executable: win32.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        args: ["-NoProfile"],
      },
    ];
  }

  const executable = env.SHELL || "/bin/sh";
  return [{ id: "default", label: fileName(executable) || executable, executable, args: [] }];
}

export function resolveMobileTerminalShell(
  requested: unknown,
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): MobileTerminalShell {
  const options = mobileTerminalShells(platform, env);
  const id = requested === undefined ? options[0]?.id : requested;
  const selected = options.find((option) => option.id === id);
  if (!selected) throw new Error("Недоступная оболочка терминала");
  return selected;
}
