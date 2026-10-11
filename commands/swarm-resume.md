---
description: Resume an interrupted swarm run from its saved state
argument-hint: [run-id]
allowed-tools: mcp__plugin_political-swarm_swarm__swarm_resume, mcp__plugin_political-swarm_swarm__swarm_status, mcp__plugin_political-swarm_swarm__swarm_list_runs, AskUserQuestion
---

If no run-id was given in `$ARGUMENTS`, call `swarm_list_runs` and pick the runs whose status is `interrupted`. If there is exactly one, use it; otherwise ask the user which run they mean. Only an `interrupted` run can be resumed: a server restart, crash or signal leaves a run that way. A run that ended (`stopped`, `failed`, `terminated_incomplete`, `completed`) cannot.

Call `swarm_resume` for the run. Explain what resuming does: the run continues under its own doctrine from its saved state; governance decisions are replayed from its ledger rather than re-made; a task that was cut off while awaiting its verdict has its unjudged change reverted and runs again; and the worktree is checked against the run's recorded base revision first.

If the result is `running`, say so and suggest `/swarm-status` to follow it. If it is `terminated_incomplete`, relay `lastError` — the worktree could not be validated for resume — and do not retry.
