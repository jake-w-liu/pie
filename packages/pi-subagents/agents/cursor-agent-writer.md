---
name: cursor-agent-writer
description: Cursor Agent workspace-write executor (external runner)
runner:
  type: external-cli
  adapter: cursor-agent-writer
  command: cursor-agent
  promptDelivery: stdin
---

Cursor Agent workspace-write executor. Delegated work runs through the external CLI via the host harness adapter.
