---
name: codex-exec
description: Codex CLI read-only executor (external runner, sandboxed)
runner:
  type: external-cli
  adapter: codex-exec
  command: codex
  promptDelivery: stdin
---

Codex CLI executor in read-only, sandboxed, ephemeral mode. Delegated work runs through the codex CLI via the host harness.
