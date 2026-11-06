# Pie

Pie is a terminal coding agent and a maintained fork of [Pi Agent](https://github.com/earendil-works/pi).

Pie keeps Pi's provider support, sessions, SDK, and extension system while shipping an opinionated local setup under the `pie` command. Only the `pie` executable is shipped; the Pi ecosystem (packages, extensions, sessions, credentials in `~/.pi`) stays fully accessible.

- **Pie version:** `0.1.6`
- **Upstream base:** Pi commit [`56f3f33`](https://github.com/earendil-works/pi/commit/56f3f33a9a675ef2a2c30cf2e35a6a385cdf2ed4)
- **Repository:** <https://github.com/jake-w-liu/pie>

## What Pie changes

- Installs pinned defaults for `pi-web-access` and `pi-subagents` on a fresh Pie configuration.
- Enables default-on Headroom request compression for large tool results while preserving exact session data and on-demand retrieval.
- Switches to the authenticated provider's default model after cross-provider `/login` and remembers interactive model changes for the next startup.
- Starts automatic context compaction at the earlier of 87% usage or the configured reserve boundary, and sizes summary requests from the model's own limits so long sessions on high-reasoning models keep compacting.
- Optimizes long-session terminal rendering, streaming Markdown and Bash previews, narrow selectors, and masked authentication input.
- Uses complete dark and light palettes from the [NIPPON COLORS](https://nipponcolors.com/) catalog.
- Ships only the `pie` executable (no `pi` binary) while keeping full access to the Pi ecosystem: providers, sessions, extensions, and `~/.pi` credentials.

Pie intentionally shares `~/.pi/agent` with Pi, so existing credentials, sessions, settings, and packages remain available.

## Requirements

- Node.js 22.19 or newer
- npm
- Provider credentials for live model requests

## Development

```bash
npm ci --ignore-scripts
npm run check
./test.sh
npm run build
```

Run the source build:

```bash
./packages/coding-agent/dist/bundle/pie-cli.js --help
./packages/coding-agent/dist/bundle/pie-cli.js
```

Refresh the terminal installation after changing source:

```bash
npm run refresh:pie
```

Each refresh first bumps every package to the next patch version, commits only the version files (`Bump version to X.Y.Z`), and pushes the current branch to its upstream; it stops before bumping if the branch is behind its upstream or a version file has uncommitted edits. Other uncommitted work is built and installed but not committed, and no tag is created. If the push fails, the installation still completes and the command exits with status 1. Pass `-- --no-push` to commit without pushing (for example, offline) or `-- --no-bump` to reinstall the current version without any git changes.

The command then reuses the installed model catalog data when available, builds offline, packs Pie and its six internal runtime workspaces, validates a versioned release, atomically switches `~/.local/bin/pie`, updates `~/.local/share/pie`, removes older installations that no running Pie process uses, and removes repository build artifacts. Running Pie processes and detached subagent runs keep a file of their installation open, so a release in use is kept until a later refresh finds it unused; without `lsof` every old release is kept. On a first install it hydrates model data before building. Pass `-- --check`, `-- --test`, `-- --online-models`, `-- --keep-build`, or `-- --slim` when needed. `--slim` also removes the repository `node_modules` after a successful install so the checkout stays minimal; run `npm ci` (or the next refresh) to restore it. Run it only when no other build or test is using the checkout because cleanup removes shared `dist/` outputs. Already-running Pie sessions must be restarted.

Pie is source-managed; its `update` command updates installed packages rather than the application itself.

### Updating other machines

On every machine that runs Pie from a checkout of this repository, `/update` in Pie (or `npm run update:pie` in the checkout) installs the latest pushed code. It reads the checkout path that `refresh:pie` records with each installation, fetches the branch's upstream, fast-forwards the checkout, runs `npm ci --ignore-scripts` when `package-lock.json` changed or is newer than the installed dependencies, and reinstalls with `refresh:pie -- --no-bump`, so updating never creates commits or pushes. It stops without changes when the checkout has uncommitted changes to tracked files or has diverged from its upstream, and skips the reinstall when the installed build already matches the upstream. It waits for a running response or compaction to finish first, because the update takes over the editor until the build completes. Restart Pie sessions afterwards.

A machine whose installation predates `/update` needs one manual update first:

```bash
cd <your Pie checkout>
git pull --ff-only
npm ci --ignore-scripts
npm run refresh:pie -- --no-bump
```

For a new machine, clone `https://github.com/jake-w-liu/pie.git` and run the last two commands in the clone.

## Checking upstream for Pie

Pie's git history starts at a fresh root commit and is disconnected from upstream, so tracking which upstream commits have been reviewed is anchored on the upstream fork base SHA (`56f3f33`). `scripts/check-upstream.sh` wraps the check; it fetches upstream `main` by URL into a private ref (no git remote is added) and diffs that ref against the last reviewed SHA stored in `~/.pi/upstream-sync/state.json` (outside git).

```bash
./scripts/check-upstream.sh setup          # init state (no git remote added)
./scripts/check-upstream.sh fetch          # fetch upstream main into a private ref
./scripts/check-upstream.sh status         # pie vs upstream version, tip, commits-behind
./scripts/check-upstream.sh review         # list upstream commits since the last reviewed base
./scripts/check-upstream.sh mark-reviewed <sha>   # advance the anchor after porting
```

Never merge or rebase upstream into Pie's `main`; histories and branding diverge. Port relevant changes by hand, then `mark-reviewed` the upstream SHA. See [`.pi/skills/check-pie-upstream.md`](.pi/skills/check-pie-upstream.md) for the full workflow.

## Usage

```bash
pie
pie --model openai-codex/gpt-5.6-luna
pie --help
```

Inside the interactive interface:

```text
/login
/headroom status
/headroom stats
```

See [`packages/coding-agent/docs`](packages/coding-agent/docs) for detailed usage, settings, packages, themes, and Headroom behavior.

## Safety

Pie runs tools and extensions with the permissions of the current user. Review third-party packages before installing them, and use a container or sandbox when stronger isolation is required.

The coding package retains the upstream npm name for compatibility. Because Pie restarts its version at `0.1.0`, `npm audit` may match advisories against the version number even when the fork includes the later upstream fix; verify such reports against the cited source and this fork's upstream base.

## Upstream and license

Pie is not the upstream Pi project. Upstream documentation and project history remain available at [earendil-works/pi](https://github.com/earendil-works/pi).

The repository retains Pi's MIT license. Pie Headroom is adapted from the Apache-2.0 implementation in `ds-build`; see [`packages/coding-agent/docs/headroom.md`](packages/coding-agent/docs/headroom.md).
