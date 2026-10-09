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
import { TmaLiveFeed } from "./live.js";
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
  options: { port?: number; startFunnel?: boolean; tailscaleCommand?: TailscaleCommand; retryDelayMs?: number } = {},
): Promise<LocalTmaService> {
  const port = options.port ?? Number(process.env.TMA_PORT || "3301");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error("TMA_PORT must be 1..65535 (0 is reserved for tests)");
  }
  // The internal bearer token is ephemeral and never sent over the public
  // tunnel. Telegram HMAC checks and ALLOWED_USERS protect all Codex actions.
  const secret = randomBytes(32).toString("hex");
  // The Mini App and Codex live on the same Windows machine. Serve validated
  // requests directly; do not route them through a second HTTP long-poll,
  // which serialized history/screenshots and caused 28-second timeouts.
  const agent = new MiniAppAgent({ cfg, acp, registry }, "http://127.0.0.1:3301", secret);
  const live = new TmaLiveFeed(acp);
  // Permission prompts still use the Telegram bot's secure approval UI.
  // The Mini App reflects their pending state without granting permissions.
  const oldApproval=acp.permissionHandler;
  const approval=oldApproval&&((async (request:Parameters<NonNullable<typeof oldApproval>>[0])=>{
    live.status(request.sessionId,"approval","Ожидается разрешение в Telegram");
    try{return await oldApproval(request);}
    finally{live.status(request.sessionId,"working","Codex продолжает выполнение");}
  }) satisfies NonNullable<typeof oldApproval>);
  if(approval)acp.permissionHandler=approval;
  const gateway: Server = startGateway({
    token: cfg.token, secret, owners: new Set(cfg.allowedUsers),
    host: "127.0.0.1", port,
  }, async job => {
    if (!cfg.allowedUsers.has(String(job.userId))) throw new Error("Доступ запрещён");
    const result=await agent.execute(job);
    if(job.op!=="snapshot")return result;
    const snap=result as {sessions?:Array<Record<string,unknown>>};
    return {...snap,sessions:snap.sessions?.map(s=>{
      const event=live.getStatus(String(s.id??""));
      return {...s,liveStatus:event?.status??(s.busy?"working":"observing"),
        liveLabel:event?.label??(s.busy?"Codex работает":"Статус Desktop не определён")};
    })};
  }, {feed:live,authorize:(userId,sessionId)=>agent.canReadSession(sessionId,userId),
    connected:()=>acp.isConnected});
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
  log.info("Local Mini App and Codex agent listening on " + origin);

  const shouldPublish = options.startFunnel ?? autoTailscaleFunnel();
  let closed = false;
  let retryTimer: NodeJS.Timeout | undefined;
  let endRetry: (() => void) | undefined;
  // Tailscale service may initialize after the bot starts at Windows logon.
  // Keep checking with bounded backoff rather than requiring a manual restart.
  const tunnelReady: Promise<string | undefined> = shouldPublish
    ? (async () => {
        let failures = 0;
        while (!closed) {
          try {
            const url = await ensureTailscaleFunnel(addr.port, options.tailscaleCommand);
            log.info("Tailscale Funnel available at " + url);
            return url;
          } catch (error) {
            if (closed) break;
            log.warn("Tailscale Funnel not ready: " + (error as Error).message);
            const wait = options.retryDelayMs ??
              Math.min(60_000, 5_000 * 2 ** Math.min(failures++, 4));
            await new Promise<void>(resolve => {
              endRetry = resolve;
              retryTimer = setTimeout(() => {
                retryTimer = undefined;
                endRetry = undefined;
                resolve();
              }, wait);
              retryTimer.unref();
            });
          }
        }
        return undefined;
      })()
    : Promise.resolve(undefined);

  if (!shouldPublish) log.info("TMA_TAILSCALE_AUTO is disabled; no public Funnel was changed.");
  return {
    origin,
    tunnelReady,
    async stop() {
      if (closed) return;
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      endRetry?.();
      endRetry = undefined;
      retryTimer = undefined;
      agent.stop();
      live.dispose();
      if(approval&&acp.permissionHandler===approval)acp.permissionHandler=oldApproval;
      // A persisted --bg Tailscale route belongs to the Tailscale daemon and
      // survives a bot restart. Removing the bot must not wipe that route.
      gateway.closeAllConnections();
      await new Promise<void>(done => gateway.close(() => done()));
    },
  };
}
