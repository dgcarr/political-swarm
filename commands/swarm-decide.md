---
description: Resolve a specific pending swarm approval (vote, spend, waiver, etc.)
argument-hint: [run-id] [approval-id] [approve|reject|modify]
allowed-tools: mcp__plugin_political-swarm_swarm__swarm_status, mcp__plugin_political-swarm_swarm__swarm_decide
---

If an approval-id wasn't given in `$ARGUMENTS`, call `swarm_status` first, list the `pendingApprovals`, and ask the user which one and what decision to make.

Call `swarm_decide` with the run id, approval id, and decision (plus a note or modified budget if relevant). Report the resulting status back to the user.
