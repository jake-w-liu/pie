# Pie Upgrade / Fresh-Install Checklist (verified)

> **Status: VERIFIED on 2026-08-28** — every step below was executed and confirmed on this machine.
> Verified environment: Pie **0.84.3**, macOS, npm registry packages.

Pie ships the verified package set as pinned first-run defaults:

- `@earendil-works/pi-ext-web-access` (vendored)
- `@earendil-works/pi-ext-subagents` (vendored)

On a fresh configuration, Pie writes these sources to `~/.pi/agent/settings.json`; the normal package manager then installs missing packages before resources load. Pie does not overwrite an existing settings file, so later removals and user package choices survive restarts.

Manual recovery commands, if needed:

```bash
# pi-web-access is vendored as @earendil-works/pi-ext-web-access
# pi-subagents is vendored as @earendil-works/pi-ext-subagents
```

Installed versions at verification time (run `pie list` to see yours):

| Package | Version verified | Purpose |
|---|---|---|
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
source_check, subagent. Say MISSING for any absent one."
```

VERIFIED output on this machine:

```
web_search: web_search
fetch_content: fetch_content
get_search_content: get_search_content
source_check: source_check
subagent: subagent, subagent_wait, subagent_supervisor
```

## 3. Code search — built in, no extension

File search and content search are core Pie tools, not an extension. They need no install
step and no native dependency: `grep` and `find` shell out to `rg` and `fd`, which Pie
downloads on first use into its own tools directory for darwin, linux and windows on both
x64 and arm64.

- **Content search → `grep`**. Supports `pattern`, `path`, `glob`, `ignoreCase`, `literal`,
  `context`, `outputMode` (`content` / `files_with_matches` / `count`), and `limit`.
- **File search by glob → `find`**. Supports `pattern`, `path`, and `limit`, and respects
  `.gitignore`.
- Prefer these over `bash` + `grep`/`find` shell spelunking.
- `read` and `grep` take exact relative or absolute paths. There is no fuzzy path
  resolution; pass the real path.

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
```

Pie itself is source-managed and is updated by rebuilding and reinstalling from this repository.

## 7. Gotchas learned (read before a fresh install)

1. **Restart (or `/reload`) after install** — tools don't appear in the running session.
2. `pie -p "..."` print mode is the cheapest way to smoke-test that tools registered and work
   (used for every VERIFIED claim above).
3. pi-web-access cache is session-scoped; clones are wiped on session change.
