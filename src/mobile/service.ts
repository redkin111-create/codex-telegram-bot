import type { Server } from "node:http";
import { join } from "node:path";
import type { AcpClient } from "../acp/client.js";
import type { AppConfig } from "../config.js";
import type { RuntimeRegistry } from "../bot/registry.js";
import type { MiniAppAgent } from "../tma/agent.js";
import type { TmaLiveFeed } from "../tma/live.js";
import { createLogger } from "../logger.js";
import { MobileAuthStore } from "./auth.js";
import { getOrCreateMobileAdminToken, startMobileControlChannel } from "./control.js";
import { createMobileServer, type MobileAgent, type MobileApprovals, type MobileElicitations } from "./server.js";
import type { MobileAccountController } from "./accounts.js";

const log = createLogger("mobile");

export function codexMobileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes", "on"].includes((env.CODEX_MOBILE_ENABLED ?? "").trim().toLowerCase());
}

export function mobilePort(env: NodeJS.ProcessEnv = process.env): number {
  const value = (env.CODEX_MOBILE_PORT ?? "3302").trim();
  const port = Number(value);
  const tmaPort = Number(env.TMA_PORT ?? "3301");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid CODEX_MOBILE_PORT");
  if (port === 3301 || (Number.isSafeInteger(tmaPort) && tmaPort > 0 && port === tmaPort)) {
    throw new Error("Codex Mobile must use a port separate from the Telegram Mini App");
  }
  return port;
}

export function mobileAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const origins = (env.CODEX_MOBILE_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  for (const raw of origins) {
    let origin: URL;
    try { origin = new URL(raw); } catch { throw new Error("Invalid Codex Mobile Origin"); }
    if (origin.origin !== raw || (origin.protocol !== "https:" &&
        !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
      throw new Error("Codex Mobile origins must be HTTPS except on loopback");
    }
  }
  return [...new Set(origins)];
}

export interface CodexMobileService {
  origin: string;
  stop(): Promise<void>;
}

export interface StartCodexMobileOptions {
  port?: number;
  allowedOrigins?: string[];
  staticRoot?: string;
  approvals?: MobileApprovals;
  elicitations?: MobileElicitations;
  accounts?: MobileAccountController;
}

export async function startCodexMobileService(
  cfg: AppConfig,
  agent: MiniAppAgent | MobileAgent,
  feed: TmaLiveFeed,
  options: StartCodexMobileOptions = {},
): Promise<CodexMobileService> {
  const port = options.port ?? mobilePort();
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || port === 3301 || (port > 0 && port === Number(process.env.TMA_PORT ?? "3301"))) {
    throw new Error("Codex Mobile must bind a separate loopback port");
  }
  const auth = new MobileAuthStore(cfg.dataDir, { allowedOwners: cfg.allowedUsers });
  const adminToken = await getOrCreateMobileAdminToken(cfg.dataDir);
  const control = await startMobileControlChannel({ auth, dataDir: cfg.dataDir, adminToken });
  const staticRoot = options.staticRoot ?? join(process.cwd(), "apps", "codex-mobile", "dist");
  const server: Server = createMobileServer({
    auth,
    agent,
    accounts: options.accounts,
    approvals: options.approvals,
    elicitations: options.elicitations,
    feed,
    dataDir: cfg.dataDir,
    staticRoot,
    allowedOrigins: options.allowedOrigins ?? mobileAllowedOrigins(),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    server.close();
    await control.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
    server.closeAllConnections();
    server.close();
    await control.close();
    throw new Error("Codex Mobile failed to bind only to 127.0.0.1");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  log.info(`Codex Mobile listening on ${origin}`);
  return {
    origin,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await control.close();
    },
  };
}
