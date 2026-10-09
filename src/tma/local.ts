/**
 * Windows-local TMA: the existing bot service owns the HTTP loopback gateway
 * and Codex RPC agent. Tailscale's own service persists HTTPS Funnel routes.
 *
 * No VPS, cloudflared subprocess, public PC listener or router port forwarding.
 */
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AcpClient } from "../acp/client.js";
import type { AppConfig } from "../config.js";
import type { RuntimeRegistry } from "../bot/registry.js";
import { createLogger } from "../logger.js";
import { MiniAppAgent } from "./agent.js";
import { startGateway } from "./gateway.js";
import { ensureTailscaleFunnel, type TailscaleCommand } from "./tailscale.js";

const log = createLogger("tma:local");

function enabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

export function enabledLocalTma(env: NodeJS.ProcessEnv = process.env): boolean {
  return enabled(env.TMA_LOCAL);
}

/** Explicit opt-in: Funnel makes the authorized TMA endpoint reachable from
 * the public internet. Never publish it solely because TMA_LOCAL=true. */
export function autoTailscaleFunnel(env: NodeJS.ProcessEnv = process.env): boolean {
  return enabled(env.TMA_TAILSCALE_AUTO);
}

export interface LocalTmaService {
  stop(): Promise<void>;
  origin: string;
  /** Initial non-blocking Funnel setup result, for diagnostics and tests. */
  tunnelReady: Promise<string | undefined>;
}

export async function startLocalTma(
  cfg: AppConfig,
  acp: AcpClient,
  registry: RuntimeRegistry,
  options: { port?: number; startFunnel?: boolean; tailscaleCommand?: TailscaleCommand } = {},
): Promise<LocalTmaService> {
  const port = options.port ?? Number(process.env.TMA_PORT || "3301");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error("TMA_PORT must be 1..65535 (0 is reserved for tests)");
  }
  // The internal bearer token is ephemeral and never sent over the public
  // tunnel. Telegram HMAC checks and ALLOWED_USERS protect all Codex actions.
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
  log.info("Local Mini App and Codex agent listening on " + origin);

  const shouldPublish = options.startFunnel ?? autoTailscaleFunnel();
  const tunnelReady: Promise<string | undefined> = shouldPublish
    ? ensureTailscaleFunnel(addr.port, options.tailscaleCommand).then(
        url => { log.info("Tailscale Funnel available at " + url); return url; },
        err => {
          log.warn("Tailscale Funnel could not be enabled: " + (err as Error).message);
          log.warn("The local Mini App remains available. Check Tailscale login, DNS and Funnel permissions.");
          return undefined;
        },
      )
    : Promise.resolve(undefined);

  if (!shouldPublish) log.info("TMA_TAILSCALE_AUTO is disabled; no public Funnel was changed.");
  let closed = false;
  return {
    origin,
    tunnelReady,
    async stop() {
      if (closed) return;
      closed = true;
      agent.stop();
      // A persisted --bg Tailscale route belongs to the Tailscale daemon and
      // survives a bot restart. Removing the bot must not wipe that route.
      gateway.closeAllConnections();
      await new Promise<void>(done => gateway.close(() => done()));
    },
  };
}
