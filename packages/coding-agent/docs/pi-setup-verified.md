# Pie Upgrade / Fresh-Install Checklist (verified)

> **Status: VERIFIED on 2026-08-28** — every step below was executed and confirmed on this machine.
> Verified environment: Pie **0.84.3**, macOS, npm registry packages.

Pie ships the verified package set as pinned first-run defaults:

- `npm:pi-fff@0.1.12`
- `npm:pi-web-access@0.26.0`
- `npm:pi-subagents@0.58.0`

On a fresh configuration, Pie writes these sources to `~/.pi/agent/settings.json`; the normal package manager then installs missing packages before resources load. Pie does not overwrite an existing settings file, so later removals and user package choices survive restarts.

Manual recovery commands, if needed:

```bash
pie install npm:pi-fff@0.1.12
pie install npm:pi-web-access@0.26.0
pie install npm:pi-subagents@0.58.0
```

Installed versions at verification time (run `pie list` to see yours):

| Package | Version verified | Purpose |
|---|---|---|
| `pi-fff` | 0.1.12 | Fuzzy file finding, FFF-backed `grep`, `@...` autocomplete |
| `pi-web-access` | 0.26.0 | Web search, URL fetch, GitHub clone, PDF/YouTube/video extraction |
| `pi-subagents` | 0.58.0 | Child agents: scout, researcher, worker, reviewer, oracle, delegate |

- Install is **global** (writes to `~/.pi/agent/settings.json` → `packages: [...]`). No other
  install step needed for any of the three (pi-subagents README: "That is the only required step").
- **Restart Pie after installing** (or `/reload`). Extensions only load in fresh sessions.
- These shipped sources are pinned and therefore skipped by later package updates until explicitly changed.

## 2. Verify installation

```bash
pie list    # shows the three packages + install paths
cat ~/.pi/agent/settings.json   # packages array present
```

Probe that tools actually registered (fresh process loads the packages):

```bash
pie -p "List every available tool matching: web_search, fetch_content, get_search_content,
source_check, find_files, fff_multi_grep, subagent. Say MISSING for any absent one."
```

VERIFIED output on this machine:

```
web_search: web_search
fetch_content: fetch_content
get_search_content: get_search_content
source_check: source_check
find_files: find_files
fff_multi_grep: fff_multi_grep
subagent: subagent, subagent_wait, subagent_supervisor
```

## 3. Use pi-fff — and don't use `grep` for code search

pi-fff gives the agent FFF-backed search tools. Rule for new Pie sessions:

- **Code search → the `grep` tool** (it is the built-in `grep` upgraded with FFF indexing —
  description reads "Uses fff for content search and can resolve approximate file or folder scopes").
  VERIFIED: it found `hello` in `sample.js` line 2 in a test project, via the FFF index.
- **Find files by fuzzy name → `find_files`** (VERIFIED: query `readme` → `readme.md`).
- **Multiple literal patterns at once → `fff_multi_grep`**.
- Prefer these over `bash` + `grep`/`find` shell spelunking. `read` also resolves approximate
  paths, so `read src/index` works instead of exact paths.
- `resolve_file` / `related_files` / `fff_grep` do **NOT** exist as tools in pi-fff 0.1.12 —
  the README over-promises those three; the grep upgrade is named `grep`, and the two agent
  tools are `find_files` and `fff_multi_grep` (VERIFIED in `src/register-tools.ts`).

### Feature flags (all ON by default — VERIFIED in `src/index.ts`)

- `autocomplete` — `@...` fuzzy file completion in the editor
- `builtInReadEnhancement` — `read` resolves approximate paths
- `builtInGrepEnhancement` — `grep` is FFF-indexed
- `agentTools` — registers `find_files` / `fff_multi_grep`
- `statusUI` — startup notices

Commands: `/fff-features` (toggle flags; toggling read/grep enhancement needs `/reload`),
`/fff-status` (runtime state, indexed file count), `/reindex-fff` (manual rescan fallback).
State file: `~/.pi/agent/extensions/pi-fff.json`.

Indexing is automatic: runtime indexes the project on session start, keeps a watcher running.
No manual reindex in normal use.

## 4. pi-web-access — zero config, optional keys

VERIFIED: `web_search` succeeds **with no API keys configured** (zero-config Exa MCP path).

Tools: `web_search`, `fetch_content`, `get_search_content`, `source_check`.
Commands: `/websearch` (curator UI), `/curator` (toggle summary workflow),
`/search` (browse stored results), `/google-account`. Activity monitor: `Ctrl+Shift+W`.

Optional setup (only if you want more providers / better results):

```bash
brew install ffmpeg yt-dlp   # optional: video frame extraction
```

- Config: `~/.pi/web-search.json` — all fields optional. Keys like `openaiApiKey`,
  `braveApiKey`, `exaApiKey`, `tavilyApiKey`, `geminiApiKey`, `perplexityApiKey`, …
  Accept `"$ENV_VAR"` references or `!command` credential sources.
- Shipped Pie seeds terminal-only defaults on a fresh config: `workflow: "auto-summary"` and
  `autoOpenBrowser: false`, so `web_search` returns a summary in the terminal without opening
  the browser curator or asking for approval. Existing config is never overwritten; use
  `/curator` or edit `web-search.json` to change it.
- Fallback chain (auto mode): configured SearXNG → Codex-backed OpenAI (if signed in) →
  Exa → OpenAI → Brave → Parallel → TinyFish → Search1API → … → Gemini.
- GitHub URLs are cloned locally; YouTube/local videos get transcript + visual analysis via
  Gemini; PDFs convert to Markdown (Datalab → Gemini → local unpdf).
- Requires pi >= 0.37.3.

## 5. pi-subagents — no config needed

Tools: `subagent`, `subagent_wait`, `subagent_supervisor`. Just ask in plain language:

```
Use reviewer to review this diff.
Ask oracle for a second opinion on my current plan.
Run parallel reviewers: one for correctness, one for tests, one for simplicity.
```

Built-in agents: `scout` (recon), `researcher` (web research), `worker` (implementation),
`reviewer` (code review), `oracle` (second opinion), `delegate` (general).

Commands: `/council`, `/parallel-review`, `/review-loop`, `/subagents-fleet` (live inspector),
`/subagents-doctor` (health check), `/subagents-guide [topic]`.
Background runs keep working after control returns; FleetView shows them under the editor.

## 6. Updating packages later

```bash
pie update                  # unpinned packages; pinned refs are reconciled
pie update npm:pi-fff       # one package (pinned versions are skipped)
```

Pie itself is source-managed and is updated by rebuilding and reinstalling from this repository.

## 7. Gotchas learned (read before a fresh install)

1. **Restart (or `/reload`) after install** — tools don't appear in the running session.
2. `pie -p "..."` print mode is the cheapest way to smoke-test that tools registered and work
   (used for every VERIFIED claim above).
3. pi-fff indexes whatever project Pie starts in; huge dirs (like `$HOME`) take longer to warm.
4. If the FFF index looks stale after big branch switches/renames: `/reindex-fff`.
5. pi-web-access cache is session-scoped; clones are wiped on session change.
