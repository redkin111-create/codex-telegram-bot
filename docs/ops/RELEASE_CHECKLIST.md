# Release checklist

A release ships a **batch of merged pull requests** as one versioned tag. The
fork currently has no `.github/workflows/release.yml`, so tags do not publish
releases automatically. Archive creation and GitHub publication are manual.

## 1. Pre-flight (on `main`)

- [ ] All intended PRs for this batch are **merged into `main`**.
- [ ] `git checkout main && git pull` — local `main` matches origin.
- [ ] `npm ci && npm run typecheck` passes with no errors.
- [ ] `npm test` passes.
- [ ] `npm ci --prefix apps/codex-mobile` and
      `npm run build --prefix apps/codex-mobile` pass.
- [ ] Manual smoke test where relevant (`npm start`, basic Telegram round-trip).

## 2. Changelog & version

- [ ] Add a new `## [X.Y.Z] - YYYY-MM-DD` section to `CHANGELOG.md` with the
      user-facing features/fixes (this becomes the GitHub Release notes).
- [ ] Add the matching link reference at the bottom of `CHANGELOG.md`.
- [ ] Choose the bump per SemVer: `patch` (fixes), `minor` (features),
      `major` (breaking).

## 3. Tag & publish

```bash
npm version minor          # bumps package.json, commits, creates the v* tag
git push --follow-tags
```

- [ ] Create a clean source archive with `git archive` for the release tag;
      never package the working directory with its secrets and runtime data.
- [ ] Publish a GitHub Release for the tag, attach the archive, and use the
      matching changelog section for the release notes.
- [ ] Confirm the GitHub Release exists with:
  - [ ] the correct title (`vX.Y.Z`),
  - [ ] notes matching the CHANGELOG section,
  - [ ] the attached `codex-telegram-bot-X.Y.Z.zip`,
  - [ ] GitHub's auto-generated Source code archives.

## 4. Post-release

- [ ] Announce / update any docs that reference the version.
- [ ] Open the next batch of feature branches off the new `main`.
