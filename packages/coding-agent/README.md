# Pie coding agent

This package contains the `pie` terminal application. Pie is a fork of [Pi Agent](https://github.com/earendil-works/pi) maintained at <https://github.com/jake-w-liu/pie>.

The package keeps the upstream npm identity `@earendil-works/pi-coding-agent` for workspace and SDK compatibility, but ships two executables:

- `pie` — Pie branding, pinned package defaults, and Nippon dark/light colors.
- `pi` — compatibility entrypoint with normal Pi branding and colors.

## Pie features

- Default packages: `pi-fff@0.1.12`, `pi-web-access@0.26.0`, and `pi-subagents@0.58.0`.
- Default-on Headroom compression with exact `headroom_retrieve` recovery.
- Automatic model selection after logging in to a different provider.
- Complete Nippon-color themes for UI, messages, tools, Markdown, diffs, syntax, search, and exports.
- Interactive, print, JSON, RPC, and SDK modes inherited from Pi.

Pie shares `~/.pi/agent` with an existing Pi installation, including authentication and sessions.

## Run

From a built checkout:

```bash
./dist/bundle/pie-cli.js --help
./dist/bundle/pie-cli.js
```

From the local installation:

```bash
pie
pie --model openai-codex/gpt-5.6-luna
```

Useful interactive commands:

```text
/login
/model
/headroom status
/headroom stats
/settings
```

## Develop

Run these commands from the repository root:

```bash
npm ci --ignore-scripts
npm run check
./test.sh
npm run build
```

Detailed documentation:

- [Quick start](docs/quickstart.md)
- [Usage](docs/usage.md)
- [Headroom](docs/headroom.md)
- [Themes](docs/themes.md)
- [Packages](docs/packages.md)
- [SDK](docs/sdk.md)

## Security

Pie tools and extensions run with the current user's permissions. Review package source before installation and use a sandbox when filesystem or process isolation is required.

The retained upstream npm package name plus Pie's reset `0.1.0` version can produce semver-only audit matches for issues already fixed in the upstream base. Check advisories against the source before deciding whether they apply.

## License

MIT, with upstream attribution to Pi Agent. Headroom attribution is documented in [docs/headroom.md](docs/headroom.md).
