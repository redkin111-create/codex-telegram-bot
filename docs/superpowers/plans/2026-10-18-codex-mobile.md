# Codex Mobile Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` in this session. Tasks use checkbox syntax.

**Goal:** Build a phone browser client that can safely operate the existing Codex Desktop runtime, with all Desktop capability areas tracked until parity is verified.

**Architecture:** Add an opt-in loopback HTTP server to the existing process and delegate work through `MiniAppAgent`, `TmaLiveFeed`, `AcpClient` and `RuntimeRegistry`. Keep the React/Tailwind app in its own package; use a one-time local CLI approval for pairing and cookie-based browser sessions.

**Tech Stack:** Existing TypeScript/Node HTTP service; isolated React, Vite and Tailwind app; built-in Node test runner; Browser skill with fake fixtures.

**Spec:** `docs/CODEX_MOBILE.md`

## Global Constraints

- New HTTP listener is `127.0.0.1` only and uses a port other than 3301.
- No Tailscale changes, deployment, public route, bot autostart change or live service start.
- One existing Codex app-server runtime only.
- Every API and SSE access checks device, user and resource authorization; mutations also check Origin and CSRF.
- Untrusted Markdown/tool/diff content cannot execute HTML or scripts.
- Every mobile UI function is exercised with Browser skill against fake data.
- No `rmtcdx` code, new database, paid service or unrelated dependency upgrade.

## Review Focus

- The laptop CLI approval channel is a separate OS-local IPC endpoint (Windows
  named pipe or Unix socket), never an HTTP route forwarded to a phone.
- A revoked/expired device cannot keep using an open SSE connection.
- Guessing a session ID cannot expose another user's history, screenshots or files.
- Codex disconnects, timeouts and partial turns remain visible as errors/unknown status.
- Untrusted filenames, Markdown, diffs and tool output remain inert at mobile widths.

## Parity acceptance

- The capability matrix in `docs/CODEX_MOBILE.md` is the source of truth. A
  Desktop capability is not counted as implemented until its server operation
  delegates to the existing Codex runtime, checks the signed-in device and
  owner/resource scope, has an automated test, and its mobile behavior has been
  exercised with Browser skill against an isolated fixture.
- The phone is an additional client for the one `AcpClient` and
  `RuntimeRegistry` owned by the existing process. Never start another Codex
  runtime or copy business logic out of `MiniAppAgent`/`TmaLiveFeed`.
- Every API call and each SSE reconnect/event delivery checks the current
  device and resource authorization. State-changing requests also validate the
  configured browser Origin and CSRF token. Markdown, tool output, diffs and
  screenshots are displayed as inert data.
- “Статус неизвестен” is the honest state whenever Codex does not confirm an
  outcome. Do not infer completion from a disconnect or missing event.
- This branch remains local-only: no Tailscale Serve/Funnel changes, no
  deployment, no listener start on the user's laptop, and no changes to the
  Telegram bot, port 3301, its autostart or existing sessions.

## Tasks

### Task 1: Pairing and device sessions

- Implement expiring one-time pairing, local CLI approval over OS IPC, rate limits, hashed session tokens, device list/revoke, Origin validation and CSRF.
- Add unit and HTTP tests for approval, expiry, brute-force throttling, revoked devices, Origin/CSRF and unauthenticated requests.
- Add a local control command that uses a private control channel; do not use `remoteAddress` as the approval check.

### Task 2: Loopback service and runtime adapter

- Wire behind an explicit opt-in in the existing process; fixed loopback bind and independent port.
- Reuse `MiniAppAgent` and `TmaLiveFeed` for owner-scoped projects, sessions, history, status, tool events and authorized screenshots.
- Test foreign-user/session denial, Codex errors, reconnect/resume and auth checks on each API/SSE request.

### Task 3: Phone app and core conversation flow

- Add the separate React/Tailwind app and safe reusable shadcn-style controls.
- Implement pairing UX, device management, projects/sessions/history, live status, tool output, screenshots, prompt/queue/stop and phone approval cards with Telegram fallback.
- Implement session rename, archive, restore and fork using Codex's existing thread APIs; native search across older active or archived threads now uses the existing `thread/list` cursor.
- Browser-check each visible behavior on a small phone viewport against an isolated fixture; check XSS and overflow.
- Add a session-scoped file browser/editor with UTF-8 and size limits, secret-file exclusions, optimistic save checks and busy-session write rejection.

### Task 4: Coding workflow and integrations

- Add complete work-context selection (host, workspace, branch, worktree and environment setup), steering, richer attachments, side chats, plans/goals, compact and pinning where existing APIs expose them. Isolated worktree creation now opens a thread through the shared ACP runtime. Steering, goals, manual compact, and guarded edit/retry for the latest idle text-only turn are implemented; native pin/unpin now uses Codex's built-in Pinned section, and section creation, rename, deletion, filtering and membership changes use the shared ACP runtime. Snapshot now detects when the running Codex build lacks the section API and disables these controls instead of inventing a pinned section. Broader compatibility checks against installed Desktop versions remain open.
- Finish file edit edge cases and add review comments and conflict resolution through existing runtime interfaces. Git now has guarded per-path stage/unstage, staged commit, local branch listing, create-branch/existing-branch switching, tracking an already-fetched branch, confirmed fetch from a configured HTTPS/SSH/local remote, fast-forward pull of a clean tracked branch after confirmation, confirmed push of only the current branch, isolated worktree creation and path-scoped diff review including rename paths. Pull refuses dirty or diverged branches and creates no merge commit. Text conflicts can read and compare bounded base/ours/theirs Git stages, choose a version in the inert editor, and save/stage after marker checks; binary/symlink handling remains open. Interactive PTY input/resize/stop, same-shell reattachment, and listing/stopping Codex background processes with thread-scoped ownership checks are implemented.
- Model/mode/reasoning controls now apply to the selected owned Codex thread through native `thread/settings/update`; model and effort are read back through `thread/read`. The selected mode is also written natively and remains in the existing runtime preference because Codex does not report the active mode in that read response. Browser coverage verifies changing and refreshing all three settings on an isolated Pixel 7 fixture. Safe skills/MCP/subagent inventories, quota display, plugin/app catalogs, confirmed remote-plugin install/removal, saved-account management, native ChatGPT device-code sign-in/cancel (serialized with account rotation), and voice are covered; plugin enable/disable, completing provider OAuth from Android and Codex task scheduling remain open.
- Keep changes allowlisted and require confirmation for destructive or permission-changing actions.
- Add server tests and browser-check every action against fake filesystem/runtime fixtures.

### Task 5: Verification and handoff

- Run root typecheck and tests, mobile typecheck/tests/build, and `npm audit` for the mobile app.
- Review branch for auth bypass, origin confusion, output injection, path escape and accidental service startup.
- Document capability coverage, limitations, Android connection steps and verification results. Do not merge or deploy.
