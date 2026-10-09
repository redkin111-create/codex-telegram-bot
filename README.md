# Codex Telegram Bot 🤖

> **Control [OpenAI Codex CLI](https://github.com/openai/codex) from Telegram.**
> Your AI coding assistant in your pocket — switch projects, resume sessions,
> stream answers with diffs, queue follow-ups, and run it 24/7 as a background
> service on Windows, Linux, and macOS.

![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20Linux%20%7C%20macOS-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Protocol](https://img.shields.io/badge/protocol-codex%20app--server-orange)

A professional Telegram bridge that drives the **`codex app-server`** JSON-RPC
protocol, turning OpenAI Codex CLI into a mobile, always-on AI pair programmer.
Send a message from anywhere and watch Codex read files, run commands, and edit
code on your machine — with live typing indicators, clean Telegram markdown, and
unified edit diffs.

Configuration, logs, account snapshots, and task data live under `~/.codex/tg`.
Use a **different Telegram bot token** for each bot instance.

---

## ✨ Features

| Capability | What it does |
|---|---|
| 🗂 **Projects** | `/projects` shows recent Codex projects and folders explicitly allowed in `PROJECT_ROOTS`; selecting one opens its sessions. |
| ♻️ **Resume sessions** | `/sessions` lists all Codex conversations across projects; tap one to resume it. |
| 📜 **History** | `/history` shows the latest messages of any session. |
| 🧭 **Always-visible menu** | A persistent keyboard plus a pinned status panel showing project, model, reasoning, session and queue. |
| 📱 **Phone-friendly controls** | `/menu` opens compact inline screens for projects, sessions, MCP, skills, models, settings, and status. |
| ⏰ **Scheduled tasks** | Prompts that run on a schedule (once / daily / weekly / monthly / every-N-minutes) in a chosen project, delivered back to your chat. |
| 🖼 **Multi-image prompts** | Send one or many photos (albums included) with a caption — attached to the prompt for Codex to analyze. |
| 🎙 **Voice → prompt** | Send a voice note; it's transcribed (any Whisper-compatible endpoint) and run as a prompt. |
| 📎 **File attachments** | Text-like files are inlined into the prompt; binaries are saved and their path handed to the agent. |
| 🧩 **Live MCP control** | `/mcp` combines Codex's live server/tool/resource/auth inventory with config toggles and real health checks. |
| 🧩 **Live capabilities** | `/models`, `/agents`, and `/skills` read the current Codex app-server inventories; no stale model catalog. |
| 📈 **Task progress bar** | Agent emits a `{progress: N%}` marker; the bot hides it and shows a green 0–100% bar (with a computed fallback). |
| 🔐 **Re-auth from chat** | `/reauth` signs in without a terminal — **ChatGPT** (browser link), **API key**, or **import** an existing `codex login`. |
| 👥 **Multiple accounts** | `/accounts` saves several Codex logins and switches between them in a tap with stable account fingerprints and `auth.json` snapshots. |
| 🔁 **Quota-safe rotation** | When Codex reports account/workspace quota exhaustion, serialized rotation tries each saved login once and rolls back safely if restart fails. |
| 🪙 **Live usage** | `/usage` shows identity, model, context usage, quota windows, reset times, credits, and turns. |
| 👥 **Real subagents** | Collaboration tool events are surfaced as active subagent status and cleaned up when complete. |
| ⌨️ **Typing indicator** | Stays on for the whole turn, through long tool chains. |
| 📥 **Queued follow-ups** | Message while Codex is busy — it's queued and runs next. `/btw` runs ASAP; `/flush` runs the queue now. |
| ✏️ **Edit diffs** | File edits show as unified `diff` blocks with `+N -M` stats. |
| 💬 **Quality markdown** | Converts agent markdown to Telegram **MarkdownV2** with safe escaping and code-fence-aware splitting. |
| 🔁 **Self-healing** | Auto-restarts the Codex agent with backoff and re-binds your session. |
| 🖥 **Runs 24/7** | 1-command install as a background service that starts on boot — Windows, Linux, macOS, auto-detected. |
| 🔒 **Access control** | Restrict to specific Telegram user IDs, with private-chat-only operation. |

---

## 📱 Telegram Mini App (optional)

A lightweight Codex Remote Mini App is available in `apps/mini-app/public`.
It runs on an HTTPS gateway and connects outbound to this bot on Windows.
Use `/app` in Telegram to open projects, chats, full reports and queue management.
See [Mini App setup](docs/TMA.md) for security and VPS deployment steps.

## ⚡ Install the upstream npm release

```bash
npm install -g codex-telegram-bot
```

**Note:** the npm package is maintained upstream and does **not** include the changes in this fork. For this fork, clone it and follow the source setup below.

This installs the upstream global **`codex-tg`** CLI (ships with the `tsx` runtime, no
build step). Config lives in a path-independent home — `~/.codex/tg/` (its
`.env`, `logs/`, `data/`) — so the bot loads the **same** `.env` no matter where
you start it.

```bash
codex-tg setup            # auto-detects codex, writes ~/.codex/tg/.env
codex-tg setup --path     # print the .env location
# edit that .env: set TELEGRAM_BOT_TOKEN and ALLOWED_USERS
codex-tg run              # foreground …
codex-tg install          # … or install as a 24/7 background service
```

Startup options: `codex-tg setup [--path] | run | install | status | logs [n] |
stop | restart | uninstall`. See **[docs/INSTALL.md](./docs/INSTALL.md)** for the
full guide and **[docs/UPGRADE.md](./docs/UPGRADE.md)** to update.

### Prerequisites

- **OpenAI Codex CLI** installed and authenticated — `npm i -g @openai/codex`,
  then `codex login` once (ChatGPT or an API key). Confirm with `codex --version`.
- **Node.js 20+**.
- A **bot token** from [@BotFather](https://t.me/BotFather).
- Your **Telegram user ID** from [@userinfobot](https://t.me/userinfobot).

---

## 🧑‍💻 Manual setup (from source)

```bash
git clone https://github.com/redkin111-create/codex-telegram-bot.git
cd codex-telegram-bot
npm install
npm run setup            # auto-detects codex + project roots, writes .env
# edit .env: set TELEGRAM_BOT_TOKEN and ALLOWED_USERS
npm start                # or: npm run dev  (auto-reload)
```

No build step — TypeScript runs directly via `tsx`.

---

## 💬 Commands

```
/menu         Show the persistent menu keyboard
/projects     Recent Codex projects · search · allowed folders · new <name>
  /sessions     All conversations across projects · /sessions <q> to filter
/mcp          Live MCP inventory · health-check · enable/disable
/models       List models reported by the running Codex app-server
/agents       List collaboration modes and observed subagents
/skills       List enabled skills reported by Codex
/tasks        Manage scheduled tasks · /newtask to create one
/history      Show recent conversation history
/new          Start a fresh session here
/status       Current session, project & queue
/usage        Account, model & context usage
/btw <text>   Run now if idle, else queue to run right after the current task
/flush        Send queued follow-ups now · /queue · /clearqueue
/cancel       Stop the current turn
/model <id>   Switch the model for this session
/restart      Restart the Codex agent
/reauth       Log in to Codex — ChatGPT / API key / import existing login
/accounts     Save & switch between multiple Codex accounts · auto-rotate
/help         Show help
```

Anything that isn't a command is sent to Codex as a prompt. While a turn runs,
your messages are queued and sent automatically when it finishes.

**Queue recovery:** Queued follow-ups are saved atomically under `DATA_DIR/queues/`
(one file per private Telegram chat). After a bot/process restart, pending items
remain in the same session but are **paused** until you review them and select
`/queue` → **Resume**. A turn interrupted while running is placed back at the
front of that paused queue; it might have already changed files before the
interruption. Inspect the workspace/history first to avoid repeating side
effects. Removing a queued item removes its saved state too. A normal
`/cancel` of an already-running turn does not auto-requeue that turn.


### Phone-friendly inline controls

Open `/menu` or tap **☰ Menu** for a compact control panel. Conversation lists
cover all projects, show the project beside each title, and are paged. Selecting
a project narrows the list to its actual working folder. Each screen offers a
clear way back to the main menu. Model,
reasoning, and MCP controls use the live information reported by Codex. The bot
works without repeated prompts inside the selected project folder. Requests to
access other folders or the network still ask for one-time approval when
full-access mode is off.

---

## 🧩 How it works

```
Telegram  ──HTTPS──▶  Bot (grammY)
                         │  spawns once
                         ▼
                 codex app-server  ◀── JSON-RPC 2.0 over stdio ──▶  Bot
                         │
                         ├─ thread/start · thread/resume   (new sessions, resume)
                         ├─ turn/start                     (your messages)
                         └─ item/* · turn/* notifications  (streamed text, tools, diffs)
```

One `codex app-server` process multiplexes many threads (one per chat/project).
Codex's streamed events are translated into a live, throttled Telegram message:
`item/agentMessage/delta` → prose, `item/reasoning/*` → thinking,
`commandExecution` / `fileChange` items → tool-call blocks with diffs, and
`turn/completed` ends the turn. On Windows the `codex` npm shim (`codex.cmd`) is
launched through a shell and its process tree is cleaned up on restart.

Codex persists sessions as **rollout** logs under `~/.codex/sessions/YYYY/MM/DD/
rollout-<ts>-<uuid>.jsonl` (used by `/sessions` and `/history`).

---

## 🔐 Authentication (`/reauth`)

Codex signs in two ways (plus reusing an existing login):

- **💬 ChatGPT** — `codex login` prints a browser link; approve it, and the bot
  verifies + restarts the agent.
- **🔑 API key** — send your OpenAI `sk-...` key; the bot runs
  `codex login --api-key` (the key message is deleted after use).
- **📥 Import** — adopt a `codex login` already present in `~/.codex/auth.json`.

`/accounts` snapshots the active `auth.json` as a named account and switches
between them in a tap. ChatGPT workspaces use a non-reversible account
fingerprint when available; API keys use a non-reversible key fingerprint.
**🔁 Auto-rotate** activates only for a definitive quota/account exhaustion,
holds a process-global lock through restart and retry, and restores the exact
previous credentials if activation fails.

### Live capability discovery

The bot asks the running `codex app-server` for its current `model/list`,
`collaborationMode/list`, `skills/list`, and `mcpServerStatus/list` data after
startup and on demand. Model and MCP results are paginated, so the UI does not
depend on hardcoded model names or a stale local catalog. `/mcp` also keeps a
separate real MCP `initialize` health check for enabled configured servers.

---

## ⚙️ Configuration (`.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | **yes** | — | Bot token from @BotFather. Use a **distinct** token per bot. |
| `ALLOWED_USERS` | **yes** | — | Comma-separated Telegram user IDs. The bot refuses to start if empty. |
| `CODEX_CLI_PATH` | no | auto | Path to the `codex` binary (auto-resolved via PATH otherwise). |
| `CODEX_HOME` | no | `~/.codex` | Holds `sessions/`, `auth.json`, `config.toml`. |
| `CODEX_WORKSPACE` | no | cwd | Default working directory. |
| `CODEX_TRUST_ALL_TOOLS` | no | `false` | `false` allows work inside the selected project without repeated prompts; access outside it or to the network still requires approval. `true` enables `danger-full-access` with approvals disabled. |
| `CODEX_TG_DIR` | no | `~/.codex/tg` | Folder holding this instance's `.env`, `logs/`, `data/`. |
| `PROJECT_ROOTS` | no | none | Explicit allowlist for browsing immediate child project folders. Recent Codex projects are discovered from session history. If unset, no home-directory scan occurs; an explicitly set `CODEX_WORKSPACE` may be browsed. |
| `STREAM_THROTTLE_MS` | no | `1500` | Live-edit interval while streaming. |
| `MESSAGE_BATCH_MS` | no | `800` | Window to coalesce rapid text messages into one prompt. |
| `SHOW_TOOL_CALLS` | no | `false` | Show terminal/tool traces in Telegram; enable for verbose debugging. |
| `SHOW_EDIT_DIFFS` | no | `false` | Show file diffs in Telegram; requires `SHOW_TOOL_CALLS=true`. |
| `DIFF_MAX_LINES` | no | `120` | Max diff lines shown inline. |
| `SEND_AGENT_IMAGES` | no | `true` | Send fresh image files (including screenshots) to Telegram when their paths appear in agent output or tool data. |
| `AGENT_IMAGES_MAX` | no | `8` | Maximum number of images sent after one agent turn. |
| `DOC_MAX_CHARS` | no | `100000` | Max chars of a text attachment inlined (0 = unlimited). |
| `PROGRESS_FALLBACK` | no | `true` | Show a progress bar estimated by the bot from actual activity. |
| `NOTIFY_OTHER_SESSIONS` | no | `true` | Deliver background sessions' "Done" summaries. |
| `MCP_PROBE_TIMEOUT_MS` | no | `8000` | Per-server timeout for the `/mcp` health-check. |
| `ACP_AUTO_RESTART` | no | `true` | Auto-restart the agent if it exits. |
| `CODEX_TG_SINGLE_INSTANCE` | no | `true` | Enforce one running Codex bot per Telegram token. |
| `AUTO_UPDATE` | no | `false` | Hourly npm check; auto-update + restart when idle (global npm installs only). |
| `UPDATE_CHECK_MS` | no | `3600000` | Auto-update polling interval in milliseconds. The first check runs about 60 seconds after startup. |
| `PROMPT_RETRY_ATTEMPTS` | no | `5` | Retries for a transient agent error (6s→60s backoff). |
| `AUTO_FORK_ON_ERROR` | no | `true` | Fork a fresh continuation when retries are exhausted. |
| `RESUME_ON_STREAM_ERROR` | no | `true` | Continue the same session after a mid-stream throttle. |
| `STT_API_URL` / `STT_API_KEY` / `STT_MODEL` / `STT_LANGUAGE` | no | — | Voice transcription endpoint (OpenAI/Whisper-compatible). |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error`. |

See [`.env.example`](./.env.example) for the annotated full list.

---

## 🛠 Run as a background service

The bot installs as a **user-level** service that starts on boot (auto-detected):
a hidden Scheduled Task / Startup launcher on Windows, a `systemd` **user**
service on Linux (with linger), and a launchd LaunchAgent on macOS.

```bash
codex-tg install     # install + start, enable autostart
codex-tg status      # show install + running state
codex-tg restart     # restart
codex-tg logs 200    # tail the log file
codex-tg uninstall   # stop + remove
```

Logs live at `logs/codex-telegram-bot.log`.

### Automatic npm updates

For a global npm install, set `AUTO_UPDATE=true` to check the npm `latest` dist-tag
on the configured interval. An update is applied only when the bot is fully
idle: no Telegram turn, scheduled task, or unrelated active Codex session is
running. Busy checks are deferred to the next interval; the current turn is
never interrupted. After a successful `npm install -g`, the bot restarts using
the installed package and posts the matching changelog section with `#update`.
Source checkouts and zip installs are intentionally never self-updated.

---

## 📁 Project layout

```
src/
├── index.ts              Entry point, daemon-friendly logging, shutdown
├── cli.ts                CLI: run / install / start / stop / status / logs
├── config.ts             .env loading, paths, codex binary resolution
├── acp/                  codex app-server client, protocol types, event translation
├── app/                  auth (codex login), accounts, usage, updater, spawn helpers
├── sessions/             Rollout session discovery, history parser, live tail
├── projects/             Project directory discovery
├── mcp/                  MCP config (config.toml) + live health probe
├── render/               Markdown→MarkdownV2, diffs, tool formatting, progress
├── stream/               Incremental edit-streaming
├── service/              Cross-platform daemon (windows/linux/macos + selector)
├── tasks/                Scheduled tasks
└── bot/                  grammY bot, per-chat runtime, handlers
```

---

## 🔒 Security

This bot lets authorized Telegram users run commands and edit files on the host.
**Always set `ALLOWED_USERS`**, keep `.env` private, use a distinct bot token,
and run as a non-privileged user. See [SECURITY.md](./SECURITY.md).

---

## 🤝 Contributing

Contributions welcome — see **[CONTRIBUTING.md](./CONTRIBUTING.md)**. No build
step (`npm run dev`); `npm run typecheck` must pass.

## 📄 License

[MIT](./LICENSE)

<sub>Keywords: OpenAI Codex CLI Telegram bot, codex app-server, AI coding
assistant on Telegram, mobile AI pair programming, remote coding agent, run AI
agent as a service, Windows/Linux/macOS daemon, ChatOps for developers.</sub>
