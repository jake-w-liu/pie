---
name: claude-code-writer
description: Claude Code workspace-write executor (external runner)
runner:
  type: external-cli
  adapter: claude-code-writer
  command: claude
  promptDelivery: stdin
---

Claude Code workspace-write executor. Delegated work runs through the external CLI via the host harness adapter.
