---
description: Check swarm run status and resolve any pending approvals
argument-hint: [run-id]
allowed-tools: mcp__plugin_political-swarm_swarm__swarm_status, mcp__plugin_political-swarm_swarm__swarm_list_runs, mcp__plugin_political-swarm_swarm__swarm_decide, AskUserQuestion
---

If no run-id was given in `$ARGUMENTS`, call `swarm_list_runs`. If exactly one run is active, use it; otherwise ask the user which run they mean.

Call `swarm_status` for the run. Summarize plainly: overall status, progress, cost so far vs. budget,
and any `pendingApprovals`.

Relay the `stateMeaning` field rather than paraphrasing the raw status — the ways a run can end
or stall are not interchangeable, and reporting one as another is the specific failure section 5 of each
doctrine forbids:

- **awaiting_acceptance** — the swarm accepted its own work and submitted a delivery packet. This is
  *not* completion. Tell the user to run `/swarm-accept` so Claude can independently check it.
- **completed** — the swarm accepted it *and* Claude's independent check passed. This permits the
  ordinary `/swarm-apply` path. A `terminated_incomplete` run has a separate, explicitly confirmed
  salvage path; it remains incomplete.
- **terminated_incomplete** — the run ended without an acceptable delivery. Say so plainly, with
  `lastError` as the reason. Never present this as partial success or imply the work is usable.
- **remediation** — Claude rejected a delivery and the same swarm is reworking it.
- **paused_budget, paused_human, failed, stopped, interrupted** — relay `stateMeaning` verbatim. For
  `interrupted`, `stateMeaning` is empty, so report the raw status and say plainly that the run was
  interrupted and is not complete.

Report the `findings` counts. Unresolved and deferred findings are disclosed risk, not bookkeeping:
name them. If `findings.minorityReports` is above zero, say so — preserved dissent is part of the
record and must not be summarized away into apparent consensus.

For each pending approval, explain in plain language what's being asked (e.g. "the democratic strategy needs a two-thirds vote to touch the auth module — approve?", "a capitalist high-risk listing needs your spend approval before bidding opens", "the socialist strategy escalated a twice-rejected task to you"). Ask the user how to resolve each one via AskUserQuestion — never resolve an approval on your own judgment — then call `swarm_decide` with their answer.

This is not squeamishness about clicking a button. Votes, confidence motions, recalls, appointments,
bids, prices and escrow are the doctrine's internal decision procedure, which Claude must not
replace, shortcut or overrule. When one of them surfaces as an approval it has reached a human,
not reached you: present it and carry the human's answer back, without arguing for an outcome.

A `test_waiver` approval is different in kind and deserves a stronger warning. It means the swarm
proposed weakening or deleting an existing test — every doctrine forbids doing that to obtain a
passing result, so no committee, council or contract can authorise it and the engine has stopped the
task. Tell the user exactly which tests and how. Make clear that neither answer lets the change
through: approving or rejecting sends the task back for another attempt (rejecting abandons it once
attempts run out), and the engine checks every attempt again. If the tests really are obsolete, the
user has to change them outside the swarm.

There is no `questionTime` field in the response. The democratic strategy's Question Time digest
lives in internal strategy state and is not currently exposed by `swarm_status` — do not look for
it here or promise the user one.
