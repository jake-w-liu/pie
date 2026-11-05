#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: scripts/update-pie.sh [refresh options]

Update this Pie checkout from its upstream branch and reinstall Pie. Fetches the
upstream branch, fast-forwards the checkout, runs `npm ci --ignore-scripts` when
package-lock.json changed since dependencies were last installed or they are
missing, then runs
scripts/refresh-pie.sh --no-bump with any options given here (for example
--check or --test). Updating never creates commits or pushes.

Stops without changing anything when tracked files have uncommitted changes,
HEAD is detached, the branch has no upstream, or the branch has diverged from
its upstream. When the checkout already matches its upstream and the installed
Pie was built from that exact commit, nothing is reinstalled.

Options:
  -h, --help   Show this help
EOF
}

# Everything runs inside main(): bash reads a script while executing it, and the
# fast-forward below can replace this file. A function is parsed in full first, and
# the call at the end shares its line with exit, so nothing after main is read.
main() {
	local arg
	for arg in "$@"; do
		case "$arg" in
			-h | --help)
				usage
				return 0
				;;
			--no-bump | --no-push)
				printf 'error: %s is implied; updating never bumps or pushes\n' "$arg" >&2
				return 2
				;;
		esac
	done

	local command
	for command in git node npm; do
		if ! command -v "$command" >/dev/null 2>&1; then
			printf 'error: required command not found: %s\n' "$command" >&2
			return 1
		fi
	done

	local script_path script_dir link_target repo_dir
	script_path="${BASH_SOURCE[0]}"
	while [[ -L "$script_path" ]]; do
		script_dir="$(cd -P "$(dirname "$script_path")" && pwd)"
		link_target="$(readlink "$script_path")"
		if [[ "$link_target" == /* ]]; then
			script_path="$link_target"
		else
			script_path="$script_dir/$link_target"
		fi
	done
	script_dir="$(cd -P "$(dirname "$script_path")" && pwd)"
	repo_dir="$(cd "$script_dir/.." && pwd)"
	cd "$repo_dir"

	if [[ "$(node --input-type=module -e 'import { readFileSync } from "node:fs"; process.stdout.write(String(JSON.parse(readFileSync("package.json", "utf8")).name));')" != "pi-monorepo" ]]; then
		printf 'error: could not identify the Pie repository root: %s\n' "$repo_dir" >&2
		return 1
	fi

	local branch remote merge_ref
	if ! branch="$(git symbolic-ref --quiet --short HEAD)"; then
		printf 'error: HEAD is detached in %s; check out a branch to update\n' "$repo_dir" >&2
		return 1
	fi
	remote="$(git config --get "branch.$branch.remote" || true)"
	merge_ref="$(git config --get "branch.$branch.merge" || true)"
	if [[ -z "$remote" || -z "$merge_ref" ]]; then
		printf 'error: branch %s has no upstream to update from\n' "$branch" >&2
		return 1
	fi
	local dirty
	dirty="$(git status --porcelain --untracked-files=no)"
	if [[ -n "$dirty" ]]; then
		printf 'error: %s has uncommitted changes; commit or discard them before updating:\n%s\n' "$repo_dir" "$dirty" >&2
		return 1
	fi

	local old_head fetched ahead
	old_head="$(git rev-parse HEAD)"
	printf 'Fetching %s from %s...\n' "$merge_ref" "$remote"
	git fetch --quiet "$remote" "$merge_ref"
	fetched="$(git rev-parse FETCH_HEAD)"
	if git merge-base --is-ancestor HEAD "$fetched"; then
		if [[ "$old_head" != "$fetched" ]]; then
			git merge --ff-only --quiet "$fetched"
			printf 'Updated %s: %s -> %s\n' "$branch" "${old_head:0:12}" "${fetched:0:12}"
		fi
	elif git merge-base --is-ancestor "$fetched" HEAD; then
		ahead="$(git rev-list --count "$fetched..HEAD")"
		printf 'note: %s has %s commit(s) that are not on %s; installing the local branch\n' "$branch" "$ahead" "$remote" >&2
	else
		printf 'error: %s has diverged from %s %s; integrate the branches before updating\n' "$branch" "$remote" "$merge_ref" >&2
		return 1
	fi

	local new_head installed
	new_head="$(git rev-parse HEAD)"
	# The active installation records the commit it was built from (scripts/refresh-pie.sh).
	installed="$(node --input-type=module -e '
		import { readFileSync } from "node:fs";
		try {
			const metadata = JSON.parse(readFileSync(process.argv[1], "utf8"));
			if (metadata && metadata.dirty === false && typeof metadata.revision === "string") {
				process.stdout.write(metadata.revision);
			}
		} catch {}
	' "${HOME:-}/.local/share/pie/source.json")"
	if [[ "$installed" == "$new_head" && $# -eq 0 ]]; then
		printf 'Pie is already up to date at %s.\n' "${new_head:0:12}"
		return 0
	fi

	# npm writes node_modules/.package-lock.json after it installs, so an older one means the
	# lockfile changed since then, as after a manual git pull or an interrupted update.
	if [[ ! -f node_modules/.package-lock.json ]] ||
		[[ package-lock.json -nt node_modules/.package-lock.json ]] ||
		! git diff --quiet "$old_head" "$new_head" -- package-lock.json; then
		printf 'Installing dependencies...\n'
		npm ci --ignore-scripts --no-audit --no-fund
	fi

	bash "$repo_dir/scripts/refresh-pie.sh" --no-bump "$@"
}

main "$@"; exit $?
