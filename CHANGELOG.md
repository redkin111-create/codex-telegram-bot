# Changelog

All notable changes to **codex-telegram-bot** are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/) and this project follows
[Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-07-15

### Added

- Live Codex capability discovery for models, collaboration modes, skills, MCP
  server status, account identity, and rate-limit windows.
- `/models`, `/agents`, and `/skills` commands, plus real subagent activity
  reporting and lifecycle cleanup.
- Live quota details in `/usage`, including reset times, credits, and limit type.
- `REDDIT.md` launch post and expanded README documentation.

### Changed

- Account matching now prefers stable non-reversible ChatGPT workspace or API-key
  fingerprints instead of relying on email alone.
- Account switching and quota rotation are process-global transactions with
  atomic credential writes, exact-byte rollback, and serialized retries.
- MCP UI combines app-server inventory with config toggles and bounded Telegram
  output.
- Automatic account rotation is restricted to definitive quota/account
  exhaustion instead of arbitrary terminal errors.
- Removed stale provider-specific installer, documentation, and protocol
  leftovers.

## [1.0.0] - 2026-07-09

First release. A Telegram bridge that drives **OpenAI Codex CLI** via the
**`codex app-server`** JSON-RPC protocol, built end-to-end for Codex.

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
- **Multiple accounts** (`/accounts`) — snapshot/switch `auth.json`; logins
  keyed by a non-reversible account fingerprint; optional
  auto-rotate on give-up.
- **MCP control** (`/mcp`) — lists, health-checks, and enables/disables servers
  from `~/.codex/config.toml` (`[mcp_servers.*]`).
- Projects, scheduled tasks, multi-image prompts, voice→prompt, file
  attachments, queued follow-ups, progress bar, and a 24/7 cross-platform
  background service (Windows / Linux / macOS).

### Cross-platform & isolation

- **Robust binary resolution** — resolves `codex` via `where`/`which` (preferring
  a runnable `.exe`/`.cmd`/`.bat` on Windows, never the extensionless shim),
  plus common install dirs; launches Windows `.cmd` shims through a shell and
  tree-kills them on restart. Fixes `spawn codex ENOENT`.
- **Safe single-instance behavior** — dedicated config home (`~/.codex/tg`),
  lock, service name (`codex-telegram-bot` / `CodexTelegramBot` /
  `com.codex.telegrambot`), and sessions namespace. The guard only terminates a
  positively identified Codex bot process.
