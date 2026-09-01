---
name: cursor-agent
description: Cursor Agent read-only executor (external runner)
runner:
  type: external-cli
  adapter: cursor-agent
  command: cursor-agent
  promptDelivery: stdin
---

Cursor Agent read-only executor. Delegated work runs through the external CLI via the host harness adapter.
