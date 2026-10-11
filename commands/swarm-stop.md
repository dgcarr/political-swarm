---
description: Request that a running swarm stop
argument-hint: [run-id] [reason]
allowed-tools: mcp__plugin_political-swarm_swarm__swarm_stop
---

Call `swarm_stop` for the given run with the provided reason, if any, from `$ARGUMENTS`.

Confirm that the stop request was recorded and the status is `stopped`. Explain that in-flight work may continue until the engine reaches a stop checkpoint; the tool does not wait for it to finish. Stopping does not apply changes to the real repository.
