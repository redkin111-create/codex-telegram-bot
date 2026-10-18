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
| Projects, sessions, history, live status and screenshots | Browse projects and sessions, read history, tool output and authorized screenshots; reconnect the event stream; rename, archive, restore and fork sessions; native Codex search reaches older active or archived sessions with cursor paging and owner filtering; unfiltered active/archive lists continue in 100-session pages scoped to the selected project and owner | Richer live task details, pinning, side-chat and remaining Desktop session actions |
| Prompting and queue | Send text/images, stop, queue, resume and remove queued prompts; steer a confirmed active turn | Desktop-equivalent attachment types, edit/retry behavior and remaining turn controls |
| Approvals | Owner-scoped phone cards for the active session; allow/deny choices are checked server-side; no phone response falls back to Telegram after 45 seconds | More approval cases and parity checks for supported Codex builds |
| Files and edits | Browse the authorized session folder, create text files in existing folders, read UTF-8 text, edit/save up to 512 KB with stale-file detection; safely preview PNG/JPEG/WebP/GIF up to 3 MiB after path, owner and file-signature checks; hides common secret folders/files, skips symlinks and blocks writes while the connected Codex session is busy; start Codex's native inline reviewer against uncommitted changes, a base branch, a commit or custom instructions, with a phone confirmation | Other binary formats, full diff/review UI and Desktop-equivalent file-change navigation |
| Terminal and Git | Interactive PTY shell in the authorized project folder with an explicit start warning, same-shell reattachment after closing/reopening the panel, bounded scrollback, input, resize, stop and 30-minute idle cleanup; retain the one-shot command mode with a 60-second timeout and bounded text output; Git branch/status, staged/unstaged diff and per-file diff review (including renames); stage/unstage one reported project path, commit staged changes, list local branches, create a branch, switch to an existing local branch, create an isolated worktree plus Codex session from the current commit, and track an already-fetched remote branch locally; fetch from a configured safe remote, and push only the current branch after a phone confirmation | Background-process lifecycle outside the interactive shell, conflict resolution, inline review comments and richer Desktop-equivalent review actions |
| Models, modes, goals and context | Choose a model, collaboration mode and reasoning level; view, create, pause, resume and clear Codex goals; request manual context compaction while idle | Verify error/rollback behavior across supported Codex versions; show a final compacted status only when Codex confirms it |
| Skills, MCP, subagents, plugins and apps | Owner-scoped inventories; shows enabled and disabled skills; toggles uniquely named user/repo skills through Codex's `skills/config/write` and uses Codex's effective-state response; system/admin skills are read-only; selects an enabled skill in the composer and sends the native `$skill-name` marker plus Codex's explicit `skill` input item; skill paths are resolved from Codex and never sent to the browser; shows the selected thread's MCP connection/auth state, counts, and safe tool names/descriptions while omitting endpoints, input schemas and raw errors; lists Codex plugins and connected apps; installs/removes only remote plugins the live Codex catalog marks available, with a phone confirmation; offers only HTTPS app-authorization links and shows their host | Enable/disable existing plugins, manage arbitrary/local marketplaces, finish every provider OAuth flow in-browser, invoke/manage MCP integrations |
| Usage and account | Current account identity and quota windows, when ACP exposes them | Saved-account management, account switching, refresh/error states and parity checks |
| Tasks and voice | Goals are supported as noted above; plugin and app catalog coverage is described above | Desktop task lifecycle, voice input/output and parity checks |
| Host and workspace setup | Connects only to the one existing local runtime and its authorized projects; can create an isolated worktree for a coding task | Host selection, environment setup and workspace-specific permissions |

New UI behavior is checked in Browser skill against the isolated fake Codex
fixture. That proves the web flow and authorization boundary, not compatibility
with every installed Codex Desktop build. Keep the remaining rows visible until
they have both server-side authorization tests and browser coverage.

## Verification checkpoint (2026-10-18)

- Root TypeScript check: passed.
- Mobile app TypeScript check and production build: passed.
- Current full root test suite: 215/215 passed, including plugin/app redaction, live ACP install/uninstall checks, paired-session/CSRF checks, isolated worktree attach/rollback, owner-filtered native search and unfiltered active/archive session paging, owner-checked native review start and busy-turn rejection, bounded one-shot and interactive terminal checks, local tracking of an already-fetched remote branch, confirmed remote fetch/current-branch push with URL redaction and owner/CSRF/Origin checks, bounded/signature-checked project image reads, Codex skill enable/disable authorization and explicit skill input resolution, and thread-scoped MCP pagination/redaction.
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
- Browser skill with Pixel 7 emulation at 412×915: continue the active session
  list across two pages, then continue the archived list and verify older
  records appear and the load control disappears at the end. All data came
  from the isolated browser fixture.
- Browser skill with Pixel 7 emulation at 412×915: connect the fixture session,
  open Git, choose a base branch in the native review dialog, confirm the
  action, and verify the working status and review message in the session.
  The isolated fixture did not start the real Codex runtime.
- Browser skill at 574×637: fork an idle session and view the copied history;
  create a goal with a token budget, pause/resume and clear it; request manual
  context compaction, confirm the action, and verify the UI says the request was
  accepted without claiming that Codex finished. All data came from the isolated
  browser fixture.
- Browser skill at 574×637: browse the fake plugin/app catalog, inspect the
  install confirmation, install and remove a fake remote plugin, and verify the
  returned connection link displays its HTTPS host. No provider page was opened.
  The app link also displayed its host and a warning before leaving the client.
- Browser skill at 574×637: open Git, start worktree creation, review the warning
  that uncommitted files stay in the source session, enter `mobile/browser-check`,
  confirm, verify the new session opens with its isolated folder and branch,
  submit a fake prompt there, and observe the test runtime enter its working
  state. All data came from the fake browser fixture.
- Browser skill at 574×637: search for `legacy`, retrieve older sessions that
  are absent from the first catalogue page, load the next native result page,
  select an old session and verify it opens with the honest unknown status.
  All data came from the fake browser fixture.
- Browser skill at 571×459: open the project terminal, enter a one-shot command,
  verify the exact command in the confirmation dialog, confirm it, and inspect
  the fake exit code and output. The fixture did not execute a host command.
- Browser skill at 571×459: open Git, choose the fixture's already-fetched
  `origin/mobile/feature` ref, create the local tracking branch and verify the
  success state and current-branch label. The fixture did not access a remote.
- Browser skill at 571×637: open the interactive terminal tab, review and cancel
  the shell warning, start the isolated fixture shell, type `echo phone`, see
  its fixture response, switch to and verify the one-shot command confirmation
  and output, stop the PTY, then close and reopen the panel and reattach to the
  same fake shell after reloading the latest production bundle. The fixture did
  not execute a host command.
- Browser skill at 571×459: browse into the fixture's `assets/` folder, open
  `preview.png`, verify the image element and safe-raster notice appear without
  an error, then return to the file list. The HTTP test also verifies owner
  authorization and rejects active SVG content from a faulty agent response.
- Browser skill at 574×637: enable and disable a user-scope fixture skill,
  confirm the warning before each write, verify its status and next action
  update, and confirm an admin-scope skill has no toggle. The fake Codex fixture
  handled the changes; no real skill files or Codex settings were changed.
- Browser skill at 574×637: open the skill picker, verify disabled skills are
  omitted, select the enabled fixture skill, confirm its `$fixture-review`
  marker appears in the composer, submit a task, refresh and verify the same
  marker in the recorded user message; then direct the active fake task with the
  same selected skill and verify the direction appears in history. The fake
  runtime accepted these requests; no real Codex turn was started. The skill
  description's `<script>` text is escaped in the rendered HTML.
- Browser skill at 574×637: open settings, inspect the fixture MCP server's
  connection and OAuth status, expand its tool list, and verify an untrusted
  `<script>` description is rendered as escaped text. The fixture's endpoints,
  schemas and raw errors are absent from the mobile HTML.
- Browser skill at 574×637: open Git, cancel a fetch confirmation, review the
  displayed remote before confirming a fixture fetch, then review the host and
  current branch before confirming a fixture push. Both actions return their
  success state; the fixture does not access a real remote repository.
- Mobile skill updates are tested against Codex's native `skills/config/write`
  request. The app-server protocol exposes that method and returns
  `effectiveEnabled`; see the [request declaration](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/common.rs)
  and [skill config types](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/plugin.rs).
- Explicit skill selection uses Codex's native `skill` input item; its `name`
  and `SKILL.md` path stay in the local server-to-Codex request. See the
  [Codex protocol input types](https://github.com/openai/codex/blob/main/codex-rs/docs/protocol_v1.md#userinput-items).
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
