#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: scripts/refresh-pie.sh [options]

Build the current Pie checkout, stage and validate a local npm installation,
atomically activate it for new terminal invocations, then remove repository
build artifacts. The upstream `pi` executable is never modified.

Run this command only while no other build or test is using this checkout;
refresh cleans shared repository dist/ outputs before and after installation.

Options:
  --check          Run npm run check before the final build
  --test           Run ./test.sh after building
  --online-models  Refresh model catalogs during the build instead of reusing
                   the currently installed catalog data
  --keep-build     Keep repository dist/ and generated model data after completion
  --slim           After a successful install, also remove repository node_modules
                   so the checkout stays minimal (regenerated on the next build)
  -h, --help       Show this help
EOF
}

run_check=false
run_tests=false
online_models=false
keep_build=false
slim=false

while [[ $# -gt 0 ]]; do
	case "$1" in
		--check)
			run_check=true
			;;
		--test)
			run_tests=true
			;;
		--online-models)
			online_models=true
			;;
		--keep-build)
			keep_build=true
			;;
		--slim)
			slim=true
			;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			printf 'error: unknown option: %s\n\n' "$1" >&2
			usage >&2
			exit 2
			;;
	esac
	shift
done

for command in node npm git cmp mktemp readlink; do
	if ! command -v "$command" >/dev/null 2>&1; then
		printf 'error: required command not found: %s\n' "$command" >&2
		exit 1
	fi
done

read_package_field() {
	node --input-type=module -e 'import { readFileSync } from "node:fs"; const pkg = JSON.parse(readFileSync(process.argv[1], "utf8")); const value = pkg[process.argv[2]]; if (typeof value !== "string") process.exit(1); process.stdout.write(value);' "$1" "$2"
}

atomic_symlink() {
	local target="$1"
	local link="$2"
	local parent base temporary=""
	parent="$(dirname "$link")"
	base="$(basename "$link")"
	for _attempt in 1 2 3 4 5; do
		temporary="$parent/.${base}.refresh.$$.$RANDOM"
		if ln -s -- "$target" "$temporary" 2>/dev/null; then
			break
		fi
		temporary=""
	done
	if [[ -z "$temporary" ]]; then
		printf 'error: could not create temporary symlink for %s\n' "$link" >&2
		return 1
	fi
	if ! node --input-type=module -e 'import { renameSync } from "node:fs"; renameSync(process.argv[1], process.argv[2]);' "$temporary" "$link"; then
		rm -f -- "$temporary"
		return 1
	fi
}

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

if [[ "$(read_package_field "$repo_dir/package.json" name)" != "pi-monorepo" ]]; then
	printf 'error: could not identify the Pie repository root: %s\n' "$repo_dir" >&2
	exit 1
fi
if [[ -z "${HOME:-}" || "$HOME" != /* ]]; then
	printf 'error: HOME must be an absolute path\n' >&2
	exit 1
fi

share_dir="$HOME/.local/share"
bin_dir="$HOME/.local/bin"
canonical_root="$share_dir/pie"
releases_dir="$share_dir/pie-releases"
pie_link="$bin_dir/pie"
lock_dir="$share_dir/.pie-refresh.lock"
release_dir=""
release_pie=""
backup_dir=""
lock_owned=false
build_started=false
install_committed=false
bin_switched=false
canonical_switched=false
legacy_moved=false
original_bin_exists=false
original_bin_target=""
original_canonical_type="absent"
original_canonical_target=""

remove_owned_directory() {
	local directory="$1"
	local marker="$2"
	if [[ -z "$directory" || ! -e "$directory" ]]; then
		return 0
	fi
	if [[ -L "$directory" || ! -f "$directory/$marker" ]]; then
		printf 'error: refusing to remove unverified directory: %s\n' "$directory" >&2
		return 1
	fi
	rm -rf -- "$directory"
}

remove_managed_release() {
	local directory="$1"
	if [[ -z "$directory" || ! -e "$directory" ]]; then
		return 0
	fi
	case "$directory" in
		"$releases_dir"/release.*) ;;
		*)
			printf 'error: refusing to remove release outside %s: %s\n' "$releases_dir" "$directory" >&2
			return 1
			;;
	esac
	remove_owned_directory "$directory" ".pie-refresh-release"
}

restore_original_activation() {
	local failed=false
	if [[ "$install_committed" == true || "$bin_switched" != true ]]; then
		return 0
	fi

	if [[ "$legacy_moved" == true ]]; then
		if [[ -n "$backup_dir" && -d "$backup_dir/previous-install" ]]; then
			atomic_symlink "$backup_dir/previous-install/node_modules/.bin/pie" "$pie_link" || failed=true
			if [[ -L "$canonical_root" && "$(readlink "$canonical_root")" == "$release_dir" ]]; then
				rm -- "$canonical_root" || failed=true
			fi
			if [[ ! -e "$canonical_root" ]]; then
				mv -- "$backup_dir/previous-install" "$canonical_root" || failed=true
			fi
			if [[ "$original_bin_exists" == true && -e "$canonical_root" ]]; then
				atomic_symlink "$original_bin_target" "$pie_link" || failed=true
			elif [[ "$original_bin_exists" != true && -L "$pie_link" ]]; then
				rm -- "$pie_link" || failed=true
			fi
		else
			printf 'error: previous Pie installation could not be restored; retained recovery paths\n' >&2
			failed=true
		fi
	else
		if [[ "$canonical_switched" == true ]]; then
			if [[ "$original_canonical_type" == "symlink" ]]; then
				atomic_symlink "$original_canonical_target" "$canonical_root" || failed=true
			elif [[ "$original_canonical_type" == "absent" && -L "$canonical_root" && "$(readlink "$canonical_root")" == "$release_dir" ]]; then
				rm -- "$canonical_root" || failed=true
			fi
		fi
		if [[ "$original_bin_exists" == true ]]; then
			atomic_symlink "$original_bin_target" "$pie_link" || failed=true
		elif [[ -L "$pie_link" && "$(readlink "$pie_link")" == "$release_pie" ]]; then
			rm -- "$pie_link" || failed=true
		fi
	fi

	if [[ "$failed" == true ]]; then
		return 1
	fi
	return 0
}

cleanup() {
	local status=$?
	local cleanup_failed=false
	local model_data
	trap - EXIT HUP INT TERM
	set +e

	restore_original_activation || cleanup_failed=true

	if [[ -n "$release_dir" && -d "$release_dir" ]]; then
		if { [[ -L "$pie_link" ]] && [[ "$(readlink "$pie_link")" == "$release_pie" ]]; } ||
			{ [[ -L "$canonical_root" ]] && [[ "$(readlink "$canonical_root")" == "$release_dir" ]]; }; then
			if [[ "$install_committed" != true ]]; then
				printf 'error: retaining active recovery release: %s\n' "$release_dir" >&2
				cleanup_failed=true
			fi
		elif [[ "$install_committed" != true ]]; then
			remove_managed_release "$release_dir" || cleanup_failed=true
		fi
	fi

	if [[ -n "$backup_dir" && -d "$backup_dir" ]]; then
		if [[ -d "$backup_dir/previous-install" ]]; then
			printf 'error: retaining previous installation for recovery: %s\n' "$backup_dir/previous-install" >&2
			cleanup_failed=true
		else
			remove_owned_directory "$backup_dir" ".pie-refresh-owned" || cleanup_failed=true
		fi
	fi

	if [[ "$build_started" == true && "$keep_build" != true ]]; then
		(
			cd "$repo_dir"
			npm run clean
		) || cleanup_failed=true
		model_data="$repo_dir/packages/ai/src/providers/data"
		if [[ -L "$model_data" ]]; then
			printf 'error: refusing to remove symlinked model-data path: %s\n' "$model_data" >&2
			cleanup_failed=true
		else
			rm -rf -- "$model_data" || cleanup_failed=true
		fi
	fi

	# Remove nested node_modules that npm hoisting can leave inside the vendored
	# extension packages; their dependencies resolve from the monorepo root, so
	# these per-package node_modules are pure build garbage.
	for ext_dir in "$repo_dir"/packages/pi-fff "$repo_dir"/packages/pi-web-access "$repo_dir"/packages/pi-subagents; do
		if [[ -d "$ext_dir/node_modules" ]]; then
			rm -rf -- "$ext_dir/node_modules" || cleanup_failed=true
		fi
	done

	if [[ "$lock_owned" == true ]]; then
		rm -f -- "$lock_dir/owner"
		rmdir -- "$lock_dir" 2>/dev/null || cleanup_failed=true
	fi
	if [[ "$status" -eq 0 && "$cleanup_failed" == true ]]; then
		status=1
	fi
	exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p -- "$share_dir" "$bin_dir" "$releases_dir"
if [[ -L "$releases_dir" || ! -d "$releases_dir" ]]; then
	printf 'error: release root must be a real directory: %s\n' "$releases_dir" >&2
	exit 1
fi
if ! mkdir -- "$lock_dir" 2>/dev/null; then
	printf 'error: another refresh may be active; lock exists: %s\n' "$lock_dir" >&2
	printf 'Inspect that directory before removing a stale lock.\n' >&2
	exit 1
fi
lock_owned=true
printf 'pid=%s\nrepo=%s\n' "$$" "$repo_dir" > "$lock_dir/owner"

if [[ -e "$pie_link" || -L "$pie_link" ]]; then
	if [[ ! -L "$pie_link" ]]; then
		printf 'error: refusing to replace non-symlink launcher: %s\n' "$pie_link" >&2
		exit 1
	fi
	original_bin_exists=true
	original_bin_target="$(readlink "$pie_link")"
	if [[ "$original_bin_target" != "$canonical_root/node_modules/.bin/pie" ]]; then
		case "$original_bin_target" in
			"$releases_dir"/release.*/node_modules/.bin/pie) ;;
			*)
				printf 'error: refusing to replace launcher with unexpected target: %s -> %s\n' "$pie_link" "$original_bin_target" >&2
				exit 1
				;;
		esac
	fi
fi

if [[ -L "$canonical_root" ]]; then
	original_canonical_type="symlink"
	original_canonical_target="$(readlink "$canonical_root")"
	case "$original_canonical_target" in
		"$releases_dir"/release.*) ;;
		*)
			printf 'error: refusing to replace canonical Pie link with unexpected target: %s -> %s\n' "$canonical_root" "$original_canonical_target" >&2
			exit 1
			;;
	esac
	if [[ ! -d "$original_canonical_target" || ! -f "$original_canonical_target/.pie-refresh-release" ]]; then
		printf 'error: canonical Pie link does not target a managed release: %s\n' "$canonical_root" >&2
		exit 1
	fi
elif [[ -d "$canonical_root" ]]; then
	original_canonical_type="directory"
	legacy_manifest="$canonical_root/node_modules/@earendil-works/pi-coding-agent/package.json"
	if [[ ! -f "$legacy_manifest" || "$(read_package_field "$legacy_manifest" name)" != "@earendil-works/pi-coding-agent" ]]; then
		printf 'error: refusing to migrate an unrecognized installation: %s\n' "$canonical_root" >&2
		exit 1
	fi
elif [[ -e "$canonical_root" ]]; then
	printf 'error: canonical Pie path has unsupported type: %s\n' "$canonical_root" >&2
	exit 1
fi

cd "$repo_dir"
source_revision="$(git rev-parse --short=12 HEAD)"
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
	source_revision="$source_revision-dirty"
fi
printf 'Refreshing Pie from %s\n' "$source_revision"

build_started=true
npm run clean
source_model_data="$repo_dir/packages/ai/src/providers/data"
if [[ -L "$source_model_data" ]]; then
	printf 'error: refusing to replace symlinked model-data path: %s\n' "$source_model_data" >&2
	exit 1
fi
rm -rf -- "$source_model_data"
if [[ "$online_models" == true ]]; then
	npm --prefix packages/ai run generate-models
else
	installed_model_data="$canonical_root/node_modules/@earendil-works/pi-ai/dist/providers/data"
	if [[ -d "$installed_model_data" && ! -L "$installed_model_data" ]]; then
		cp -R -- "$installed_model_data" "$source_model_data"
	else
		printf 'No installed model data found; hydrating catalogs before the offline build.\n'
		npm run hydrate:model-data
	fi
fi
if [[ "$run_check" == true ]]; then
	npm run check
fi
npm run build:offline
if [[ "$run_tests" == true ]]; then
	./test.sh
fi

source_bundle="$repo_dir/packages/coding-agent/dist/bundle/pie-cli.js"
if [[ ! -f "$source_bundle" ]]; then
	printf 'error: built Pie bundle not found: %s\n' "$source_bundle" >&2
	exit 1
fi
source_bundle_hash="$(node --input-type=module -e 'import { createHash } from "node:crypto"; import { readFileSync } from "node:fs"; console.log(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"));' "$source_bundle")"

release_dir="$(mktemp -d "$releases_dir/release.XXXXXX")"
touch "$release_dir/.pie-refresh-release"
mkdir -p -- "$release_dir/tarballs"

# Complete local workspace dependency closure of the Pie CLI.
package_dirs=(
	"packages/telemetry"
	"packages/tui"
	"packages/ai"
	"packages/agent"
	"packages/protocol"
	"packages/client"
	"packages/coding-agent"
	"packages/pi-fff"
	"packages/pi-web-access"
	"packages/pi-subagents"
)
package_names=(
	"@earendil-works/pi-telemetry"
	"@earendil-works/pi-tui"
	"@earendil-works/pi-ai"
	"@earendil-works/pi-agent-core"
	"@earendil-works/pi-protocol"
	"@earendil-works/pi-client"
	"@earendil-works/pi-coding-agent"
	"@earendil-works/pi-ext-fff"
	"@earendil-works/pi-ext-web-access"
	"@earendil-works/pi-ext-subagents"
)
package_specs=()

for index in "${!package_dirs[@]}"; do
	package_dir="$repo_dir/${package_dirs[$index]}"
	package_name="${package_names[$index]}"
	actual_name="$(read_package_field "$package_dir/package.json" name)"
	if [[ "$actual_name" != "$package_name" ]]; then
		printf 'error: package name mismatch for %s: expected %s, found %s\n' "$package_dir" "$package_name" "$actual_name" >&2
		exit 1
	fi
	pack_json="$(cd "$package_dir" && npm pack --json --pack-destination "$release_dir/tarballs")"
	tarball_name="$(printf '%s' "$pack_json" | node --input-type=module -e 'let input = ""; for await (const chunk of process.stdin) input += chunk; const parsed = JSON.parse(input); const item = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]; if (!item || typeof item.filename !== "string") process.exit(1); process.stdout.write(item.filename);')"
	if [[ -z "$tarball_name" || ! -f "$release_dir/tarballs/$tarball_name" ]]; then
		printf 'error: npm pack did not create the expected tarball for %s\n' "$package_name" >&2
		exit 1
	fi
	package_specs+=("$package_name=$tarball_name")
done

node --input-type=module -e '
	import { writeFileSync } from "node:fs";
	const output = process.argv[1];
	const dependencies = {};
	for (const spec of process.argv.slice(2)) {
		const separator = spec.indexOf("=");
		if (separator <= 0 || separator === spec.length - 1) throw new Error(`Invalid package spec: ${spec}`);
		dependencies[spec.slice(0, separator)] = `file:tarballs/${spec.slice(separator + 1)}`;
	}
	writeFileSync(output, `${JSON.stringify({ private: true, dependencies, overrides: dependencies }, undefined, 2)}\n`);
' "$release_dir/package.json" "${package_specs[@]}"

(
	cd "$release_dir"
	npm install --omit=dev --ignore-scripts --no-audit --no-fund
)

release_pie="$release_dir/node_modules/.bin/pie"
release_bundle="$release_dir/node_modules/@earendil-works/pi-coding-agent/dist/bundle/pie-cli.js"
expected_version="$(read_package_field "$repo_dir/packages/coding-agent/package.json" version)"
if [[ ! -x "$release_pie" || ! -f "$release_bundle" ]]; then
	printf 'error: staged Pie launcher or bundle is missing\n' >&2
	exit 1
fi
if ! cmp -s -- "$source_bundle" "$release_bundle"; then
	printf 'error: staged Pie bundle differs from the source build\n' >&2
	exit 1
fi
if [[ "$(cd /tmp && "$release_pie" --version)" != "$expected_version" ]]; then
	printf 'error: staged Pie version check failed\n' >&2
	exit 1
fi
(cd /tmp && "$release_pie" --help >/dev/null)

# The terminal launcher is the activation point. renameSync atomically replaces
# its symlink, so a concurrent invocation resolves either the old or new release.
atomic_symlink "$release_pie" "$pie_link"
bin_switched=true

if [[ "$original_canonical_type" == "directory" ]]; then
	backup_dir="$(mktemp -d "$share_dir/.pie-refresh-backup.XXXXXX")"
	touch "$backup_dir/.pie-refresh-owned"
	mv -- "$canonical_root" "$backup_dir/previous-install"
	legacy_moved=true
fi
atomic_symlink "$release_dir" "$canonical_root"
canonical_switched=true

if [[ "$(readlink "$pie_link")" != "$release_pie" || "$(readlink "$canonical_root")" != "$release_dir" ]]; then
	printf 'error: activated Pie links failed validation\n' >&2
	exit 1
fi
if [[ ! -x "$pie_link" || "$("$pie_link" --version)" != "$expected_version" ]]; then
	printf 'error: terminal Pie launcher failed validation\n' >&2
	exit 1
fi
if ! cmp -s -- "$source_bundle" "$canonical_root/node_modules/@earendil-works/pi-coding-agent/dist/bundle/pie-cli.js"; then
	printf 'error: canonical Pie installation failed bundle validation\n' >&2
	exit 1
fi

install_committed=true
if [[ "$slim" == true ]]; then
	(
		cd "$repo_dir"
		rm -rf -- node_modules packages/*/node_modules packages/*/*/node_modules 2>/dev/null || true
	)
	printf 'Slimmed checkout: removed repository node_modules (recreated on next build).\n'
fi
if [[ -n "$backup_dir" ]]; then
	remove_owned_directory "$backup_dir" ".pie-refresh-owned"
	backup_dir=""
fi
if [[ "$original_canonical_type" == "symlink" && "$original_canonical_target" != "$release_dir" ]]; then
	remove_managed_release "$original_canonical_target"
fi
if [[ "$original_bin_exists" == true ]]; then
	case "$original_bin_target" in
		"$releases_dir"/release.*/node_modules/.bin/pie)
			previous_bin_release="${original_bin_target%/node_modules/.bin/pie}"
			if [[ "$previous_bin_release" != "$release_dir" && "$previous_bin_release" != "$original_canonical_target" ]]; then
				remove_managed_release "$previous_bin_release"
			fi
			;;
	esac
fi

printf 'Installed Pie %s from %s\n' "$expected_version" "$source_revision"
printf 'Bundle SHA-256: %s\n' "$source_bundle_hash"
printf 'Active release: %s\n' "$release_dir"
printf 'Launcher: %s\n' "$pie_link"
printf 'New pie invocations now use this build; restart existing Pie sessions.\n'
