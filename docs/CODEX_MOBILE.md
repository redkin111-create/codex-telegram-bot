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
- A phone is paired by a one-time code which the laptop's Windows CLI approves
  over a separate local IPC channel (Windows named pipe or Unix socket). The
  mobile HTTP server has no approval route. A reverse proxy's loopback
  `remoteAddress` is never treated as proof that a request came from the laptop.
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
The user expanded the initial read-only scope to full phone control, so the
mobile app now includes guarded write actions as well. Do not describe it as a
full Desktop replacement while any row below has open work.

| Desktop area | Current mobile coverage | Remaining for parity |
| --- | --- | --- |
| Projects, sessions, history, live status and screenshots | Browse projects and sessions, read history, tool output and authorized screenshots; reconnect the event stream; rename, archive, restore and fork sessions | Search/paging parity, richer live task details, pinning, side-chat and remaining Desktop session actions |
| Prompting and queue | Send text/images, stop, queue, resume and remove queued prompts; steer a confirmed active turn | Desktop-equivalent attachment types, edit/retry behavior and remaining turn controls |
| Approvals | Owner-scoped phone cards for the active session; allow/deny choices are checked server-side; no phone response falls back to Telegram after 45 seconds | More approval cases and parity checks for supported Codex builds |
| Files and edits | Browse the authorized session folder, create text files in existing folders, read UTF-8 text, edit/save up to 512 KB with stale-file detection; hides common secret folders/files, skips symlinks and blocks writes while the connected Codex session is busy | Image/binary preview, full diff/review UI and Desktop-equivalent file-change navigation |
| Terminal and Git | Git branch/status, staged/unstaged diff and per-file diff review (including renames); stage/unstage one reported project path, commit staged changes, list local branches, create a branch and switch to an existing local branch while the Codex session is idle | Terminal/process controls, worktree creation, remote branches, conflict resolution, inline review comments and richer Desktop-equivalent review actions |
| Models, modes, goals and context | Choose a model, collaboration mode and reasoning level; view, create, pause, resume and clear Codex goals; request manual context compaction while idle | Verify error/rollback behavior across supported Codex versions; show a final compacted status only when Codex confirms it |
| Skills, MCP and subagents | Safe inventory view; only subagents owned by the paired user | Invoke/manage skills and integrations, plugin/app management and settings where the existing runtime supports it |
| Usage and account | Current account identity and quota windows, when ACP exposes them | Saved-account management, account switching, refresh/error states and parity checks |
| Apps, plugins, tasks and voice | Goals are supported as noted above | Apps and plugin management, task lifecycle, voice input/output and parity checks |
| Host and workspace setup | Connects only to the one existing local runtime and its authorized projects | Host selection, current branch versus isolated worktree, environment setup and workspace-specific permissions |

New UI behavior is checked in Browser skill against the isolated fake Codex
fixture. That proves the web flow and authorization boundary, not compatibility
with every installed Codex Desktop build. Keep the remaining rows visible until
they have both server-side authorization tests and browser coverage.

## Verification checkpoint (2026-10-18)

- Root TypeScript check: passed.
- Mobile app TypeScript check and production build: passed.
- Full root test suite: 180/180 passed.
- Focused branch-list/switch and API authorization checks: 2/2 passed.
- Per-file Git diff filtering validates paths inside the authorized project and passes both names for a selected rename.
- Mobile app `npm audit`: 0 vulnerabilities.
- Root production dependency audit: one low-severity advisory remains in the
  existing `diff` dependency (GHSA-73rr-hh4g-fpgx); npm only offers a breaking
  major-version upgrade, so this feature branch leaves it unchanged.
- Browser skill at 412×915: pairing, conversation/history, safe Markdown,
  tool output, screenshots, settings, approvals, file browser/editor, device
  revocation, Git status/diff, new file creation, save, duplicate-name rejection,
  file-list refresh, stage/unstage, commit, branch creation, switching to an
  existing local branch, per-file diff, rename diff and return to all files were
  exercised against fake data.
- Browser skill at 574×637 this turn: rename an active session, archive it,
  read its archived history, restore it and return to the active view. All data
  came from the isolated browser fixture.
- Browser skill at 574×637: fork an idle session and view the copied history;
  create a goal with a token budget, pause/resume and clear it; request manual
  context compaction, confirm the action, and verify the UI says the request was
  accepted without claiming that Codex finished. All data came from the isolated
  browser fixture.
- CLI pairing approval is now a separate OS-local IPC channel. The mobile HTTP
  server does not expose an approval endpoint, so a reverse proxy cannot reach
  that operation. Automated tests exercise successful approval, a wrong local
  key, and an unapproved remote HTTP request.
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
