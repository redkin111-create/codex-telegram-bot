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
- Live voice delegates to Codex's experimental `thread/realtime/*` app-server
  protocol. The phone opens WebRTC only after an explicit microphone action;
  audio travels through WebRTC and does not pass through the mobile HTTP API.

## Desktop capability map

Desktop parity is the goal; this branch is still a partial implementation.
The user expanded the initial read-only scope to full phone control, so the
mobile app now includes guarded write actions as well. Do not describe it as a
full Desktop replacement while any row below has open work.

| Desktop area | Current mobile coverage | Remaining for parity |
| --- | --- | --- |
| Projects, sessions, history, live status and screenshots | Browse projects and sessions, read history, tool output and authorized screenshots; search the messages and tool output already loaded for the selected session; reconnect the event stream; rename, archive, restore and fork sessions; permanently delete only an owned archived session through Codex app-server after a mobile confirmation, while blocking controlled sessions, active turns, queues and live project terminals and preserving the session when Codex refuses; native Codex search reaches older active or archived sessions with cursor paging and owner filtering; unfiltered active/archive lists continue in 100-session pages scoped to the selected project and owner; create, rename, delete and filter custom thread sections; move sessions into or out of sections; pin and unpin with Codex's built-in Pinned section through native `thread/section/move`; create an owner-scoped ephemeral side chat while a parent task runs, send a separate prompt and return to its parent; show it only while the shared Codex process is live and disable archive/pin/rename actions; stream the current turn plan, explanation and step status from Codex | Other live task details and remaining Desktop session actions |
| Prompting and queue | Send text/images and text/code/PDF/ZIP attachments (10 MiB per file, five files per prompt; PDF/ZIP signatures checked; text capped at 200,000 characters); remove pending uploads; stop, queue, resume and remove queued prompts; steer a confirmed active turn; edit/retry any of the 20 most recent idle text-only user turns through Codex's `thread/revert` and the shared runtime, preserving selected skills and rejecting a changed latest-turn snapshot; record or select audio and transcribe it through the already configured STT endpoint, placing the result in the draft without sending it | Editing requests that contain attachments and remaining turn controls; a history edit does not roll back files or commands |
| Approvals | Owner-scoped phone cards for the active session; allow/deny choices are checked server-side; no phone response falls back to Telegram after 45 seconds | More approval cases and parity checks for supported Codex builds |
| Files and edits | Browse the authorized session folder, create text files in existing folders, read UTF-8 text, edit/save up to 512 KB with stale-file detection; safely preview PNG/JPEG/WebP/GIF up to 3 MiB after path, owner and file-signature checks; hides common secret folders/files, skips symlinks and blocks writes while the connected Codex session is busy; read unified diffs with line numbers and distinct added/removed lines; start Codex's native inline reviewer against uncommitted changes, a base branch, a commit or custom instructions, with a phone confirmation | Other binary formats, inline review comments and Desktop-equivalent file-change navigation |
| Terminal and Git | Interactive PTY shell in the authorized project folder with an explicit start warning, same-shell reattachment after closing/reopening the panel, bounded scrollback, input, resize, stop and 30-minute idle cleanup; retain the one-shot command mode with a 60-second timeout and bounded text output; list Codex background processes for the selected thread and stop one only after a phone confirmation and fresh thread-scoped Codex check; Git branch/status, staged/unstaged diff with line-numbered added/removed hunks, and per-file diff review (including renames); stage/unstage one reported project path, commit staged changes, list local branches, create a branch, switch to an existing local branch, create an isolated worktree plus Codex session from the current commit, and track an already-fetched remote branch locally; fetch from a configured safe remote, and push only the current branch after a phone confirmation | Conflict resolution, inline review comments and richer Desktop-equivalent review actions |
| Models, modes, goals and context | Choose a model, collaboration mode and reasoning level; view, create, pause, resume and clear Codex goals; request manual context compaction while idle | Verify error/rollback behavior across supported Codex versions; show a final compacted status only when Codex confirms it |
| Skills, MCP, subagents, plugins and apps | Owner-scoped inventories; shows enabled and disabled skills; toggles uniquely named user/repo skills through Codex's `skills/config/write` and uses Codex's effective-state response; system/admin skills are read-only; selects an enabled skill in the composer and sends the native `$skill-name` marker plus Codex's explicit `skill` input item; skill paths are resolved from Codex and never sent to the browser; shows the selected thread's MCP connection/auth state, counts, safe tool names/descriptions, and a bounded allowlisted JSON-schema subset without defaults, examples or extension metadata; starts Codex's native OAuth flow only for a configured MCP server that currently needs login, exposes only HTTPS authorization links with the provider host, and can refresh the connection state; invokes one tool from a currently connected MCP server after displaying its exact JSON arguments for phone confirmation, rechecking the owner, archive/busy/queue state and live server/tool inventory, and returning bounded text/structured JSON only; lists static MCP resources and simple named URI templates through opaque expiring references, collects bounded text parameters on the phone, resolves and revalidates the URI template on the laptop, and renders bounded plain text (raw resource URIs, binary content and metadata stay out of the browser); lists configured MCP names and safe scope/transport fields, toggles the existing project/global setting through the TOML-preserving Codex config writer, rejects unsafe names and workspace config paths outside the selected project, and requires a separate confirmation to restart the shared ACP only when no active or queued work remains; lists Codex plugins and connected apps; installs/removes only remote plugins the live Codex catalog marks available, with a phone confirmation; lists registered marketplaces without exposing local paths, and adds GitHub HTTPS repositories (or `owner/repo` shorthand), upgrades or removes only live Codex-managed entries after confirmation and idle checks; offers only HTTPS app-authorization links and shows their host | MCP prompts and resource subscriptions (the Codex app-server does not expose prompt list/read methods); complete every OAuth callback from Android (the callback must be reachable on the laptop through the future private connection); surface all sign-in outcomes; cover connected apps that Codex does not expose as MCP tools |
| Usage and account | Current account identity and quota windows, when ACP exposes them; manually refresh the current snapshot, retain the last good values, and show refresh errors; list, save, rename and forget local saved accounts; toggle existing auto-rotation; switch the shared Codex login only after phone confirmation and server checks that no ACP turn, controller prompt or queued request is pending; preserve the current login before switching and reuse the existing rotator/restart path; credential fingerprints and auth files never reach the browser | Sign-in/import flows that need a laptop browser or terminal; account switching still restarts the shared Codex app-server and affects every session; parity checks across supported Desktop versions |
| Tasks and voice | Goals are supported as noted above; plugin and app catalog coverage is described above; mobile audio transcription reuses the project's configured STT service and is owner/session/CSRF checked, validates file signatures and caps audio at 5 MiB; experimental native Codex WebRTC voice starts and stops on the selected owned idle thread, lets the user select a voice from the current Codex voice inventory (the choice is rechecked before start), requests microphone access only after a tap, plays remote audio, shows completed user/assistant transcripts on the authenticated event stream, and releases the phone microphone when Codex reports voice closure or error | Verify against supported Codex app-server versions, account entitlements and real Android network/audio; Desktop voice settings, interruption, reconnect and handoff parity |
| Host and workspace setup | Connects only to the one existing local runtime and its authorized projects; can create an isolated worktree for a coding task | Host selection, environment setup and workspace-specific permissions |

Codex currently accepts a per-thread `disabledPluginIds` setting, but the app-server protocol says this does not yet filter plugin capabilities. The mobile client does not present it as a working plugin disable switch until Codex enforces it. See the [official app-server protocol notes](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#thread-plugin-settings).

Codex labels `thread/realtime/*` as experimental in the
[official protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/realtime.rs).
The phone uses the existing app-server process for SDP negotiation; the Browser
skill run uses fake media and a fake peer connection, so it verifies the mobile
flow but does not verify Live support for the installed Codex build or a real
Android network.

MCP OAuth completion notifications are shown only in the thread supplied by
Codex. The browser receives the configured server name and success/failure
label; provider error text is discarded.

New UI behavior is checked in Browser skill against the isolated fake Codex
fixture. That proves the web flow and authorization boundary, not compatibility
with every installed Codex Desktop build. Keep the remaining rows visible until
they have both server-side authorization tests and browser coverage.

History editing reads up to 20 recent user turns from Codex's native
`thread/turns/list` result, excludes turns with attachments or unconfirmed
statuses, rechecks the selected turn and latest-turn snapshot before mutation,
and uses `thread/revert` with `beforeTurnId`; see the
[Codex turn-list schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadTurnsListParams.ts)
and [revert schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadRevertParams.ts).
Requests with non-text input are rejected for editing rather than silently
losing attachments.

## Verification checkpoint (2026-10-18)

- Root TypeScript check: passed.
- Mobile app TypeScript check and production build: passed.
- Current full root test suite: 284/284 passed, including plugin/app redaction, native MCP OAuth URL validation, bounded MCP schema sanitization, live connected tool/server/resource/template revalidation, safe text-only tool/resource result normalization and owner/thread/idle/queue restrictions, paired-device/Origin/CSRF checks, mobile account ownership and credential redaction, account save/rename/forget/switch/auto-rotation, active-turn and queued-work switch guards, mobile file attachment ownership, signature and upload bounds, shared-runtime attachment delivery, recent-turn parsing and stale latest-turn rejection, shared-runtime earlier-turn edit and retry, live ACP install/uninstall checks, isolated worktree attach/rollback, owner-filtered native search and active/archive paging, owner-checked native review start and busy-turn rejection, unified-diff parsing and line numbering, bounded one-shot and interactive terminal checks, thread-scoped background process list/termination and explicit Codex termination confirmation, remote fetch/current-branch push authorization, image path/signature checks, skill enable/disable authorization and explicit skill input resolution, thread-scoped MCP pagination/redaction, MCP config secret redaction and workspace boundary checks, owner/CSRF checks for MCP changes and guarded shared-runtime restart, GitHub-only marketplace source validation and managed-entry checks, latest-turn stale-status and attachment rejection, edit/retry journal replay, audio type/signature/size/owner/STT-error handling, voice SDP validation and provider-error redaction, real-time voice owner/idle/queue restrictions, transcript sanitization, and owned archived-session deletion checks for runtime, queue, cross-client, terminal, offline and Codex-error cases; current-turn plan forwarding and bounded client SSE plan parsing.
- Focused branch-list/switch and API authorization checks: 2/2 passed.
- Per-file Git diff filtering validates paths inside the authorized project and passes both names for a selected rename.
- Mobile app `npm audit`: 0 vulnerabilities.
- Mobile voice transcription uses the existing `SttService`; it is unavailable
  until `STT_API_URL` is configured. The endpoint receives the audio, while the
  phone receives only the transcript. Provider errors are reduced to a generic
  message before they reach the browser.
- Root production dependency audit: one low-severity advisory remains in the
  existing `diff` dependency (GHSA-73rr-hh4g-fpgx); npm only offers a breaking
  major-version upgrade, so this feature branch leaves it unchanged.
- Browser skill at 412×915: pairing, conversation/history, safe Markdown,
  tool output, screenshots, settings, approvals, file browser/editor, device
  revocation, Git status/diff, new file creation, save, duplicate-name rejection,
  file-list refresh, stage/unstage, commit, branch creation, switching to an
  existing local branch, per-file diff, rename diff and return to all files were
  exercised against fake data.
- Browser skill with Pixel 7 emulation at 412×915: read the fixture account
  list, save the current login, toggle auto-rotation, rename a saved account,
  confirm and complete an account switch, and confirm deletion of a saved copy.
  The fixture contained no real login or Codex credentials.
- Browser skill with Pixel 7 emulation at 412×915: reject a non-GitHub HTTPS
  marketplace source, add the fixture GitHub shorthand after confirmation,
  upgrade a managed fixture marketplace and verify its plugin count, then
  remove the fixture marketplace and verify its row disappears. The fixture
  did not contact GitHub or change real Codex settings.
- Browser skill at 574×637 this turn: rename an active session, archive it,
  read its archived history, restore it and return to the active view. All data
  came from the isolated browser fixture.
- Browser skill with Pixel 7 emulation at 412×915: continue the active session
  list across two pages, then continue the archived list and verify older
  records appear and the load control disappears at the end. All data came
  from the isolated browser fixture.
- Browser skill with Pixel 7 emulation at 412×915: cancel an archived-session
  deletion, simulate a Codex refusal and verify the reason stays in the dialog,
  then retry and confirm the fixture session disappears. No real session was
  deleted.
- Browser skill with Pixel 7 emulation at 412×915: pin a session into Codex's
  built-in Pinned section, filter to pinned sessions and unpin it; create and
  rename a custom section, move a session into it, filter and clear its section;
  cancel section deletion, show a simulated Codex refusal without removing the
  section, then retry successfully. All data came from the isolated fixture.
- Browser skill at 574×637 after the section compatibility guard: an unsupported
  fake Codex API displays a clear status and disables section filtering,
  management, membership and pinning. With the supported fake API, create and
  rename still work; pinning, filtering and unpinning also work, and the pinned
  filter updates to zero sessions. No real Codex session was changed.
- Browser skill at 574×637: refresh account and quota data successfully, force a
  one-time capability read error and verify the previous values remain visible
  with an error, then retry and verify the error clears and the check time moves
  forward. All data came from the isolated fake runtime.
- Browser skill at 574×637: search loaded history for one assistant message,
  verify only that message remains, search for a missing phrase and verify the
  empty state, clear it, then close the search toggle with a matching query and
  verify the full history returns. All data came from the isolated fake runtime.
- Browser skill with Pixel 7 emulation at 412×915: start MCP OAuth for the
  fixture server, verify only its HTTPS provider link is offered, then refresh
  and confirm the status changes to connected. The provider link was not opened.
- Browser skill with Pixel 7 emulation at 412×915: inspect the fixture MCP
  schema, reject invalid JSON inside the confirmation dialog, cancel once, then
  confirm exact JSON arguments and verify a `<script>` result stays inert text.
  The fixture never contacted an external MCP service.
- Browser skill with Pixel 7 emulation at 412×915: inspect fake project/global
  MCP settings, cancel a change, disable the project server, confirm the shared
  Codex restart warning and apply it, then enable the global fixture server and
  verify the pending-restart notice. The fixture contained no commands or
  credentials and never started a Codex process.
- Browser skill with Pixel 7 emulation at 412×915: connect the fixture session,
  open Git, choose a base branch in the native review dialog, confirm the
  action, and verify the working status and review message in the session.
  The isolated fixture did not start the real Codex runtime.
- Browser skill with Pixel 7 emulation at 412×915: upload and remove a text
  attachment, reject an unsupported `.exe`, then send a text file and a
  signature-valid PDF with a prompt and verify both reach fake session history.
  The browser fixture did not start Codex or access real project files.
- Browser skill with Pixel 7 emulation at 412×915: select the second-most-recent
  text request, replace it, and verify the newer fake history is removed; add a
  newer turn from the fixture while a draft is open and verify the stale edit is
  rejected without losing the draft; mark the newest request as attachment
  bearing and verify it is disabled while an earlier text request stays
  editable. No real Codex turn was started.
- Browser skill with Pixel 7 emulation at 412×915: open Git, read the whole
  fixture patch with add/remove colors and line references, select `src/main.ts`
  and verify the per-file diff and old/new line numbers. No host Git command ran.
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
- Browser skill at 574×637: open the terminal, list and refresh a fixture
  background process, cancel its stop confirmation, then confirm stopping it
  and verify the empty state and success notice. In a separate run, simulate a
  Codex connection error, verify stale stop controls disappear, restore the
  fixture and refresh the process list. Codex's explicit positive termination
  response is required; an absent or negative response remains an error. The
  fixture did not start or stop a host process.
- Latest edit/retry was also checked through ACP/server tests: only a confirmed
  terminal turn is editable, stale turns, unknown statuses, active Codex turns,
  foreign sessions and repeated request IDs are rejected or replayed safely.
- Browser skill at 574×637: open the latest-request editor, cancel it without
  changing history, verify an attachment-bearing request is blocked, preserve
  the draft after a simulated Codex error, then retry successfully and verify
  the fake history contains the replacement prompt. The fixture did not call
  Codex or change files.
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
- Browser skill with Pixel 7 emulation at 412×915: start the fixture MCP OAuth
  flow without opening its provider page, refresh the inventory, cancel a
  resource read, then confirm it and verify the response (including an
  `<img onerror>` test string) appears only as inert text. No external MCP
  server was contacted.
- Browser skill at 574×637: start the fixture MCP OAuth flow and verify its
  completion appears in the selected session's live activity feed. The browser
  fixture did not contact a provider or real Codex runtime.
- Browser skill at 574×637: connect the fixture parent, send a fake request so
  it enters the working state, open a separate side chat without stopping the
  parent, send a side question, see it in side-chat history, confirm archive
  and pin controls are absent, then return to the parent. No real Codex turn
  was started.
- Browser skill with Pixel 7 emulation at 412×915: open a named MCP URI template,
  enter an account id, review the confirmation without seeing the raw URI, and
  read the fixture report. The returned `<img onerror>` string remains static
  text; no real MCP provider or Codex runtime was contacted.
- Browser skill at 574×637: open Git, cancel a fetch confirmation, review the
  displayed remote before confirming a fixture fetch, then review the host and
  current branch before confirming a fixture push. Both actions return their
  success state; the fixture does not access a real remote repository.
- Browser skill at 574×637: send a signature-valid fake WAV through the mobile
  API and production `MiniAppAgent` with a fake STT adapter; verify the transcript
  appears only in the draft. A spoofed `.wav` is rejected by the server, an
  upstream STT failure is shown generically without losing the draft, and
  unsupported/oversized files are rejected by the mobile client. No real audio,
  Codex runtime or external STT endpoint was used.
- Browser skill at 574×637: connect a second fixture session, select `cedar`
  from its fake Codex voice list, start native-style WebRTC voice with a fake
  microphone and fake peer connection, verify the user and Codex transcripts
  and selected voice in the conversation, then stop and verify the start
  control returns. The fake microphone was requested once; no physical
  microphone, Codex runtime or Live service was contacted.
- Browser skill at 574×637: publish a fake remote voice-closed event while the
  fake microphone is active, verify the phone returns to the start state and
  stops its audio track without a second server stop request.
- Browser skill at 574×637: replay a bounded current-turn plan from the
  authenticated event stream, verify progress labels, and confirm an injected
  `<img ...>` step stays encoded text rather than becoming an HTML element.
  The event came from the isolated fixture, not a live Codex session.
- Mobile skill updates are tested against Codex's native `skills/config/write`
  request. The app-server protocol exposes that method and returns
  `effectiveEnabled`; see the [request declaration](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/common.rs)
  and [skill config types](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/plugin.rs).
- Pinning uses Codex's built-in section identity and native thread section move
  request; it is not a custom user section. See the [Codex state library](https://github.com/openai/codex/blob/main/codex-rs/state/src/lib.rs)
  and [app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/common.rs).
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
