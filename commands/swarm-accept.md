---
description: Independently check a swarm's delivery packet, then accept it or return concrete defects
argument-hint: [run-id]
allowed-tools: mcp__plugin_political-swarm_swarm__swarm_get_delivery, mcp__plugin_political-swarm_swarm__swarm_get_diff, mcp__plugin_political-swarm_swarm__swarm_list_runs, mcp__plugin_political-swarm_swarm__swarm_accept, mcp__plugin_political-swarm_swarm__swarm_remediate, AskUserQuestion
---

<!--
This command is the orchestrator boundary described in section 5 of every file in docs/philosophy/,
where the text is identical across all three doctrines:

  "At delivery, Claude receives a final delivery packet containing the implementation, evidence,
   test results and disclosed risks. Claude independently checks the code, tests, scope compliance,
   unresolved risks and repository state. It may reject the result and return concrete defects to
   the same political swarm for remediation."

The swarm has already approved this work under its own rules. That is not what this command is for.
Internal approval never binds Claude.
-->

If no run-id was given in `$ARGUMENTS`, call `swarm_list_runs` and pick the run whose status is
`awaiting_acceptance`; if several are, ask which one.

Call `swarm_get_delivery`. If the run is not `awaiting_acceptance`, relay what the `note` says and
stop — there is nothing to accept.

**Then do the check yourself. Reading the packet is not the check.**

1. **Trace every acceptance criterion.** For each entry in `requirementMatrix`, find the code in the
   diff that implements it and the command whose result demonstrates it. A criterion whose status is
   not `satisfied` is unmet until you can show otherwise. `independentCheck.criteriaWithoutSatisfyingEvidence`
   lists these, but do not trust the list over your own reading of the diff.
   Criteria in `independentCheck.criteriaRestingOnManualInspection` did **not** block the swarm's
   acceptance gate: they were marked for manual inspection because no check could demonstrate
   them, so no command proved them. You are the manual inspection. Perform each `inspection` it
   names, or confirm the evidence it asks for, before counting that criterion as met.
2. **Read the complete diff**, not the summary. Call `swarm_get_diff` if you need it separately.
   Follow the changed call paths far enough to see what the change actually does.
3. **Check scope.** Changes outside what the user asked for are a defect even when they are
   improvements — say so rather than accepting them silently.
4. **Check the evidence, not the claim.** `finalChecks` carries exact commands and results. A check
   that was skipped, or one flagged `failedAtBaseline`, proves nothing about this change. A passing
   suite with no relevant assertion is not proof of correctness.
5. **Read every unresolved and deferred finding.** A finding marked `nonWaivable` that is still open
   blocks acceptance. A `deferred` finding without a real owner and return condition is not deferred,
   it is dropped.
6. **Read the minority reports.** Preserved dissent is evidence, not noise. Where dissent identifies
   a real problem the majority waved past, that is your defect to name.
7. **Check the repository state**: `changedFiles` against the branch the run was based on.

Then take exactly one of two actions:

- **Accept** — call `swarm_accept` with a `note` saying what you actually established (which criteria
  you traced, which evidence you read). Tell the user the run is complete and `/swarm-apply` can now
  write it to the real repository with their explicit confirmation.
- **Reject** — call `swarm_remediate` with one finding per concrete defect: what is wrong, the
  evidence for it, severity, and `affectedTaskIds` where you can name them. Then tell the user the
  work went back to the same swarm and that `/swarm-status` will show when a new packet is ready.
  Delivery remediation is limited to two cycles shared between the swarm's internal delivery repairs
  and Claude's returns. Earlier internal repairs may leave fewer than two returns available to you.
  If `swarm_remediate` reports "exhausted delivery remediation cycles", the run remains
  `awaiting_acceptance`; report the unresolved defects and exhausted allowance to the user rather
  than retrying the return or accepting unverifiable work.

Do not accept a delivery you could not verify. If the packet leaves you unable to tell either way —
missing evidence, an unreadable diff, a criterion you cannot trace — that is a rejection with
"evidence missing" as the finding, not an acceptance with a caveat. Never describe unverified work
as complete.

You are checking the swarm's output, not overruling its politics. Do not re-run its votes, re-award
its contracts or second-guess which council should have owned what: name defects in the delivered
work and let the doctrine decide how to repair them.
