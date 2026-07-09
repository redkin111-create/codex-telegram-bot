# Changelog

All notable changes to **codex-telegram-bot** are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/) and this project follows
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-07-09

First release. A Telegram bridge that drives **OpenAI Codex CLI** via the
**`codex app-server`** JSON-RPC protocol — adapted from the Kiro Telegram Bot and
rebuilt end-to-end for Codex.

### Added

- **codex app-server client** — spawns `codex app-server`, performs the
  `initialize` + `initialized` handshake, and manages threads/turns:
  `thread/start`, `thread/resume`, `turn/start` (resolving on the async
  `turn/completed` notification), and `turn/interrupt`.
- **Event translation** — Codex `item/agentMessage/delta` → streamed prose,
  `item/reasoning/*` → thinking, `commandExecution` / `fileChange` items →
  tool-call blocks with unified diffs, and `thread/tokenUsage/updated` → context %.
- **Full-auto by default** — turns run with `approvalPolicy: "never"` and
  sandbox `danger-full-access`; set `CODEX_TRUST_ALL_TOOLS=false` for inline
  Approve/Deny prompts and a `workspace-write` sandbox.
- **Model catalogue** via `model/list`; per-session model selection.
- **Sessions & history** — discovers Codex rollout logs under
  `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; `/sessions` resumes, `/history`
  replays.
- **Authentication** (`/reauth`) — ChatGPT browser login, OpenAI API key
  (`codex login --api-key`), or import an existing `~/.codex/auth.json`.
- **Multiple accounts** (`/accounts`) — snapshot/switch `auth.json`; ChatGPT
  logins keyed by email, API keys by a non-reversible fingerprint; optional
  auto-rotate on give-up.
- **MCP control** (`/mcp`) — lists, health-checks, and enables/disables servers
  from `~/.codex/config.toml` (`[mcp_servers.*]`).
- Projects, scheduled tasks, multi-image prompts, voice→prompt, file
  attachments, queued follow-ups, progress bar, and a 24/7 cross-platform
  background service (Windows / Linux / macOS), all carried over and wired to
  Codex.

### Cross-platform & isolation

- **Robust binary resolution** — resolves `codex` via `where`/`which` (preferring
  a runnable `.exe`/`.cmd`/`.bat` on Windows, never the extensionless shim),
  plus common install dirs; launches Windows `.cmd` shims through a shell and
  tree-kills them on restart. Fixes `spawn codex ENOENT`.
- **Never conflicts with a Kiro bot** — separate config home (`~/.codex/tg`),
  lock, service name (`codex-telegram-bot` / `CodexTelegramBot` /
  `com.codex.telegrambot`), sessions namespace, and no `KIRO_*` env fallbacks.
  The single-instance guard only ever terminates a positively-identified Codex
  process and refuses to start if the same token is already held by a Kiro bot.
