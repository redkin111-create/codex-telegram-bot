# Codex Remote — Telegram Mini App (MVP)

This is an optional mobile client for the existing Telegram Codex bot. Codex
and its credentials stay on your Windows machine; the VPS hosts only a gateway
and a static user interface. Existing Telegram approval prompts and
notifications continue working.

Architecture:
  Telegram Mini App -> HTTPS gateway (VPS) -> outbound long-poll from Windows bot -> Codex app-server.

## VPS setup

Clone this fork on the VPS and run npm ci. Set environment variables:

- TELEGRAM_BOT_TOKEN: the existing Telegram bot token.
- TMA_OWNER_IDS: comma-separated allowed numeric Telegram user IDs.
- TMA_AGENT_TOKEN: a separate random shared secret of at least 32 characters.
- TMA_PORT: 3301 (optional).
- TMA_HOST: 127.0.0.1 (recommended; default).

Run: npm run tma:gateway

Use systemd or another service manager so it restarts automatically.
Put nginx/Caddy in front of port 3301 to provide public HTTPS. Example nginx:

    server {
      listen 443 ssl;
      server_name codex.example.com;
      ssl_certificate /etc/letsencrypt/live/codex.example.com/fullchain.pem;
      ssl_certificate_key /etc/letsencrypt/live/codex.example.com/privkey.pem;
      location / {
        proxy_pass http://127.0.0.1:3301;
        proxy_http_version 1.1;
        proxy_read_timeout 45s;
        proxy_set_header Host $host;
        client_max_body_size 10m;
      }
    }

Never expose the HTTP port directly to the public internet.

## Windows bot setup

Add to the existing Codex Telegram bot configuration in ~/.codex/tg/.env:

    TMA_GATEWAY_URL=https://codex.example.com
    TMA_AGENT_TOKEN=the-same-secret-as-on-the-vps

Restart the installed bot normally. The agent opens an outbound connection
to the gateway; your PC needs no port forwarding or direct external access.

The VPS gateway and Windows bot must both be able to see the same bot token.
The VPS validates Telegram auth by HMAC using TELEGRAM_BOT_TOKEN, while the
Windows bot continues receiving Telegram updates as before.

## Telegram setup

In BotFather configure the bot Menu Button / Mini App URL to:
https://codex.example.com

Open the Mini App from the private chat with the bot. Opening the URL in a
regular browser does not provide signed Telegram initData and cannot access
Codex. The numeric account ID must be present in both TMA_OWNER_IDS on the VPS
and ALLOWED_USERS in the Windows bot configuration.

## Features and limitations

MVP supports:
- Project catalogue and session search
- Full conversation history and screenshots referenced in Codex rollout logs
- Sending prompts, starting a new session in a known project
- Queue inspection, removal and resume, cancelling a bot-owned turn
- Online indicator and responsive Telegram phone layout

Data refreshes roughly every 6 seconds rather than streaming every token.
Source code, auth.json, bot tokens, and API keys are not stored on the VPS.
The gateway retains only short-lived in-memory requests and replies.
Images must exist within the watched project, be referenced in the rollout
log, and be no larger than 3 MB for display inside TMA.

A session with an active writer in Codex Desktop stays read-only. To send
commands from TMA, its current writer must release the session. The app does
not force termination or mutate Codex lock files.

This is NOT yet full Codex Desktop feature parity: advanced diff viewer, live
WebSocket stream, drag-and-drop queue, TMA file uploads, integrated approvals,
and MCP/Skills management will be later stages.

## Security

- The gateway checks Telegram-signed initData on EVERY authorized request.
- Signed data expires after one hour; reopening the TMA obtains fresh initData.
- The gateway allowlists user IDs, the Windows bot separately allowlists IDs.
- RPC operations are allowlisted; there is no arbitrary-shell endpoint.
- Shared agent secret is never sent to Telegram WebView.
- Host only behind HTTPS with a strong shared token.
- Designed for one PC and one gateway replica. Replicated multi-agent
  deployment requires external durable state and agent ownership controls.
