#!/usr/bin/env bash
# ── check-upstream.sh ────────────────────────────────────────────────────────
# Check whether Pie is behind upstream Pi and list the upstream commits that
# have landed since the last reviewed base.
#
# Pie's git history is intentionally disconnected from upstream (fresh root
# commit, no shared ancestry), so the check cannot rely on `git merge-base`.
# Instead it tracks a "last reviewed upstream SHA" anchor in a state file
# outside the repo and diffs upstream main against that anchor.
#
# The script NEVER adds a git remote. It fetches upstream by URL into a private
# local ref (refs/pie-upstream/main) that is not part of Pie's own history.
#
# Usage:
#   ./scripts/check-upstream.sh setup              # init state (idempotent)
#   ./scripts/check-upstream.sh fetch              # update local upstream main ref
#   ./scripts/check-upstream.sh status             # upstream tip vs pie version + anchor
#   ./scripts/check-upstream.sh review             # list upstream commits since anchor
#   ./scripts/check-upstream.sh mark-reviewed <sha> # advance the anchor after porting
#   ./scripts/check-upstream.sh help
#
# The state dir is excluded from git (ephemeral per-machine tracking).
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

UPSTREAM_URL="${PIE_UPSTREAM_URL:-https://github.com/earendil-works/pi.git}"
UPSTREAM_BRANCH="${PIE_UPSTREAM_BRANCH:-main}"
LOCAL_UPSTREAM_REF="refs/pie-upstream/main"
# Default anchor: the upstream commit Pie forked from (README.md "Upstream base").
FORK_BASE_SHA="56f3f33a9a675ef2a2c30cf2e35a6a385cdf2ed4"

# Ephemeral state lives outside the repo so the ledger does not pollute git.
STATE_DIR="${PIE_UPSTREAM_SYNC_DIR:-$HOME/.pi/upstream-sync}"
STATE_FILE="$STATE_DIR/state.json"

info() { printf '  %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

need_git() { command -v git >/dev/null 2>&1 || die "git not found"; }

ensure_state() {
  if [[ ! -f "$STATE_FILE" ]]; then
    mkdir -p "$STATE_DIR"
    cat > "$STATE_FILE" <<EOF
{
  "upstream_url": "$UPSTREAM_URL",
  "upstream_branch": "$UPSTREAM_BRANCH",
  "last_reviewed_sha": "$FORK_BASE_SHA",
  "last_reviewed_at": null
}
EOF
  fi
}

state_get() {
  ensure_state
  python3 - "$STATE_FILE" "$1" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
print(data.get(sys.argv[2], ""))
PY
}

state_set() {
  ensure_state
  python3 - "$STATE_FILE" "$1" "$2" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
data[sys.argv[2]] = sys.argv[3]
with open(sys.argv[1], "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
}

cmd_setup() {
  need_git
  ensure_state
  info "no git remote added; upstream fetched by URL ($UPSTREAM_URL)"
  info "state dir: $STATE_DIR (not in git)"
  info "last_reviewed_sha (anchor): $(state_get last_reviewed_sha)"
}

cmd_fetch() {
  need_git
  git fetch --quiet "$UPSTREAM_URL" "$UPSTREAM_BRANCH:${LOCAL_UPSTREAM_REF}" 2>&1 | tail -2
  local tip
  tip="$(git rev-parse --short "$LOCAL_UPSTREAM_REF")"
  info "upstream tip: $tip ($(git log -1 --format=%s "$LOCAL_UPSTREAM_REF"))"
}

cmd_status() {
  need_git
  ensure_state
  git rev-parse --verify "$LOCAL_UPSTREAM_REF" >/dev/null 2>&1 \
    || die "no local upstream ref — run: ./scripts/check-upstream.sh fetch"

  local last tip upstream_v pie_v ahead
  last="$(state_get last_reviewed_sha)"
  tip="$(git rev-parse --short "$LOCAL_UPSTREAM_REF")"
  upstream_v="$(awk -F'"' '/"version"/{print $4; exit}' <(git show "$LOCAL_UPSTREAM_REF:packages/coding-agent/package.json"))"
  pie_v="$(awk -F'"' '/"version"/{print $4; exit}' packages/coding-agent/package.json)"
  ahead="$(git rev-list --count "$last..$LOCAL_UPSTREAM_REF")"

  echo "Pie version        : $pie_v"
  echo "Upstream version   : $upstream_v"
  echo "Upstream tip       : $tip ($(git log -1 --format=%s "$LOCAL_UPSTREAM_REF"))"
  echo "Last reviewed base : $last"
  echo "Upstream commits since base : $ahead"
  if [[ "$ahead" -gt 0 ]]; then
    echo "STATUS: Pie is behind upstream; review the pending commits."
  else
    echo "STATUS: Pie is in sync with the reviewed base."
  fi
}

cmd_review() {
  need_git
  ensure_state
  git rev-parse --verify "$LOCAL_UPSTREAM_REF" >/dev/null 2>&1 \
    || die "no local upstream ref — run: ./scripts/check-upstream.sh fetch"

  local last tip
  last="$(state_get last_reviewed_sha)"
  tip="$(git rev-parse --short "$LOCAL_UPSTREAM_REF")"

  if [[ "$(git rev-list --count "$last..$LOCAL_UPSTREAM_REF")" -eq 0 ]]; then
    info "no upstream commits since base $last"
    return 0
  fi

  echo "Upstream commits since ${last} (${tip}):"
  echo
  git log --format='%h %ad %s' --date=short "$last..$LOCAL_UPSTREAM_REF"
  echo
  info "review each; port relevant ones into pie, then run: mark-reviewed <sha>"
}

cmd_mark_reviewed() {
  need_git
  ensure_state
  local sha="${1:-}"
  [[ -n "$sha" ]] || die "usage: ./scripts/check-upstream.sh mark-reviewed <sha>"
  git rev-parse --verify "$sha" >/dev/null 2>&1 || die "not a commit: $sha"
  state_set last_reviewed_sha "$(git rev-parse "$sha")"
  state_set last_reviewed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  info "anchor set to $(git rev-parse --short "$sha")"
  info "state: last_reviewed_sha=$(state_get last_reviewed_sha)"
}

cmd_help() {
  sed -n '1,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

cmd="${1:-help}"
shift || true
case "$cmd" in
  setup)         cmd_setup "$@" ;;
  fetch)         cmd_fetch "$@" ;;
  status)        cmd_status "$@" ;;
  review)        cmd_review "$@" ;;
  mark-reviewed) cmd_mark_reviewed "$@" ;;
  help|-h|--help) cmd_help ;;
  *) die "unknown command: $cmd (try: help)" ;;
esac
