---
name: codex-exec-writer
description: Codex CLI workspace-write executor (external runner)
runner:
  type: external-cli
  adapter: codex-exec-writer
  command: codex
  promptDelivery: stdin
---

Codex CLI workspace-write executor. Delegated work runs through the external CLI via the host harness adapter.
