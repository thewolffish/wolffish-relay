# RELEASE.md — wolffish-relay Release Procedure

Instructions for cutting a release. Same shape as the wolffish-app procedure: verify, commit, then `npm run release` as the last, outward-facing step. If anything looks wrong, **stop and report** — do not push a release past an unresolved problem.

---

## Non-negotiables

- **Never hand-edit the version** in `package.json` / `package-lock.json`. `npm run release` bumps them (`npm version patch`). The only version you touch by hand is the **README badge**.
- **Stay on `main`.** No branches. The release is committed and pushed on `main`.
- **`npm run release` is the last step and it is outward-facing** — it pushes a commit and a tag, which triggers the Release workflow: tests → **deploy to Cloudflare** → GitHub Release. Only run it once everything is clean. A tag push deploys production infrastructure.
- **ZDR invariants are release blockers.** If the diff adds any storage binding, storage API call, logging, analytics, or external fetch to the relay, that is not a lint problem — stop and report it.
- **When in doubt, stop.** A halted release costs nothing. A bad release is live at `relay.wolffi.sh`.

## What `npm run release` actually does

```
npm run release  ==  npm version patch  &&  git push origin main --tags
```

1. `npm version patch` bumps `1.0.N` → `1.0.N+1`, makes a version commit, tags it `v1.0.N+1`. It **refuses to run on a dirty tree** — commit all work first.
2. The tag push triggers `.github/workflows/release.yml`: a verify job (typecheck, lint, full test suite), then a deploy job in the `Production` environment (`wrangler deploy` with the repo's Cloudflare secrets), then a GitHub Release with generated notes.

## Procedure

1. **Analyze changes.** `git status && git diff`, plus `git log $(git describe --tags --abbrev=0)..HEAD --stat` for committed work. If there is nothing meaningful to release, stop.
2. **Guards.** `npm run typecheck && npm run lint && npm test`. Lint problems: fix yourself and re-run. Typecheck or test failures, half-finished work, secrets in the diff, or any ZDR-invariant violation: **stop and report**.
3. **Bump the README badge** to the next patch version (current `package.json` version + 1). Nothing else by hand.
4. **Commit everything** in one regular commit with a concise message (e.g. `fix: presence notice on error-path disconnects`). Tree must be clean.
5. **`npm run release`**, then confirm: the Release workflow is green, and `curl https://relay.wolffi.sh/healthz` returns `ok`.
6. Report the released version and what shipped.
