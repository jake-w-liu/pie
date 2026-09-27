# Changelog

## [Unreleased]

### Fixed

- Fixed a duplicated `## [Unreleased]` heading in this changelog leaving the unreleased entries below a released version, where the release script could not reach them. The release script now refuses to run with a duplicated heading instead of rewriting only the first one, which stranded these entries and published an empty release-notes section.
- Fixed the Unix listener socket being briefly world-connectable between `listen()` and the permission change; the socket is now created at its final mode by tightening the umask around the bind, which is restored on every path.
- Hardened protocol adapters against contradictory lifecycle states, invalid identifiers and timestamps, sparse execution arrays, and additive `pi-ai` contract drift.
- Sanitized service and runtime failures into stable `not_implemented` and `internal_error` responses without exposing private error details ([#7644](https://github.com/earendil-works/pi/pull/7644)).

## [0.84.3] - 2026-08-24

## [0.84.2] - 2026-08-14

## [0.84.1] - 2026-08-07

## [0.84.0] - 2026-08-06

### Breaking Changes

- Changed `toProtocolToolResultMessage()` to require the original `ToolCall` and verify tool result association.
- Changed `PiServerService.listSessions()` to return durable `SessionMetadata` instead of runtime `SessionSummary` values ([#7708](https://github.com/earendil-works/pi/pull/7708)).

## [0.83.0] - 2026-07-29

## [0.82.1] - 2026-07-25

## [0.82.0] - 2026-07-24

## [0.81.1] - 2026-07-21

## [0.81.0] - 2026-07-21

### Changed

- Renamed the orchestrator workspace package and internal server references to server ([#6898](https://github.com/earendil-works/pi/pull/6898) by [@cristinaponcela](https://github.com/cristinaponcela)).

## [0.80.10] - 2026-07-16

## [0.80.9] - 2026-07-16

## [0.80.8] - 2026-07-16

## [0.80.7] - 2026-07-14

## [0.80.6] - 2026-07-09

## [0.80.5] - 2026-07-09

## [0.80.4] - 2026-07-09

## [0.80.3] - 2026-06-30
