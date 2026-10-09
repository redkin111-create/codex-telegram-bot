/**
 * Tailscale Funnel integration for the Windows-local Telegram Mini App.
 *
 * Funnel configuration is persisted by the local Tailscale daemon with --bg,
 * including through reboot. No second tunnel process or VPS is required.
 */
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
export type TailscaleCommand = (args: readonly string[]) => Promise<string>;

function tailscaleExecutable(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TMA_TAILSCALE_BIN?.trim()) return env.TMA_TAILSCALE_BIN.trim();
  if (process.platform === "win32") {
    const directories = [env.ProgramFiles, env["ProgramFiles(x86)"], "C:\\Program Files"];
    for (const dir of directories) {
      if (!dir) continue;
      const candidate = join(dir, "Tailscale", "tailscale.exe");
      if (existsSync(candidate)) return candidate;
    }
  }
  return "tailscale";
}

export function tailscaleCommand(env: NodeJS.ProcessEnv = process.env): TailscaleCommand {
  const executable = tailscaleExecutable(env);
  return async (args) => {
    const { stdout } = await execFile(executable, [...args], {
      windowsHide: true,
      timeout: 12_000,
      maxBuffer: 128 * 1024,
    });
    return stdout;
  };
}

export function tailscaleDnsName(statusJson: string): string | undefined {
  let status: unknown;
  try { status = JSON.parse(statusJson); } catch { return undefined; }
  if (!status || typeof status !== "object") return undefined;
  const state = status as {
    BackendState?: unknown; Self?: { DNSName?: unknown; Online?: unknown };
  };
  if (state.BackendState !== "Running" || state.Self?.Online === false) return undefined;
  const hostname = String(state.Self?.DNSName ?? "").replace(/\.$/, "").toLowerCase();
  if (hostname.length > 253 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\.ts\.net$/.test(hostname)) {
    return undefined;
  }
  return hostname;
}

export function funnelUrlForPort(funnelStatus: string, hostname: string, port: number): string | undefined {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  const url = "https://" + hostname;
  // Verify both the public name and local target. An unrelated Funnel or a
  // tailnet-only Serve route must not be mistaken for the Mini App.
  if (!funnelStatus.includes(url)) return undefined;
  const target = new RegExp("\\bproxy\\s+http:\\/\\/(?:127\\.0\\.0\\.1|localhost):" + port + "(?:\\s|$|\\/)", "i");
  if (!target.test(funnelStatus)) return undefined;
  return url;
}

export async function getFunnelPublicUrl(
  port: number,
  command: TailscaleCommand = tailscaleCommand(),
): Promise<string | undefined> {
  try {
    const hostname = tailscaleDnsName(await command(["status", "--json"]));
    if (!hostname) return undefined;
    const current = await command(["funnel", "status"]);
    return funnelUrlForPort(current, hostname, port);
  } catch {
    return undefined;
  }
}

export async function ensureTailscaleFunnel(
  port: number,
  command: TailscaleCommand = tailscaleCommand(),
): Promise<string> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid TMA port");
  const hostname = tailscaleDnsName(await command(["status", "--json"]));
  if (!hostname) throw new Error("Войди в Tailscale на ноутбуке и включи MagicDNS.");
  const status = await command(["funnel", "status"]);
  const existing = funnelUrlForPort(status, hostname, port);
  if (existing) return existing;
  // Never overwrite a different public Funnel already bound on this machine.
  if (/\bhttps:\/\/[a-z0-9.-]+\.ts\.net\b/i.test(status)) {
    throw new Error("Funnel уже публикует другой сервис. Проверь tailscale funnel status вручную.");
  }
  // Background mode persists across reboot. Initial Funnel enablement still
  // requires policy and admin consent by Tailscale.
  await command(["funnel", "--bg", "--yes", "--https=443", "http://127.0.0.1:" + port]);
  const updated = await command(["funnel", "status"]);
  const result = funnelUrlForPort(updated, hostname, port);
  if (!result) throw new Error("Tailscale Funnel не подтвердил публикацию локальной TMA.");
  return result;
}
