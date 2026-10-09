# Changelog

## [Unreleased]

### Fixed

- Schedule recurrence admission completes before claiming work. An unrepresentable future recurrence is diagnosed without blocking an already-known child completion; failed terminal publication retains observer ownership and reports both failures. A still-current armed occurrence with `catchUp: "none"` tolerates late timer delivery, while restoration and explicit due scans still skip missed work.
- Async workflow startup validates child-summary identifiers, persists initial status, and prepares all required receipt projections before marking capacity started or scheduling its Worker. Prelaunch failures dispose both persistence writers and pending retries; known-unstarted owned status and active/tool-call/terminal indexes are synchronized even with unlimited capacity or a write that committed before throwing. Cleanup I/O failures are reported alongside the original error, while started or uncertain ownership and post-admission mission warnings keep their existing semantics.
- Schedule activation checks the captured project's current trust decision on restore, actions, timers, and immediately before launch. Inert inspection and pause/delete remain available without trust, and already-launched work keeps its ownership.
- Persisted schedule triggers validate positive, consistent intervals and valid dates; recurrence advancement is bounded and checks overflow. Invalid records are reported individually during restoration.
- Detached workflow child errors retain their whitelisted scalar classification across the sandbox boundary, so async status, results, and receipts correctly record a pause. Automatic JavaScript continuation remains unsupported.
