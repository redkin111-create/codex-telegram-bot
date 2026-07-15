# Codex Telegram Bot — a phone-sized control plane for Codex CLI

**Suggested title:** I built a Telegram bridge for OpenAI Codex CLI: live models, MCP, skills, subagents, sessions, diffs, and safe account rotation

**Suggested subreddit:** r/ChatGPTCoding (adapt the title for r/programming or r/selfhosted)

## Post

I wanted to use Codex on my own machine from my phone without exposing a shell,
opening inbound ports, or losing the context of a long coding session. So I built
Codex Telegram Bot, an open-source bridge around the official `codex app-server`
JSON-RPC protocol.

Repository: https://github.com/artickc/codex-telegram-bot

### What it does

- Streams Codex responses into Telegram with Markdown, typing state, tool calls,
  unified diffs, and file summaries.
- Keeps one app-server process for many Telegram chats, projects, and resumable
  rollout sessions.
- Discovers live capabilities from Codex instead of shipping a stale catalog:
  `/models`, `/agents`, `/skills`, and live MCP server/tool/resource status.
- Shows real subagent collaboration activity when Codex delegates work.
- Lets me inspect and toggle MCP servers, run an actual MCP initialize health
  check, and restart Codex to apply config changes.
- Supports photos, albums, documents, voice-to-prompt, queued follow-ups,
  scheduled tasks, and a persistent status panel.
- Stores multiple Codex logins as local `auth.json` snapshots. If Codex reports
  a definitive quota exhaustion, account rotation tries the saved accounts once.
  Switching is serialized across chats, credential writes are atomic, and a
  failed restart restores the exact previous login.
- Runs as a user-level service on Windows, Linux, or macOS and can update global
  npm installs automatically—but only while completely idle.

### Safety model

Telegram access is gated by `ALLOWED_USERS`. The bot runs locally, keeps its
credential snapshots under the bot data directory, never sends `auth.json` to
Telegram, and refuses to interrupt a running turn for an update. Use
`CODEX_TRUST_ALL_TOOLS=false` when you want inline approval prompts instead of
full-auto execution.

### Quick start

```bash
npm install -g codex-telegram-bot
codex-tg setup
# edit ~/.codex/tg/.env: TELEGRAM_BOT_TOKEN=... and ALLOWED_USERS=...
codex-tg install
```

Then open the bot and try `/projects`, `/models`, `/mcp`, `/accounts`, or simply
send a coding prompt. The project has no build step; TypeScript runs through
`tsx` and releases run `npm run typecheck` before publishing.

### Why I made it

The useful part is not “chat with an LLM from Telegram.” It is keeping the
machine-side coding state—sessions, files, MCP, approvals, diffs, and account
limits—visible and controllable from a small, auditable interface.

Feedback is welcome, especially around MCP servers and Codex app-server events
that differ between CLI versions.
