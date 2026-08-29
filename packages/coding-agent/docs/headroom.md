# Headroom

Headroom reduces repeated prompt size by replacing large historical tool-result text with deterministic previews immediately before a provider request.

## Safety model

Headroom transforms request-time copies only. The session transcript and JSONL file retain the original tool result. For every compressed block, Pie:

1. computes a SHA-256 hash over the exact UTF-8 text;
2. stores the original in a bounded, process-local memory store;
3. sends a smaller `<headroom_compressed ...>` preview to the model;
4. exposes `headroom_retrieve` so the model can recover exact content by hash.

Compression applies only to historical results — tool results the model has already consumed (a later assistant message exists in context). A fresh result produced by the current turn is delivered in full so the model can use it without an immediate `headroom_retrieve` round trip; it becomes eligible for compression once the model has replied. This keeps the preview markers transparent to ongoing work.

Images, tool-result metadata, and block ordering are preserved. Compression is suspended whenever `headroom_retrieve` is not active, including an explicit `--tools` allowlist that excludes it. This prevents unrecoverable preview markers.

The store is intentionally not persisted. A resumed process reconstructs requests from the original session data and stores new entries as it compresses them. Old hashes may be evicted when limits are reached. Unchanged blocks reuse a bounded cached marker only while the exact original and hash remain in the retrieval store.

## Commands

```text
/headroom status
/headroom on
/headroom off
/headroom stats
```

`/headroom` without an argument reports status. Turning compression off does not clear already-stored originals, so existing markers remain retrievable until eviction or process exit.

## Retrieval

The model normally calls `headroom_retrieve` itself. Its arguments are:

- `hash` — SHA-256 from the preview marker.
- `query` — optional case-sensitive substring matched against original lines. Prefer this for omitted middle content.
- `max_chars` — maximum UTF-8 bytes returned; default `12000`.
- `max_matches` — maximum matching lines; default `50`.
- `context_lines` — surrounding lines per match; default `0`.

A full retrieval larger than the output cap returns a UTF-8-safe head/tail excerpt and asks the model to retry with `query`.

## Defaults and environment

Headroom is enabled by default. Pie supports these process-level overrides:

| Variable | Default | Purpose |
|---|---:|---|
| `PIE_HEADROOM` | on | Set `0`, `false`, `no`, `off`, `disable`, or `disabled` to disable |
| `PIE_HEADROOM_MIN_CHARS` | `2000` | Minimum UTF-8 bytes before compression is attempted |
| `PIE_HEADROOM_MAX_SEGMENTS` | `12` | Maximum successful replacements per request |
| `PIE_HEADROOM_KEEP_LINES` | `40` | Plain-text preview lines split between head and tail |
| `PIE_HEADROOM_MAX_STORE_ENTRIES` | `256` | Maximum stored originals |
| `PIE_HEADROOM_MAX_STORE_CHARS` | `16777216` | Maximum total stored UTF-8 bytes |

JSON tool results up to 1 MiB receive a bounded structural preview. Other text receives a line or character head/tail preview. Pie keeps the original uncompressed whenever the preview is not smaller.

`/headroom stats` estimates tokens as `ceil(UTF-8 bytes / 4)`. Provider billing and cache savings depend on the provider's tokenizer, caching rules, and request history; the estimate is not a billing guarantee. The marker field `original_chars` is retained for compatibility but records UTF-8 bytes.

## Attribution

Pie Headroom is adapted from the Apache-2.0 Headroom implementation in `ds-build`.
