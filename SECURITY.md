# Security Policy

## The security model — read this first

This bot connects Telegram to **Codex CLI running on your machine**. Anyone with authorized access to the bot can make Codex **read/write files and run shell commands** on
the host with your user's permissions. Treat the bot token and host access as
highly sensitive.

### Required hardening

1. **Always set `ALLOWED_USERS`.** With it empty, startup is refused (fail closed). Set it to your own numeric Telegram ID(s).
   Codex Mobile checks this list for existing paired devices too. After changing
   the configuration, restart the service to apply the new list.
2. **Use a private Telegram chat only.** The bot ignores group/channel messages even from allowed user IDs, to keep code and tokens out of shared chats.
3. **Keep `.env` private.** It contains your bot token. It is git-ignored by
   default — never commit it.
4. **Understand `CODEX_TRUST_ALL_TOOLS=true`.** This runs tools without
   confirmation. Set it to `false` if you want Codex to surface permission
   prompts; the bot then auto-declines unknown permission requests.
5. **Scope the workspace.** The bot operates in the project folders you select.
   Only point `PROJECT_ROOTS` at directories you are comfortable exposing.
6. **Run as a non-privileged user.** The provided services install as a *user*
   service (systemd `--user`, launchd LaunchAgent, Windows logon task) — never
   as root/SYSTEM/admin.

### What the bot does NOT do

- Enabled interfaces send conversation output and requested files to authorized
  Telegram chats and paired browsers. Codex CLI contacts its backend; optional
  speech-to-text and MCP integrations contact their configured services.
- The Telegram-only bot does not need an inbound HTTP port. Optional Mini App
  and Codex Mobile services open HTTP listeners on loopback by default.
  A reverse proxy or Tailscale Funnel can make those services reachable from
  the internet; their authentication must remain enabled. `TMA_HOST` can change
  the Mini App listener address, so keep it on loopback when using a local proxy.
- It does not intentionally commit or log `.env` secrets. Codex still has the host user's effective filesystem permissions: review commands and keep secrets outside the workspace.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, open a
private security advisory on the repository, or email the maintainer listed in
`package.json`. We aim to respond within 7 days.

## Supported versions

The latest released version on the default branch receives security fixes.
