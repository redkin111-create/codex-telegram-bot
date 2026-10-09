/**
 * Codex Telegram Bot — entry point.
 * Spawns the Codex app-server agent, starts the Telegram bot, and wires graceful
 * shutdown between them.
 */
import { AcpClient } from "./acp/client.js";
import { startMiniAppAgent } from "./tma/agent.js";
import { createBot } from "./bot/bot.js";
import { CANONICAL_DIR, loadConfig } from "./config.js";
import { InstanceLock } from "./app/instance-lock.js";
import { join } from "node:path";
import { createLogger, enableFileLogging, setLogLevel } from "./logger.js";

async function main(): Promise<void> {
  // Immediate feedback before any async work, so `npm start` shows life at once.
  process.stdout.write("\u{1F916} Codex Telegram Bot — starting…\n");

  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  enableFileLogging(cfg.logFile);
  const log = createLogger("main");

  // Single-instance guard: kill any ghost/duplicate already polling this token
  // (the usual cause of a stale "Not authorized" — an old process with an
  // outdated .env). A plain manual start yields to a running background service.
  const lock = new InstanceLock(
    cfg.token,
    join(CANONICAL_DIR, "locks"),
    process.env.CODEX_TG_SUPERVISED === "1",
  );
  if (cfg.singleInstance && !(await lock.acquire())) {
    process.stdout.write(
      "\u26D4 Another Codex Telegram Bot is already running for this token (a background service). Use `codex-tg restart`, or `codex-tg stop` first.\n",
    );
    process.exit(0);
  }

  log.info("starting Codex Telegram Bot");
  log.info(`workspace: ${cfg.workspace}`);
  log.info(`codex:     ${cfg.codexCliPath}`);
  log.info(`log file:  ${cfg.logFile}`);

  const acp = new AcpClient({
    codexCliPath: cfg.codexCliPath,
    workspace: cfg.workspace,
    trustAllTools: cfg.trustAllTools,
    codexHome: cfg.codexHome,
    autoRestart: cfg.acpAutoRestart,
    promptIdleTimeoutMs: cfg.promptIdleMs,
  });

  await acp.start();
  const { bot, registry, scheduler, updater } = await createBot(cfg, acp);
  const miniApp = startMiniAppAgent({ cfg, acp, registry });
  scheduler.start();
  await updater.start();

  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down…");
    scheduler.stop();
    updater.stop();
    miniApp?.stop();
    registry.disposeAll();
    void bot.stop().catch(() => {});
    acp.stop();
    lock.release();
    setTimeout(() => process.exit(code), 500);
  };

  acp.on("exit", () => {
    if (!cfg.acpAutoRestart) {
      log.error("codex app-server exited and auto-restart is off — stopping bot.");
      shutdown(1);
    }
  });
  acp.on("restarted", () => log.info("ACP agent restarted; sessions will re-bind on next message."));

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("uncaughtException", (err) => log.error("uncaughtException:", err));
  process.on("unhandledRejection", (err) => log.error("unhandledRejection:", err));

  await bot.start({
    onStart: (info) => {
      log.info(`bot online as @${info.username}`);
      process.stdout.write(`\u2705 Online as @${info.username}. Send it a message on Telegram.\n`);
    },
  });
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
