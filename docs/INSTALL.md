# 📦 Install guide

Get the Codex Telegram Bot running in a few minutes. Pick one of three ways:

- **[Option A — npm (recommended)](#option-a--npm-recommended)** — one command,
  global `codex-tg` CLI, easiest to update.
- **[Option B — 1-click installer](#option-b--1-click-installer)** — download a
  release zip and double-click the installer.
- **[Option C — manual / from source](#option-c--manual--from-source)** — clone
  the repo (best for contributors).

## Prerequisites

- **OpenAI Codex CLI** installed and authenticated — `npm i -g @openai/codex`,
  then `codex login` once, and confirm with `codex --version`.
- **Node.js 20+**.
- A **bot token** from [@BotFather](https://t.me/BotFather).
- Your **Telegram user ID** from [@userinfobot](https://t.me/userinfobot).

---

## Option A — npm (recommended)

Install the CLI once, globally. It ships with the `tsx` runtime, so there's no
build step.

```bash
npm install -g codex-telegram-bot
```

This gives you the **`codex-tg`** command (alias: `codex-telegram-bot`). Config
lives in a path-independent home — `~/.codex/tg/` — so the bot loads the **same**
`.env`, `logs/` and `data/` no matter which folder you start it from.

```bash
codex-tg setup                   # auto-detects codex, writes ~/.codex/tg/.env
#   (or pass values directly:  codex-tg setup <BOT_TOKEN> <YOUR_USER_ID>)
# edit .env: set TELEGRAM_BOT_TOKEN and ALLOWED_USERS
codex-tg run                     # run in the foreground (Ctrl-C to stop)
```

> **Set `ALLOWED_USERS`** in `.env` to your Telegram user ID(s). The bot refuses
> to start if the list is empty.
>
### Startup options (`codex-tg <command>`)

| Command | What it does |
|---|---|
| `codex-tg setup [token] [userId]` | Create/update `.env` and auto-detect `codex`; project roots are configured manually in `PROJECT_ROOTS`. |
| `codex-tg setup --path` | Print the resolved `.env` location. |
| `codex-tg run` | Run the bot in the foreground. |
| `codex-tg install` | Install + start a **24/7 background service** that autostarts on boot/login. |
| `codex-tg status` | Show install + running state of the service. |
| `codex-tg logs [n]` | Tail the last `n` log lines (default 100). |
| `codex-tg stop` / `restart` / `start` | Control the running service. |
| `codex-tg uninstall` | Stop + remove the background service. |
| `codex-tg help` | Show all commands. |

The background service is **user-level** and auto-detected per platform — a
hidden Scheduled Task on Windows, a `systemd` **user** service on Linux (with
linger for boot-without-login), and a launchd **LaunchAgent** on macOS.

Update later with `npm install -g codex-telegram-bot@latest` (global npm installs
also auto-update when idle). Full upgrade steps are in **[UPGRADE.md](./UPGRADE.md)**.

> **Try without installing:** `npx codex-telegram-bot setup` then
> `npx codex-telegram-bot run` works too (slower first run).

---

## Option B — 1-click installer

Every [release](https://github.com/artickc/codex-telegram-bot/releases) ships a
clean `codex-telegram-bot-<version>.zip` (no `node_modules`, `.env`, logs or
data) that contains the 1-click installers.

1. **Download** the latest `codex-telegram-bot-<version>.zip` and unzip it (or
   `git clone` the repo).
2. **Run the installer for your OS** from the unzipped folder. It installs
   dependencies, auto-detects `codex`, writes `.env`, asks for your bot token,
   and optionally sets up the 24/7 background service.

   **Windows** — double-click `install.cmd`, or in a terminal:

   ```powershell
   .\install.cmd
   ```

   **Linux / macOS**:

   ```bash
   chmod +x install.sh && ./install.sh
   ```

3. **Set access control.** Open `.env` and set `ALLOWED_USERS` to your Telegram
   user ID(s).

---

## Option C — manual / from source

Best for contributors (run with auto-reload, no build step).

```bash
git clone https://github.com/artickc/codex-telegram-bot.git
cd codex-telegram-bot
npm install
npm run setup            # auto-detects codex + project roots, writes .env
# edit .env: set TELEGRAM_BOT_TOKEN and ALLOWED_USERS
npm start                # or: npm run dev  (auto-reload)
```

Run it 24/7 as a background service:

```bash
npm run install:service     # install + start, enable autostart on boot/login
npm run service -- status   # show install + running state
npm run service -- logs 200 # tail the log file
npm run uninstall:service   # stop + remove
```

No build step — TypeScript runs directly via `tsx`.

---

## Updating

Already installed and want the newest version? See **[UPGRADE.md](./UPGRADE.md)**.

## Configuration

All options live in `.env`. See the **Configuration** table in the
[README](../README.md) for every variable and its default. By default the bot
keeps `.env`, `logs/` and `data/` under `~/.codex/tg` (override log location with
`LOG_DIR` / `LOG_FILE` and data with `DATA_DIR`).

## Troubleshooting

- **Bot doesn't respond** — confirm your ID is in `ALLOWED_USERS` and the token
  is correct; check `logs/codex-telegram-bot.log` (run `codex-tg logs`).
- **`spawn codex ENOENT` / codex not found** — install the CLI (`npm i -g
  @openai/codex`) or set `CODEX_CLI_PATH` in `.env` to the codex binary's full
  path. On Windows the bot resolves the `codex.cmd` shim automatically.
- **`codex-tg: command not found`** — ensure your global npm bin dir is on
  `PATH` (`npm bin -g`), or use `npx codex-telegram-bot <command>`.
- **Transient / rate-limit errors** — the bot auto-retries with backoff
  (6s → 60s) and shows the real error; switch model with the 🧩 menu or
  `/model <id>` if a model stays busy.
