---
name: claude-code
description: Claude Code read-only executor (external runner)
runner:
  type: external-cli
  adapter: claude-code
  command: claude
  promptDelivery: stdin
---

Claude Code read-only executor. Delegated work runs through the external CLI via the host harness adapter.
