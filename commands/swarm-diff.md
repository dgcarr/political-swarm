---
description: Show the diff a swarm run has produced so far (read-only)
argument-hint: [run-id] [task-id]
allowed-tools: mcp__plugin_political-swarm_swarm__swarm_get_diff
---

Call `swarm_get_diff` for the given run (and task, if a task-id was given in `$ARGUMENTS`). Show the user the diff text and the list of changed files. The tool returns no test results — exact check commands and their results are part of the delivery packet, which `/swarm-accept` reads and checks (see below).

This command is read-only — it never applies anything to the real repository.

The diff alone is not the swarm's evidence. Once a run reaches `awaiting_acceptance` there is a full
delivery packet behind it — the requirement-to-test matrix, exact check commands and results,
findings and their dispositions, minority reports, limitations and residual risks — which
`/swarm-accept` reads and checks. For an ordinary delivery, point the user there before `/swarm-apply`.
A `terminated_incomplete` run has a separate, explicitly confirmed salvage path through `/swarm-apply`
with `allowPartialFromIncomplete: true`; this does not make the run complete.
