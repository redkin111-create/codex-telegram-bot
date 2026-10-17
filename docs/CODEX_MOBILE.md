# Codex Mobile

Codex Mobile is a browser client for the Codex runtime already owned by this
project. It must remain independent of Telegram Mini App authentication and
must not start a second `codex app-server` process.

## Architecture

- `src/index.ts` remains the owner of the one `AcpClient` and `RuntimeRegistry`.
  Mobile is an opt-in service wired into that existing process.
- The HTTP service binds only to `127.0.0.1` on a port separate from the
  Telegram Mini App's 3301. It has no public listener and does not configure
  Tailscale. A future private Serve setup must be reviewed separately.
- A phone is paired by a one-time code which must be approved from a local
  Windows CLI/control channel. A reverse proxy's loopback `remoteAddress` is
  never treated as proof that a request came from the laptop.
- Device sessions use opaque HttpOnly, Secure, SameSite cookies. API and SSE
  requests re-check the device, owner, project and session. Mutations require
  an allowed Origin and CSRF token. Devices can be listed and revoked.
- Mobile delegates Codex operations to the existing `MiniAppAgent`,
  `TmaLiveFeed`, `AcpClient` and `RuntimeRegistry`; it does not reimplement
  session ownership or run another Codex runtime.
- The app is a separate React/Tailwind package. Text, Markdown, tool output,
  diffs and filenames are treated as untrusted; screenshots are loaded only
  through the existing session-authorized image lookup.
- Persistent auth state uses the project's local data directory and atomic
  file storage; no database, cloud service or paid service is introduced.

## Desktop capability map

Desktop parity is the goal; this branch is still a partial implementation.
The work completed so far is the secure connection and the first conversation
controls. Do not describe the current app as a full Desktop replacement.

| Desktop area | Current mobile coverage | Remaining for parity |
| --- | --- | --- |
| Projects, sessions, history, live status and screenshots | Browse projects and sessions, read history, tool output and authorized screenshots; reconnect the event stream | Search/paging parity, richer live task details and all Desktop session actions |
| Prompting and queue | Send text/images, stop, queue, resume and remove queued prompts | Desktop-equivalent attachment types, edit/retry behavior and turn controls |
| Approvals | Owner-scoped phone cards for the active session; allow/deny choices are checked server-side; no phone response falls back to Telegram after 45 seconds | More approval cases and parity checks for supported Codex builds |
| Files and edits | Browse the authorized session folder, create text files in existing folders, read UTF-8 text, edit/save up to 512 KB with stale-file detection; hides common secret folders/files, skips symlinks and blocks writes while the connected Codex session is busy | Image/binary preview, full diff/review UI and Desktop-equivalent file-change navigation |
| Terminal and Git | Read-only Git branch/status and staged/unstaged diff; commands avoid external diff/textconv and cap output | Terminal/process controls and Git stage/unstage/commit/branch actions |
| Models and modes | Choose a model, collaboration mode and reasoning level for a connected session | Verify error/rollback behavior across supported Codex versions |
| Skills, MCP and subagents | Safe inventory view; only subagents owned by the paired user | Run/manage integrations and settings where the existing runtime supports it |
| Usage and account | Current account identity and quota windows, when ACP exposes them | Saved-account management, account switching, refresh/error states and parity checks |
| Apps, plugins, tasks and voice | Not implemented | Inventory/control surfaces, task management and browser voice input/output |

New UI behavior is checked in Browser skill against the isolated fake Codex
fixture. That proves the web flow and authorization boundary, not compatibility
with every installed Codex Desktop build. Keep the remaining rows visible until
they have both server-side authorization tests and browser coverage.

## Verification checkpoint (2026-10-18)

- Root TypeScript check: passed.
- Mobile app TypeScript check and production build: passed.
- Full root test suite: 165/165 passed after the create-file change.
- Focused agent/server checks: 19/19 passed.
- Mobile app `npm audit`: 0 vulnerabilities.
- Root production dependency audit: one low-severity advisory remains in the
  existing `diff` dependency; this branch did not upgrade it because npm only
  offered a major-version change in the audit report.
- Browser skill at 412×915: pairing, conversation/history, safe Markdown,
  tool output, screenshots, settings, approvals, file browser/editor, device
  revocation, Git status/diff, new file creation, save, duplicate-name rejection
  and file-list refresh were exercised against fake data.
- No actual Codex service was started; no Tailscale or Telegram configuration
  was changed.

## Safety limits

- Do not change the Telegram bot's startup behavior, its autostart, Funnel,
  port 3301, existing sessions, or current Tailscale configuration.
- Do not start the new service on the user's laptop during development.
- Do not add public routes or trust forwarded client IP headers.
- Do not render untrusted HTML or execute content from Codex, tools or files.
- Do not claim a turn completed unless the existing runtime confirms it; show
  an unknown status when completion cannot be established.

## Android private connection (planned, not configured)

1. Keep the service disabled while developing; verify pairing, revocation and
   file/session access locally against test fixtures.
2. Before any private-network setup, inspect the current Tailscale Serve/Funnel
   routes and choose a separate HTTPS port. Preserve Funnel 443 and Mini App
   port 3301 exactly as they are.
3. Configure only a private Tailscale Serve route to the loopback mobile port,
   and set `CODEX_MOBILE_ORIGINS` to the exact Android-facing HTTPS origin.
   Do not enable Funnel or trust forwarded IP/host headers as authentication.
4. Pair the Android device with the local CLI, confirm CSRF/origin checks,
   session isolation and revocation over the tailnet, then enable the opt-in
   service. Keep rollback as disabling `CODEX_MOBILE_ENABLED` and removing only
   the future private Serve route.

No Tailscale configuration has been read or changed by this implementation.
