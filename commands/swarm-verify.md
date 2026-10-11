---
description: Audit a swarm run's record — ledger integrity, governance replay and spend
argument-hint: [run-id]
allowed-tools: mcp__plugin_political-swarm_swarm__swarm_verify_run, mcp__plugin_political-swarm_swarm__swarm_list_runs, AskUserQuestion
---

If no run-id was given in `$ARGUMENTS`, call `swarm_list_runs` and ask the user which run to verify unless there is only one.

Call `swarm_verify_run` for the run and report:

- **Verdict:** `ok` true or false.
- **Ledger:** how many entries, and how many are hash-chained. Entries written before the chain existed (`unchainedPrefix`) cannot be checked for edits; say so if there are any.
- **Governance:** decisions and mandates replayed from the ledger. Every decision the run acted on must match the ledger exactly, and each is re-judged under its declared rule.
- **Spend:** metered calls in the ledger against the run's recorded cost.
- Each `problem` verbatim: a problem means the record is inconsistent with itself (an edited ledger, a decision rewritten after the vote, spend that does not add up). Each `warning` separately, as worth a look but not evidence of tampering.

Do not soften a failed verification. The same check runs from a shell with `npm run verify:run -- <run-id>` in `mcp-server/` after a build.
