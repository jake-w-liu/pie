---
name: check-pie-upstream
description: Check whether Pie (this fork) is behind upstream Pi, list the upstream commits that landed since the last reviewed base, and track what has been ported. Use when asked whether Pie needs an update, how far behind upstream Pie is, what upstream changed, or after porting upstream commits into Pie.
---

# Check Pie against upstream Pi

Pie is a maintained fork of [earendil-works/pi](https://github.com/earendil-works/pi). Use this workflow to answer "does Pie need an update?" and to keep a ledger of which upstream commits have been reviewed and ported.

## Key fact: Pie's history is disconnected from upstream

Pie's git history starts at a fresh root commit (`bebd712` "initialize Pie 0.1.0 fork"). There is **no shared ancestry** between Pie's `main` and upstream `main`, so `git merge-base` returns nothing and `HEAD..upstream/main` is meaningless. The sync state must be anchored on the documented upstream fork base SHA.

- Fork base (upstream SHA): `56f3f33a9a675ef2a2c30cf2e35a6a385cdf2ed4` (README.md "Upstream base").
- This anchor is stored in `~/.pi/upstream-sync/state.json` (ephemeral, outside git). The default is the fork base; `mark-reviewed` advances it.

## Commands

`scripts/check-upstream.sh` wraps the whole flow. Run from the repo root.

```bash
./scripts/check-upstream.sh setup          # init state (idempotent, no git remote added)
./scripts/check-upstream.sh fetch          # fetch upstream main into refs/pie-upstream/main
./scripts/check-upstream.sh status         # pie vs upstream version, tip, commits-behind
./scripts/check-upstream.sh review         # list upstream commits since the last reviewed base
./scripts/check-upstream.sh mark-reviewed <sha>  # advance the anchor after porting
./scripts/check-upstream.sh help
```

The script never adds a git remote. `fetch` pulls upstream `main` by URL (`https://github.com/earendil-works/pi.git`, override with `PIE_UPSTREAM_URL`) into the private local ref `refs/pie-upstream/main`. It never touches Pie's own history and does not modify your git remotes or config.

## Reading `status`

The key line is `Upstream commits since base`. Non-zero means Pie is behind the reviewed base and there are upstream commits to evaluate. The version comparison reads `packages/coding-agent/package.json` on both sides (the root `package.json` version is not the release version).

## Deciding what to port

Upstream commits frequently touch files Pie forks. Group pending commits by relevance before porting:

- **Directly relevant** — upstream fixes/changes touching the same code paths Pie modified (agent core, TUI, provider model catalog, compaction, terminal rendering). Port and re-run Pie's checks.
- **Docs/changelog only** (e.g. `docs:`, `chore:`, `Release vX.Y.Z`) — low priority; note and skip unless a doc fact is now wrong.
- **Unrelated internals** — typically `SKIP` for Pie since the fork restarts versioning and re-brands.

After reviewing (and porting the relevant ones), advance the anchor so `status` reflects what has been seen:

```bash
./scripts/check-upstream.sh mark-reviewed <upstream-sha>
```

`mark-reviewed` takes the upstream tip SHA (or any upstream commit) and stores it as the new base. It only records the review; it does not modify Pie source.

## Rule

Never merge or rebase upstream into Pie's `main`. Histories and branding diverge. Port changes by hand (as commits), then mark the reviewed SHA.
