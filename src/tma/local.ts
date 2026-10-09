/**
 * Single-machine TMA mode: use the bot's existing Windows logon service to
 * supervise the local gateway, the in-process Codex RPC agent, and optionally
 * a named Cloudflare Tunnel process. No VPS or public inbound PC port.
 *
 * The random agent-to-gateway bearer token never leaves this process. The
 * public interface remains protected by Telegram's signed initData.
 */
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Server } from "node:http";
import type { AcpClient } from "../acp/client.js";
import type { AppConfig } from "../config.js";
import type { RuntimeRegistry } from "../bot/registry.js";
import { createLogger } from "../logger.js";
import { MiniAppAgent } from "./agent.js";
import { startGateway } from "./gateway.js";

const log = createLogger("tma:local");

export function enabledLocalTma(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes", "on"].includes((env.TMA_LOCAL ?? "").trim().toLowerCase());
}

export interface LocalTmaService {
  stop(): Promise<void>;
  /** Useful for diagnostics and tests: always localhost, never 0.0.0.0. */
  origin: string;
}

export async function startLocalTma(
  cfg: AppConfig,
  acp: AcpClient,
  registry: RuntimeRegistry,
  options: { port?: number; tunnelConfig?: string; tunnelBin?: string } = {},
): Promise<LocalTmaService> {
  const port = options.port ?? Number(process.env.TMA_PORT || "3301");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error("TMA_PORT must be 1..65535 (0 is reserved for tests)");
  }
  // Ephemeral internal secret, rotated at every restart. The tunnel never
  // receives it. Use one bot account allowlist for BOTH access layers.
  const secret = randomBytes(32).toString("hex");
  const gateway: Server = startGateway({
    token: cfg.token, secret, owners: new Set(cfg.allowedUsers),
    host: "127.0.0.1", port,
  });
  try {
    if (!gateway.listening) {
      await new Promise<void>((done, reject) => {
        gateway.once("listening", done);
        gateway.once("error", reject);
      });
    }
  } catch (err) {
    gateway.close();
    throw err;
  }

  const addr = gateway.address();
  if (!addr || typeof addr === "string") {
    gateway.close();
    throw new Error("Local TMA gateway did not bind TCP");
  }
  const origin = "http://127.0.0.1:" + addr.port;
  const agent = new MiniAppAgent({ cfg, acp, registry }, origin, secret);
  agent.start();

  const tunnelConfig = (options.tunnelConfig ?? process.env.TMA_TUNNEL_CONFIG ?? "").trim();
  let supervisor: TunnelSupervisor | undefined;
  if (tunnelConfig) {
    supervisor = new TunnelSupervisor(resolve(tunnelConfig), options.tunnelBin || process.env.TMA_CLOUDFLARED_BIN || "cloudflared");
    supervisor.start();
  } else {
    log.info("Local TMA gateway started; HTTPS tunnel not configured (TMA_TUNNEL_CONFIG)");
  }
  log.info("TMA runs with the existing Codex bot on " + origin);
  let closed = false;
  return {
    origin,
    async stop() {
      if (closed) return;
      closed = true;
      supervisor?.stop();
      agent.stop();
      // /api/agent/next can hold a 16s long poll; close those connections
      // during shutdown to avoid leaving an orphaned server.
      gateway.closeAllConnections();
      await new Promise<void>(done => gateway.close(() => done()));
    },
  };
}

/** Restart cloudflared with backoff if it unexpectedly exits.
 * The connector only exposes the local loopback gateway through its existing
 * named-tunnel config; do not pass Cloudflare tokens as command arguments.
 */
class TunnelSupervisor {
  private child: ChildProcess | undefined;
  private retry: NodeJS.Timeout | undefined;
  private stopped = false;
  private failures = 0;
  constructor(private readonly config: string, private readonly executable: string) {}

  start(): void {
    if (!existsSync(this.config)) {
      log.warn("Cloudflare tunnel configuration missing: " + this.config);
      return;
    }
    this.run();
  }
  private run(): void {
    if (this.stopped) return;
    let child: ChildProcess;
    try {
      child = spawn(this.executable, ["tunnel", "--config", this.config, "run"], {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      log.warn("Could not start cloudflared:", (error as Error).message);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    const started = Date.now();
    let handled = false;
    const finished = (err?: Error) => {
      if (handled) return;
      handled = true;
      this.child = undefined;
      if (this.stopped) return;
      if (Date.now() - started > 120_000) this.failures = 0;
      log.warn("Cloudflare Tunnel stopped" + (err ? ": " + err.message : "") + "; retrying.");
      this.scheduleRestart();
    };
    child.once("error", (err) => finished(err));
    child.once("exit", () => finished());
  }
  private scheduleRestart(): void {
    if (this.stopped) return;
    const wait = Math.min(60_000, 2_000 * (2 ** Math.min(this.failures++, 5)));
    this.retry = setTimeout(() => { this.retry = undefined; this.run(); }, wait);
    this.retry.unref();
  }
  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    const child = this.child;
    this.child = undefined;
    if (child && !child.killed) child.kill();
  }
}
