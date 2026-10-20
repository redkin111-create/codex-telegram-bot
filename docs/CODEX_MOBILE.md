# Codex Mobile

Codex Mobile is a browser client for the Codex runtime already owned by this
project. It must remain independent of Telegram Mini App authentication and
must not start a second `codex app-server` process.

## Architecture

- `src/index.ts` remains the owner of the one `AcpClient` and `RuntimeRegistry`.
  Mobile is an opt-in service wired into that existing process.
- The HTTP service binds only to `127.0.0.1` on a port separate from the
  Telegram Mini App's 3301. Tailscale can proxy to it without opening a public
  Node.js listener; its active network exposure is documented below and is
  configured manually, outside the application.
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
- In Mobile, the image lookup also accepts a Browser Skill screenshot saved
  directly in the OS temporary folder when that exact path appears in the
  selected session's rollout, its basename matches `bsk-screenshot-*.png`,
  it is a regular non-symlink PNG with a valid signature, and it is at most
  3 MiB. Other temporary-folder and outside-project images remain unavailable.
- Live tool badges use fixed labels; they do not send command text, search
  queries, tool arguments or absolute laptop paths to the phone. File changes
  can show only the final filename.

When Mobile is enabled, the shared ACP starts with Codex Code Mode enabled so
its installed skills can use the host tools they require. If `CODEX_CLI_PATH`
points to an incomplete Codex install, startup prefers another installed CLI
that includes the companion `codex-code-mode-host` executable. Browser Skill
uses its local `bsk` CLI and connected Chrome extension; Codex's embedded
`cua_repl` browser surface is not forwarded into the mobile page.
If no installed CLI includes the companion executable, Mobile startup fails
with a configuration error instead of accepting chats without local tools.
- Persistent auth state uses the project's local data directory and atomic
  file storage; no database, cloud service or paid service is introduced.
- Voice controls are intentionally omitted from the mobile interface at the
  user's request; chat, terminal, integrations and screenshots define this
  mobile scope.

## Desktop capability map

The requested scope is full phone control for chat, MCP, skills (including browser-skill), plugins, terminal and screenshots; voice and unrelated Desktop areas remain outside this phase. The implementation includes guarded write actions and remains a partial implementation of this requested scope wherever the table below lists open work.

| Desktop area | Current mobile coverage | Remaining for parity |
| --- | --- | --- |
| Projects, sessions, history, live status and screenshots | Browse projects and sessions, read history, tool output and authorized screenshots; keep the quick screenshot index capped at 256 references and load older rollout records through authenticated pages, revalidating workspace images against the session project and Browser Skill Temp images against a narrow filename and signature allowlist; search the selected-session rollout and optional tool output in 100-result pages with a file-revision cursor (records over 16 MiB are reported as skipped); reconnect the event stream; rename, archive, restore and fork sessions; permanently delete only an owned archived session through Codex app-server after a mobile confirmation, while blocking controlled sessions, active turns, queues and live project terminals and preserving the session when Codex refuses; native Codex search reaches older active or archived sessions with cursor paging and owner filtering; unfiltered active/archive lists continue in 100-session pages scoped to the selected project and owner; create, rename, delete and filter custom thread sections; move sessions into or out of sections; pin and unpin with Codex's built-in Pinned section through native `thread/section/move`; create an owner-scoped ephemeral side chat while a parent task runs, send a separate prompt and return to its parent; show it only while the shared Codex process is live and disable archive/pin/rename actions; stream the current turn plan, explanation and step status from Codex; mark eligible sessions read or unread through Codex's native revision-checked receipt API, hiding controls when the runtime does not provide a valid receipt | Other live task details, runtimes without read-state support, and remaining Desktop session actions |
| Prompting and queue | Send text/images and text/code/PDF/ZIP attachments (10 MiB per file, five files per prompt; PDF/ZIP signatures checked; text capped at 200,000 characters); remove pending uploads; stop, queue, resume and remove queued prompts; steer a confirmed active turn; select up to three callable Codex Apps in the composer and pass native `mention` input items after rechecking the exact thread's live app catalog and installed/callable state; edit/retry any of the 20 most recent idle user turns whose text, selected skills, safe Codex App mentions and image inputs Codex exposes in a supported form, preserving validated data images and host-only local-image paths through `thread/revert` and the shared runtime; recheck each selected App before changing history; image bytes, local paths and native `app://` paths never enter browser responses; reject unsupported input items and changed latest-turn snapshots | Unsupported Codex input items (including file-ID attachments and audio); remaining turn controls; a history edit does not roll back files or commands |
| Approvals | Owner-scoped phone cards for the active session; when Codex sends `availableDecisions`, the phone shows only supported advertised choices, including cancel and structured command/network policy amendments with their exact proposed scope; session grants require a second confirmation; unknown decision shapes fail closed; Telegram's existing choices stay unchanged; every choice is checked server-side; no phone response falls back to Telegram after 45 seconds | Compare the exact decision variants with each supported installed Desktop build; older builds without `availableDecisions` keep the existing conservative choices |
| Files and edits | Browse the authorized session folder in pages of 250 entries, create text files and folders, rename files/folders within their current directory, delete files or folders after exact-name phone confirmation (up to 10,000 nested entries; symbolic links are removed without following them), read UTF-8 text, edit/save up to 512 KB with stale-file detection, download regular files up to 10 MiB as inert attachments with owner/path checks; safely preview PNG/JPEG/WebP/GIF up to 3 MiB after path, owner and file-signature checks; hides common secret folders/files, skips symlinks and blocks writes while the connected Codex session is busy; read unified diffs with line numbers and distinct added/removed lines; start Codex's native inline reviewer against uncommitted changes, a base branch, a commit or custom instructions, with a phone confirmation; render standard Codex `::code-comment{...}` findings as safe cards with priority, file, line range and Markdown body; open the reported file's current Git diff and highlight a matching changed/context line | Recursive folder deletion above 10,000 entries; downloads over 10 MiB; binary files cannot be previewed or edited in-app; findings outside the current staged/unstaged diff cannot be jumped to; adding/replying to inline comments (the app-server exposes no comment operation); Desktop-equivalent file-change navigation |
| Terminal and Git | Interactive PTY shell in the authorized project folder with an explicit start warning, same-shell reattachment after closing/reopening the panel, bounded scrollback, input, resize, stop and 30-minute idle cleanup; retain the one-shot command mode with a 60-second timeout and bounded text output; list Codex background processes for the selected thread and stop one only after a phone confirmation and fresh thread-scoped Codex check; Git branch/status (common secret paths are omitted from mobile output), staged/unstaged diff with line-numbered added/removed hunks, and per-file/all-files review for bounded untracked text files and inert binary markers; stage/unstage one reported project path, commit staged changes, list local branches, create a branch, switch to an existing local branch, create an isolated worktree plus Codex session from the current commit, and track an already-fetched remote branch locally; fetch from a configured safe remote, fast-forward-pull only a clean tracked branch after a phone confirmation (diverged branches stop without a merge commit), and push only the current branch after a phone confirmation; identify all seven Git unmerged states; compare bounded UTF-8 base/ours/theirs previews (stacked on phones, columns on wider screens), choose one as the draft or edit a combined result in the inert text editor, and save plus stage it only after the standard conflict markers are removed; for binary or oversized-to-preview conflicts, choose a current regular-file Git stage up to 10 MiB with a stale-file hash check, then atomically replace and stage that project file | Untracked text files over 512 KiB require download or external review; symlink/submodule conflicts, files over 10 MiB, and richer Desktop-equivalent review actions |
| Models, modes, goals and context | Choose a model, collaboration mode and reasoning level on an owned session; persist model, mode and effort through native `thread/settings/update`, read the confirmed model/effort through `thread/read`, and keep the existing chat runtime preference in sync; view, create, pause, resume and clear Codex goals; request manual context compaction while idle; show completion only after Codex emits a completed `contextCompaction` item and show “Статус неизвестен” when no confirmation arrives within 60 seconds | Verify error/rollback behavior across supported Codex versions; Codex `thread/read` does not expose the active collaboration-mode name |
| Skills, MCP, subagents, plugins and apps | Owner-scoped inventories; shows enabled and disabled skills; toggles uniquely named user/repo skills through Codex's `skills/config/write` and uses Codex's effective-state response; system/admin skills are read-only; selects an enabled skill in the composer and sends the native `$skill-name` marker plus Codex's explicit `skill` input item; skill paths are resolved from Codex and never sent to the browser; shows the selected thread's MCP connection/auth state, counts, safe tool names/descriptions, and a bounded allowlisted JSON-schema subset without defaults, examples or extension metadata; starts Codex's native OAuth flow only for a configured MCP server that currently needs login, exposes only HTTPS authorization links with the provider host, and can refresh the connection state; invokes one tool from a currently connected MCP server after displaying its exact JSON arguments for phone confirmation, rechecking the owner, archive/busy/queue state and live server/tool inventory, and returning bounded text/structured JSON only; lists static MCP resources and simple named URI templates through opaque expiring references, collects bounded text parameters on the phone, resolves and revalidates the URI template on the laptop, and renders bounded plain text (raw resource URIs, binary content and metadata stay out of the browser); lists configured MCP names and safe scope/transport fields, shows same-name global and workspace entries separately and marks workspace overrides; adds stdio commands with arguments and environment variables, or streamable HTTP servers with a bearer-token environment variable, to the selected project or global config after phone confirmation; enables/disables or removes the exact named entry in the selected scope after revalidating config ownership, scope and safe-write constraints; rejects unsafe names, insecure remote HTTP, credentials in URL authority, duplicate names and workspace config symlink escapes; never returns commands, URLs or secret values after save; requires a separate confirmation to restart the shared ACP only when no active or queued work remains; searches and pages the plugin and app inventories (up to 1,000 entries each) in 20-item settings pages; lists connected apps; selects up to three enabled, accessible and callable apps in the composer and sends native `mention` input items; the server rechecks the selected thread's live app inventory and installed/callable state and never trusts a browser-supplied app path; installs/removes only remote plugins the live Codex catalog marks available, with a phone confirmation; enables/disables only uniquely identified installed plugins through Codex's `config/value/write`, re-reads the effective plugin state and refuses admin-disabled plugins; this changes the global user config and waits for all work to finish; lists registered marketplaces without exposing local paths, and adds GitHub HTTPS repositories (or `owner/repo` shorthand), upgrades or removes only live Codex-managed entries after confirmation and idle checks; offers only HTTPS app-authorization links and shows their host; handles owner-scoped MCP form and HTTPS URL elicitation on the phone, with allowlisted schemas, server-side field validation and no form values or callback URLs in replayable SSE | MCP prompt list/read and resource subscriptions (the Codex app-server does not expose prompt list/read methods); complete Android OAuth through an exact loopback redirect or PAR callback paste-back when the callback socket is confirmed to belong to the active Codex process; providers whose callbacks cannot be confirmed stay laptop-only; verify real-provider outcomes; cover connected apps that Codex does not expose as MCP tools |
| Usage and account | Current account identity and quota windows, when ACP exposes them; manually refresh the current snapshot, retain the last good values, and show refresh errors; list, save, rename and forget local saved accounts; toggle existing auto-rotation; switch the shared Codex login only after phone confirmation and server checks that no ACP turn, controller prompt or queued request is pending; preserve the current login before switching and reuse the existing rotator/restart path; start and cancel Codex native ChatGPT device-code login, validate the official HTTPS authorization origin and one-time code, and reveal the code only while login is pending; serialize login with account rotation and save the current auth snapshot before replacing the shared login; expose only generic provider errors; credential fingerprints and auth files never reach the browser | Other sign-in/import flows that need a laptop browser or terminal; account switching still restarts the shared Codex app-server and affects every session; parity checks across supported Desktop versions |
| Tasks and voice | Goals are supported as noted above; plugin and app catalog coverage is described above; voice controls and audio capture are intentionally not exposed in the mobile interface | Voice parity is outside the requested scope |
| Host and workspace setup | Connects only to the one existing local runtime and its authorized projects; can create an isolated worktree for a coding task | Host selection, environment setup and workspace-specific permissions |

## Readiness for the requested phone workflow

The branch serves the requested chat, MCP, skills, plugins, terminal and
screenshot flows through the existing Codex runtime. The Mobile HTTP listener
stays on `127.0.0.1:3302`; for the current manual session, the public Tailscale
Funnel on HTTPS port `8443` proxies to it. The existing `443` route to port
`3301` is unchanged, and this branch is not registered for autostart.

The Browser Skill was selected in a Mobile-created Codex task and ran through
the laptop's `bsk` CLI and connected Chrome extension. A separate smoke task
opened `example.com`; a Search Console task reached Google's sign-in page, where
Google required the account owner to confirm their identity. That is an account
verification step, not evidence that the Browser Skill or local browser tools
were missing. Actual Android pairing and use still need to be checked on the
owner's phone.

The phone can relay an MCP OAuth callback when Codex exposes one exact loopback
`redirect_uri`, or when its authorization URL uses PAR and the server can verify
that the final pasted callback URL reaches a loopback socket owned by the
running Codex app-server process. The server checks the paired device, Origin,
CSRF token, owned session, callback shape, and visible OAuth state, then forwards
the request once. Codex validates the state and exchanges the code. URLs and
authorization codes are not saved or returned. If the callback listener cannot
be confirmed as Codex-owned, the PAR flow remains laptop-only. Real provider
outcomes still need testing. Plugin install/removal and marketplace management
work; a true per-thread plugin disable switch is not supported by the current
Codex app-server.

The MCP settings panel can also add a local stdio command or a streamable HTTP
server to the selected project's `.codex/config.toml`, or to Codex's global
`config.toml`. The phone confirms the exact local command and arguments, or only
the HTTPS host; it never displays environment values or returns the complete
URL to the browser after saving. Stdio environment values are stored as plain
text in the local Codex config file. Use a bearer-token environment variable
instead of putting credentials in a URL. HTTP is allowed only for loopback
hosts. New entries do not start until the user separately restarts the shared
Codex runtime, after Codex is idle. Android OAuth completion is supported only
for flows with an exposed loopback redirect URI; opaque PAR flows still need a
laptop browser.

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
`thread/turns/list` result. It preserves selected skills, validates image data
and reuses host-only local-image paths without returning image bytes or paths to
the browser. Unknown, oversized, remote-URL and unsupported file-ID/audio input
items remain disabled. It rechecks the selected turn and latest-turn snapshot
before mutation and uses `thread/revert` with `beforeTurnId`; see the
[Codex turn-list schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadTurnsListParams.ts)
and [revert schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadRevertParams.ts).
Requests with unsupported input are rejected for editing rather than silently
losing attachments. Editing still removes the selected turn and later history;
it does not undo file writes, commands or other external effects.

Full-history search scans the selected owned rollout as a stream, so old
messages do not need to be loaded into the chat first. It returns matches in
pages of 100 and uses a revision token to reject older-page requests if the
rollout changed after the first page. Tool output is included only when enabled.
A single JSONL record larger than 16 MiB is skipped and reported in the search
status.

Manual compaction is treated as a request, not proof of completion. Codex's
completed `ContextCompaction` item is the only event that changes the mobile
status to confirmed; if the event is missing for 60 seconds the client reports
an unknown status. The item currently contains only an id, so the phone does not
claim to display the new summary. See the [app-server item schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L421-L423).

## Verification checkpoint (2026-10-19)

- Root TypeScript check: passed.
- Root test suite: 370/370 passed, including mobile CLI fallback to a Codex
  installation with its Code Mode host and preserving permission flags.
- A new empty mobile-created session remains visible only to its owner even
  before Codex adds it to the thread catalogue.
- Installed Codex CLI accepts the Code Mode feature flag, the companion host
  exists beside the selected CLI, and runtime path selection was checked with a
  deliberately incomplete `CODEX_CLI_PATH`.
- Browser Skill was selected and executed through the public mobile page; it
  read the already-open page title through `bsk` without navigation.
- `npm audit` reports one low-severity `diff` advisory for denial of service in
  `parsePatch`/`applyPatch`; npm only offers a fix in breaking `diff@9`. No
  dependency was changed in this repair.

## Verification checkpoint (2026-10-20)

- Root TypeScript check: passed; full root test suite: 421/421 passed.
- Mobile production build and its TypeScript check: passed.
- `npm audit` in `apps/codex-mobile`: 0 known vulnerabilities.
- Current Codex CLI resolution selects an installation with its companion
  Code Mode host; startup rejects an incomplete install when no compatible one
  is available. The reported 2026-10-19 branch failure used a CLI folder that
  lacked the host; the installed `896a…` build now includes it.
- Plugin and app inventories retain up to 1,000 entries. Settings search covers name, ID, marketplace and description, with 20 items per page; the chat app picker also has search. Tests cover 500 plugin entries and 300 app entries, including search beyond the old 80-row UI cap and page 25.
- Browser Skill with Pixel 7 at 412×915 on the public Mobile page: navigated the plugin list to page 2 (20 rows per page) and searched for `gitlab`, which returned one match. No plugin configuration was changed. The already-running server still returns its pre-update 300-item inventory until a safe process restart.
- Browser Skill with Pixel 7 at 412×915: searched for `Canva` in settings and in the chat app picker; each returned the matching app. The app was not selected and no configuration was changed.
- Mobile prompt routing now recognizes a `$skill` marker on its own line after
  introductory text. The Mobile send integration test confirms
  `$browser-skill` reaches the shared runtime as a selected skill; the ACP test
  verifies that Codex resolves it to an explicit skill input using its own
  current inventory. A live Pixel 7 check at 412×915 sent `$browser-skill`
  through the public page into a new shared-runtime session; Codex started a
  BSK session, opened only `https://example.com/`, returned the page title and
  HTTP 200 for the main document, and stopped the BSK session. No files or
  settings were changed.
- Natural-language requests such as “use browser skill” now resolve against
  Codex's live project skill inventory and reach the shared runtime as skill
  selections. Sending stops with a clear error when `browser-skill` is absent
  or disabled, so Codex cannot silently receive the task without that skill.
  Unit tests cover these cases. On the live Pixel 7 page, `$mobile-responsive`
  and `$mobile-ux-optimizer:mobile-ux-optimizer` were also selected in the
  shared runtime; each returned the first three headings from its skill
  instructions without changing project files or settings.
- The failed branch `01a1540b` log records `failed to spawn code-mode host`
  for Codex CLI build `2e5e…` because its companion executable was missing.
  The current Mobile app-server uses build `896a…`, whose companion host is
  present; a live Mobile chat then successfully started BSK and returned the
  actual page title and HTTP 200.
- After loading the current branch, the service listened on `127.0.0.1:3301`
  and `127.0.0.1:3302`; the existing Funnel routes still pointed `443` to
  `3301` and `8443` to `3302`. No Tailscale setting changed.
- Browser skill on the live public Mobile page at Pixel 7 size (412×915): ran
  `Get-Location` from the project terminal and confirmed the Windows path keeps
  Cyrillic characters; ran `cmd /d /c exit 7` and confirmed the UI reports exit
  code 7. Both commands were one-shot and required the page's explicit run
  confirmation.
- Fixed Windows one-shot terminal output encoding and native exit-code
  reporting; added regression tests for both behaviors.
- PAR callback relay is now implemented with an OS check that requires the
  exact loopback socket to belong to the active Codex app-server process. The
  provider's authorization URL and OAuth code stay out of logs and API errors.
- Browser skill on Pixel 7 at 412×915 with the isolated `phone.localhost`
  fixture: started a PAR OAuth login, confirmed the UI disclosed the PAR
  callback limitation and accepted the pasted loopback URL, then saw the fixture
  MCP report “OAuth подключён”. No external provider or Desktop data was used.

## Verification checkpoint (2026-10-18)

- Root TypeScript check: passed.
- Mobile app TypeScript check and production build: passed.
- Current full root test suite: 367/367 passed on 2026-10-18, including clean tracked-branch Git pull, fast-forward-only behavior and exact Origin/CSRF/owner checks, one-time loopback OAuth callback forwarding, and rejection of mismatched state, host, replay, and unsupported PAR callbacks; native mobile thread-settings read/update, default resets, reasoning validation and owner rejection; plugin/app redaction, native MCP OAuth URL validation, bounded MCP schema sanitization, live connected tool/server/resource/template revalidation, safe text-only tool/resource result normalization and owner/thread/idle/queue restrictions, paired-device/Origin/CSRF checks, mobile account ownership and credential redaction, account save/rename/forget/switch/auto-rotation, active-turn and queued-work switch guards, ChatGPT device-code login validation, tracked-login cancellation, shared account-lock serialization and generic provider-error handling; mobile file attachment ownership, signature and upload bounds, shared-runtime attachment delivery, recent-turn parsing and stale latest-turn rejection, shared-runtime earlier-turn edit and retry, safe Codex App mention extraction, generated-token removal and availability checks before history revert, live ACP install/uninstall checks, isolated worktree attach/rollback, owner-filtered native search and active/archive paging, owner-checked native review start and busy-turn rejection, unified-diff parsing and line numbering, bounded one-shot and interactive terminal checks, thread-scoped background process list/termination and explicit Codex termination confirmation, remote fetch/current-branch push authorization, image path/signature checks, skill enable/disable authorization and explicit skill input resolution, Codex App prompt ID merging, exact-thread catalog/install revalidation, safe native mention routing and unavailable/malformed-app rejection, thread-scoped MCP pagination/redaction, MCP config secret redaction and workspace boundary checks, owner/CSRF checks for MCP changes and guarded shared-runtime restart, GitHub-only marketplace source validation and managed-entry checks, latest-turn stale-status and attachment rejection, edit/retry journal replay, audio type/signature/size/owner/STT-error handling, voice SDP validation and provider-error redaction, real-time voice owner/idle/queue restrictions, transcript sanitization, owned archived-session deletion checks for runtime, queue, cross-client, terminal, offline and Codex-error cases, and live tool-label privacy checks for command/search data and absolute paths; full-rollout history search, optional tool-output matching, oversized-record bounds and owner checks; current-turn plan forwarding and bounded client SSE plan parsing; all seven Git conflict status codes, owned-session stage reads and conflict-marker detection; bounded conflict-stage previews without split Unicode surrogate pairs; regular binary Git stage selection with stale-file rejection, owner isolation and stage checks; project folder creation, file and folder rename, file and recursive folder deletion with exact-name confirmation, the 10,000-entry limit, stale-listing checks, symbolic-link target preservation, authenticated 10 MiB regular-file downloads with owner checks and safe attachment headers, and offset validation with multi-page file-list coverage; bounded Codex review-comment parsing, malformed/code-fence/range rejection, start-line-only support, Windows path-separator preservation, completed context-compaction event forwarding with safe mobile SSE parsing, session-scoped approval availability/translation for command, file-change and permission-profile prompts; MCP elicitation protocol routing, bounded form schema/value validation, owner/session/Origin/CSRF checks, HTTPS-only URL handling and redacted replayable SSE; native read-state receipt parsing, revision-conflict handling, and mobile session ownership checks.
- Focused approval checks: 25/25 passed, including exact advertised choices, structured command/network amendment mapping, malformed choice rejection, ownership checks and unchanged Telegram choices.
- Focused branch-list/switch and API authorization checks: 2/2 passed.
- Git status and all-files diff omit common secret paths; integration tests cover a changed tracked `.env` value. Per-file Git diff filtering validates paths inside the authorized project and passes both names for a selected rename. Untracked UTF-8 files up to 512 KiB get a synthetic diff; total untracked diff output is capped at 2 MiB.
- Mobile app `npm audit`: 0 vulnerabilities.
- Root production dependency audit: one low-severity advisory remains in the
  existing `diff` dependency (GHSA-73rr-hh4g-fpgx); npm only offers a breaking
  major-version upgrade, so this feature branch leaves it unchanged.
- Browser skill at 412×915: pairing, conversation/history, safe Markdown,
  tool output, screenshots, settings, one-time and session-scoped approvals
  (including a canceled warning and a confirmed second step), file browser/editor,
  device revocation, Git status/diff, new file creation, save, duplicate-name rejection,
  file-list refresh, stage/unstage, commit, branch creation, switching to an
  existing local branch, per-file diff, rename diff and return to all files were
  exercised against fake data.
- Browser skill at 1416×637: the Codex-advertised session-scoped approval opens
  a second confirmation; going back leaves the request pending, confirming it
  resolves the advertised choice, and a fixture without that choice shows only
  one-time allow and deny. Only the isolated browser fixture was used.
- Browser skill with Pixel 7 emulation at 412×915: display only the four fixture
  choices advertised by Codex, including command and network policy amendments
  with their proposed scope; select the network rule and cancel a separate
  approval. Server tests verify that both structured objects are returned to
  Codex exactly as advertised. The isolated fixture ran no host command and
  changed no real network policy.
- Browser skill at 572×637: inspect a filesystem/network
  permission request and its exact project path, choose session scope, verify
  the second warning says those rights carry into later turns, go back without
  resolving, then confirm and verify the fixture receives the session option.
  No Codex permission was granted to a real project.
- Browser skill with Pixel 7 emulation at 412×915: search for `полный поиск`;
  confirm the first 100 of 101 older fixture matches appear, load the older
  page and verify match `#000` appears, then search for a missing phrase and
  verify the full-history empty state. The fixture used no Codex Desktop data.
- Browser skill with Pixel 7 emulation at 412×915: request context compaction
  in the fixture, confirm the pending label first, then verify only the fixture's
  completed Codex event changes it to a confirmed status. A separate fixture
  without a completion event stays pending and never claims success.
- Browser skill with Pixel 7 emulation at 412×915: create a fixture folder,
  create a nested file, rename the folder, verify a wrong confirmation name keeps
  deletion disabled, then enter its exact name and delete the folder. The
  success notice and refreshed list appeared; the fixture did not change a real
  project.
- Browser skill with Pixel 7 emulation at 412×915: rename a fixture file, confirm
  its deletion, and verify both success notices and the refreshed file list.
  The fixture did not change a real project.
- Browser skill with Pixel 7 emulation at 412×915: download the fixture
  `assets/release.zip`, verify the UI success notice, and compare the captured
  browser download bytes with the fixture payload. The fixture did not read a
  real project or contact Codex Desktop.
- Browser skill with Pixel 7 emulation at 412×915: open a 260-file fixture
  directory, load its second page and verify the count changes to 260 of 260
  with `file-259.txt` present and no further page button. The fake fixture did
  not read or change a real project.
- Browser skill with Pixel 7 emulation at 412×915: receive a live fixture file
  change and verify its short `main.ts` label appears in the session header.
  Shell commands, search text and laptop paths are covered by the live-feed
  unit test and stay out of the browser event.
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
- Browser skill with Pixel 7 emulation at 412×915 from the loopback-only
  `phone.localhost` fixture origin: start MCP OAuth, verify the provider host and
  callback instructions, paste the fixture callback URL, submit it, and confirm
  the server forwards it to the exact loopback listener and the MCP server shows
  connected. The fixture provider and callback were local test doubles; no
  external provider or Codex Desktop data was used.
- Browser skill with Pixel 7 emulation at 412×915 from the loopback-only
  `phone.localhost` fixture origin: run the same OAuth flow with a PAR URL that
  hides `redirect_uri`; verify the PAR-specific warning, paste the callback,
  submit it, and confirm the owned-listener check forwards it and the fixture MCP
  reports connected. No external provider or Codex Desktop data was used.
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
- Browser skill with Pixel 7 emulation at 412×915: select the installed
  `browser-skill` by its real skill name in the fake catalog, add a phone prompt,
  send it and verify the `$browser-skill` marker is recorded by the fixture
  runtime. This tests dispatch wiring only; it does not execute browser actions.
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
- Browser skill at 574×637: replay a bounded current-turn plan from the
  authenticated event stream, verify progress labels, and confirm an injected
  `<img ...>` step stays encoded text rather than becoming an HTML element.
  The event came from the isolated fixture, not a live Codex session.
- Browser skill at 574×637: inspect a fake `UU` file conflict, verify Git's
  direct stage action is hidden and resolution stays disabled while conflict
  markers remain, edit the file as plain text, save and mark it resolved, then
  verify Git reports a staged `M`. No real project file or index changed.
- Browser skill with Pixel 7 emulation at 412×915: open the isolated conflict
  editor, reveal the three version previews, verify an injected `<img ...>` is
  shown as plain text, and apply “Их версия” to the unsaved draft. No file was
  saved in this comparison check; no real Codex runtime was used.
- Browser skill at 574×637: open the isolated conflict editor, choose the
  fixture's “Их версия”, verify the textarea draft changes without executing
  file content, then save and mark the conflict resolved; Git reports a staged
  `M` and the UI confirms the resolution. The phone reads only the selected
  owned path; no real Codex runtime or project was used.
- Browser skill with Pixel 7 emulation at 412×915: open the isolated Git binary
  conflict, choose the fixture's `theirs` stage, confirm the full-file replace,
  and verify the success message and staged `M` after refresh. Only fake fixture
  data was changed; no real Codex runtime, project file or Git index was used.
- Browser skill at 574×637: verify a Codex `::code-comment` renders as a mobile
  review card with priority and file line range; confirm injected `<img>` text
  is HTML-escaped in the card DOM; tap “Открыть diff” and verify the file is
  scoped and its reported line is highlighted. The page used only a local
  fixture.
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
- Codex App selection uses the protocol's native `mention` input item with an
  `app://` target; its app ID is revalidated against `app/list` for the selected
  thread and `app/installed` immediately before sending. The matching `$app-slug`
  comes from Codex's app name. See the [Codex App Server invocation format](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#apps) and [user-input protocol type](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/user_input.rs).
- CLI pairing approval is now a separate OS-local IPC channel. The mobile HTTP
  server does not expose an approval endpoint, so a reverse proxy cannot reach
  that operation. Automated tests exercise successful approval, a wrong local
  key, and an unapproved remote HTTP request.
- Browser skill with Pixel 7 emulation at 412×915: receive an MCP form request; enter required string and password fields, choose an enum value, enter a bounded integer and toggle a boolean; verify the password stays masked and the dangerous <img onerror> description stays inert text. Submit, deny and cancel responses were verified. For a URL request, verify only the HTTPS host is displayed, inspect target="_blank" and rel="noopener noreferrer" without exposing the query, accept and cancel it; the link was never opened.
- Browser skill with Pixel 7 emulation at 412×915: mark an eligible fixture session read, then unread; simulate a Desktop-side receipt revision change and confirm the stale action shows an error, refreshes the displayed receipt and is not retried; a fresh action then succeeds. The fixture used no Codex Desktop data.
- Browser skill with Pixel 7 emulation at 412×915: open history editing for a fixture turn with two attachments, verify the phone says they will be preserved, replace the prompt and confirm the success notice; the isolated fixture did not launch Codex or change Desktop data.
- Browser skill with Pixel 7 emulation at 412×915: open history editing for a fixture request with a Codex App mention, verify the connected-App preservation notice, replace the prompt and verify the safe app token remains in fixture history; the isolated fixture did not launch Codex or change Desktop data.
- Browser skill with Pixel 7 emulation at 412×915: change the selected session's model, collaboration mode and reasoning level, refresh Codex settings, and verify the three selections persist in the isolated fixture; no real Codex data was used.
- Browser skill with Pixel 7 emulation at 412×915: open Git for a fixture branch with a configured upstream, review the fast-forward confirmation, confirm the pull, and verify the completion status; only the isolated fixture was changed.
- Browser skill with Pixel 7 emulation at 412×915: review the warning that phone sign-in changes the shared laptop account and saves the current login; start a fixture ChatGPT device-code flow, verify the one-time code and `auth.openai.com` host, cancel it, start again and confirm the generic failure UI without provider details, then start a third flow and observe Codex-confirmed success. The isolated fixture did not open the provider page or change a real account.
- Browser skill with Pixel 7 emulation at 412×915: select a callable fixture Codex App, send a prompt, and verify the app token appears in the isolated history; reopen the picker after the responsive toolbar adjustment and confirm the selected app chip and usable prompt field. The fixture ran no real Codex runtime or app integration.
- Browser skill with Pixel 7 emulation at 412×915: select `$browser-skill` from the fixture skill picker, send it in a prompt, and verify the selection and reply in the isolated history. This verified the mobile UI wiring only; the fixture did not run a browser task.
- Browser skill with Pixel 7 emulation at 412×915: show the newest 256 fixture screenshots plus older history pages, navigate all 400 across six pages, verify no more than 80 thumbnail buttons are in the page at once, move between older/newer pages, and open the oldest `sample.png`. This keeps Browser skill observations responsive while preserving access to every screenshot. The production quick index retains up to 256 references; older pages scan the owned session log in bounded chunks and validate each image before returning it.
- In a fresh Browser skill run with the synthetic 320×180 PNG fixture, browse all 400 screenshots across six pages and open `sample.png`; both the thumbnail and viewer decode at 320×180, and the Pixel 7 capture shows the full frame without cropping.
- Browser skill with Pixel 7 emulation at 412×915 on the isolated local fixture: open `capture-321.png`; the modal shows the image decoded within the viewport. The Mobile-only Browser Skill Temp path rule and Telegram's project-only rule are covered by the screenshot tests; the live shared runtime was not restarted because its paused queue still contains two prompts.
- Browser skill with Pixel 7 emulation at 412×915: start fixture MCP OAuth, verify the provider host before the sign-in link is offered, then verify Codex reports the connection. Install and remove a fixture plugin through their confirmation dialogs. The provider link was not opened and the fixture changed no real Codex settings.
- Browser skill with Pixel 7 emulation at 412×915 on the phone.localhost fixture origin: paste a fake OAuth callback, submit it, and verify the app shows connected. The server forwarded it only to the fixture's exact local callback listener; this did not contact an OAuth provider or real Codex runtime.
- Browser skill with Pixel 7 emulation at 412×915: open an interactive fixture terminal, send `echo phone`, verify the fixture output, stop the terminal, then run `echo mobile-test` in one-command mode and verify exit code 0. The fixture did not start a host shell or execute commands on the laptop.
- Browser skill with Pixel 7 emulation at 412×915: refresh the fixture MCP connection after its OAuth response, open the tool list, confirm `{"query":"mobile status"}` for `read_status`, and verify its result. A returned `<script>` was escaped in the result card and created no script element. The fixture made no external MCP request.
- Browser skill with Pixel 7 emulation at 412×915: reopen the interactive fixture terminal after the CSP change, send `echo phone`, confirm the output in the terminal screenshot, and stop the session. The new capture recorded no xterm CSP violation; the fixture did not run a host shell.
- Browser skill with Pixel 7 emulation at 412×915: while a fixture Codex task was busy, verify the Git review button and dialog submit were disabled; stop the fixture task, run review while idle, and confirm the fixture response. The busy guard was also covered by a unit test.
- Browser skill with Pixel 7 emulation at 412×915: inspect the fixture's untracked text file both from its per-file action and the all-files diff; verify the added line and filename render as inert diff text. The real Git integration test confirms a changed tracked `.env` is omitted from status and the all-files diff.
- Browser skill with Pixel 7 emulation at 412×915 against the live Mobile route: after restarting the existing host process, open the terminal for a previously selected Codex session and confirm the background-process list loads without `thread not found`; start the interactive `cmd` terminal, run `echo CODEX_MOBILE_TERMINAL_OK`, verify the output in a screenshot, then stop the shell and confirm “Терминал завершён”. The Codex prompt and project files were not changed; the existing queue was left paused.
- Browser skill with Pixel 7 emulation at 412×915 on the live Mobile route: enter `echo CODEX_MOBILE_ONESHOT_OK` in one-command mode, confirm the exact command, verify exit code 0 and the output in the terminal screenshot. No project files changed.
- Browser skill with Pixel 7 emulation at 412×915 on the live Mobile route: open Codex settings, wait for the separate inventories, verify the MCP configuration list, paged plugin catalog/marketplaces and enabled user-scoped `browser-skill`; this was read-only and did not change Codex settings or invoke an integration.
- Browser skill with Pixel 7 emulation at 412×915: add a fixture stdio MCP server, inspect the confirmation for its exact command and project scope, confirm it, and verify the server appears with a separate shared-runtime restart notice; add a fixture HTTPS MCP server with a query value and verify the confirmation shows only its host, then confirm it appears in the list. The fixture launched no local command and made no MCP connection.
- Browser skill with Pixel 7 emulation at 412×915: open the MCP settings and verify a same-name global entry is marked as overridden by its workspace entry; cancel a global removal and confirm the list is unchanged; remove the global entry and verify the workspace entry remains while the shared-runtime restart notice appears. This ran only against the isolated browser fixture.
- Live validation (2026-10-19): the feature branch was started manually with the existing instance configuration and data, and it reused the existing `AcpClient` and one Codex app-server. Mini App and Mobile listen on `127.0.0.1:3301` and `127.0.0.1:3302`; the local health check reports Codex connected. Tailscale Funnel 443 still maps to 3301, and the separately authorized public Funnel 8443 maps to 3302. No startup file or task was changed. The old-checkout watchdog process was stopped for this approved Windows session; the branch is not registered for autostart, so the existing launcher may start the old checkout after the next Windows login.
- Live Funnel repair and Browser skill verification (2026-10-19): the local Tailscale CLI showed Funnel on, but public DNS initially returned NXDOMAIN and external HTTP checks failed. Reapplying only the 8443 route did not publish DNS; restarting the Windows Tailscale service synchronized it. Public DNS now resolves the hostname to Tailscale Funnel relay IPs. Independent external HTTP checks return 200 from three nodes for both the existing 443 route and Mobile on 8443. Browser skill with Pixel 7 emulation at 412×915 loads the public pairing screen; its unauthenticated `/api/session` request returns 401 as required. The existing 443 → 3301 and Mobile 8443 → 3302 mappings remain configured, and both Node listeners remain on loopback. Actual Android access and device approval still require the owner's phone; users who tried before DNS publication may need to refresh the phone's DNS/network state.

## Safety limits

- Preserve the Telegram bot's startup behavior, autostart, Funnel on 443,
  Mini App port 3301 and existing sessions. Funnel on 8443 is enabled only by
  the user's explicit public-access request on 2026-10-19. Do not reset the
  complete Tailscale configuration.
- Never start a second Codex app-server for Mobile. The mobile HTTP server must run inside the existing process that owns the shared ACP runtime.
- Do not add additional public routes or trust forwarded client IP headers.
- Do not render untrusted HTML or execute content from Codex, tools or files.
- Do not claim a turn completed unless the existing runtime confirms it; show
  an unknown status when completion cannot be established.

## Android public connection

For the current manual test session, Tailscale Funnel is enabled on HTTPS port
`8443` and proxies to the Mobile listener on `127.0.0.1:3302`. The existing
Funnel remains on HTTPS port `443` and proxies to `127.0.0.1:3301`. The public
Mobile URL is `https://laptop-mttke9pg.tail42f29f.ts.net:8443/`; it can be
opened without installing Tailscale on the phone. Anyone can load the pairing
page, but private Codex data and controls remain behind device authentication.
The owner must approve a one-time pairing code locally on the laptop before a
mobile session is created. See the
[Tailscale Funnel documentation](https://tailscale.com/kb/1223/funnel).

The server is running manually for the approved Windows session. Its autostart
was not changed. Funnel remains configured if the server stops, but then has no
local Mobile service to proxy to until the branch is started again. To remove
only this public route and restore tailnet-only access, run
`tailscale funnel --https=8443 off` followed by `tailscale serve --https=8443 3302`.
Do not use `tailscale funnel reset` or `tailscale serve reset`, which would also
remove the existing 443 route.

To connect Android, open the public HTTPS URL, create a pairing code on the
phone and approve it locally from the repository root:

```powershell
$env:CODEX_TG_DIR = '<existing-instance-directory>'
node --import tsx src/cli.ts mobile approve 'ONE_TIME_CODE'
```

If `ALLOWED_USERS` has more than one owner, pass the selected owner ID as the
last argument. The laptop-only control channel performs approval; a request
that arrives through the public Funnel is never considered local based on its
forwarded `remoteAddress`.

The mobile server provides a manual callback relay for phone OAuth. If Codex's
HTTPS authorization URL exposes one exact loopback `redirect_uri`, the relay
matches its host, port and path, checks the OAuth state when Codex exposes it,
and forwards the callback once to that listener. For a PAR URL that hides
`redirect_uri`, the phone can submit the final callback URL only after the
server confirms that the exact loopback address is listening in the active
Codex app-server process. Windows uses `netstat`, Linux uses `ss`, and macOS
uses `lsof`; if the listener's owner cannot be confirmed, the relay fails
closed. Both modes check authentication, Origin, CSRF and session ownership on
every relay request. Codex remains responsible for state validation and token
exchange. The Browser skill verified both modes with local fake providers and
callbacks only; real providers still need verification over the configured
Funnel route. Never set `mcp_oauth_callback_url` to a
non-loopback host: the current Codex implementation binds its temporary
callback listener to `0.0.0.0` for that setting. A fixed callback port does not
change that behavior. The upstream
[`callback_bind_host` and listener setup](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/perform_oauth_login.rs#L3116-L3135)
shows this host-selection behavior. The mobile client does not implement a
second OAuth client. See the
[Codex app-server OAuth instructions](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md).

1. Use the exact public origin configured in `CODEX_MOBILE_ORIGINS`.
2. Create a pairing code on Android and approve it on the laptop using the local
   CLI. Do not send the one-time code to anyone or expose it in logs.
3. Verify the paired phone can read only owner-authorized projects and sessions,
   then test device revocation and reconnection over the public Funnel.
4. If the server process stops, either restart this feature branch manually or
   remove only the 8443 Funnel route. Do not enable autostart or alter the old
   launcher without a separate explicit decision.

The application itself does not modify Tailscale configuration. The public
Funnel on 8443 was configured manually after the user's request; Funnel 443 and
the existing bot route remain unchanged.
