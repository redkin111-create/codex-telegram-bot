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

- Add complete work-context selection (host, workspace, branch, worktree and environment setup), steering, richer attachments, side chats, plans/goals, compact and pinning where existing APIs expose them. Isolated worktree creation now opens a thread through the shared ACP runtime. Steering, goals and manual compact are implemented; they still need compatibility checks against installed Desktop versions.
- Finish file edit edge cases, then add review comments, conflict resolution, remote fetch/push and interactive terminal/process controls through existing runtime interfaces. Git already has guarded per-path stage/unstage, staged commit, local branch listing, create-branch/existing-branch switching, tracking a branch already fetched on the laptop, isolated worktree creation and path-scoped diff review including rename paths. A confirmed one-shot terminal command is now available in an authorized idle session's project folder with a 60-second timeout and bounded output; it does not yet provide an interactive PTY or background-process lifecycle.
- Add models/modes/reasoning, safe skills/MCP/subagent inventories, quota display, plugin/app catalogs, and confirmed remote-plugin install/removal. Plugin enable/disable, arbitrary marketplaces, full provider OAuth, saved-account management, tasks and voice remain open.
- Keep changes allowlisted and require confirmation for destructive or permission-changing actions.
- Add server tests and browser-check every action against fake filesystem/runtime fixtures.

### Task 5: Verification and handoff

- Run root typecheck and tests, mobile typecheck/tests/build, and `npm audit` for the mobile app.
- Review branch for auth bypass, origin confusion, output injection, path escape and accidental service startup.
- Document capability coverage, limitations, Android connection steps and verification results. Do not merge or deploy.
