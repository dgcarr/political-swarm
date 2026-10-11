---
description: Apply an approved swarm diff to the real working repo
argument-hint: [run-id]
disable-model-invocation: true
allowed-tools: mcp__plugin_political-swarm_swarm__swarm_status, mcp__plugin_political-swarm_swarm__swarm_get_diff, mcp__plugin_political-swarm_swarm__swarm_apply
---

<!--
MANUAL APPROVAL REQUIRED.
This is the only command in the plugin that writes to the user's real working tree.
disable-model-invocation is set so this can only be triggered by the user typing /swarm-apply themselves, never invoked autonomously by Claude via the SlashCommand tool.
-->

0. Call `swarm_status` for the run. The ordinary path requires `completed`, meaning Claude has already run its independent check via `/swarm-accept`. If the run is `awaiting_acceptance`, tell the user to run `/swarm-accept` first and stop here; do not perform that check inside this command, because applying and accepting must not collapse into one step. The only exception is a `terminated_incomplete` run: `swarm_apply` still refuses it unless called with `allowPartialFromIncomplete: true`, and even then it writes only the approved subset, never work that was rejected, abandoned, or remains pending. Every other status must be refused. `completed` is still not enough on its own: `swarm_apply` also refuses to apply while the run has any unresolved approval, even on a completed run. `swarm_status` reveals them in `pendingApprovals`; resolve each with `/swarm-decide` before applying.
1. Call `swarm_get_diff` for the given run and show the user the full diff again, even if it was already shown earlier in this conversation.
2. If the run is `terminated_incomplete`, before asking for confirmation say plainly that the run did not complete, name `lastError` when the status result provides it, and report how many `progress.approved` tasks will be salvaged, how many `progress.pending` tasks never reached approval, and how many `progress.rejected` tasks were rejected or abandoned and will not be applied. Do not present this as an ordinary successful run.
3. Ask the user to literally confirm they want to apply it (e.g. "yes, apply"). Do not infer approval from earlier conversation or from the fact that this command was run — an explicit confirmation must happen in this exchange. This confirmation is equally mandatory for an incomplete-run salvage.
4. Only after that explicit confirmation, call `swarm_apply`. Pass `allowPartialFromIncomplete: true` only when the status is `terminated_incomplete`; do not pass it as a general fallback for any other status. Two further optional arguments exist: `taskIds` applies only the named tasks: just the files they own, as one new commit on the base branch. Each must already be approved, and every task one of them depends on must be included or the tool refuses. It also refuses, changing nothing, if the real repo has staged changes or uncommitted edits to those files, or if the base branch has since changed the same lines. Report `excludedFiles` (changed files left in the run) and `remainingDiff` (approved tasks not yet applied) to the user; the rest can be applied later with another `taskIds` call. `commitMessage` overrides the auto-built commit message. Omit both on the ordinary path.
   `swarm_apply` also refuses, changing nothing, when the diff touches files that run code on the user's machine or in CI: workflow and CI configs, git hooks and `.gitattributes`/`.gitmodules`, `package.json`, `pyproject.toml`, `setup.py`, `Makefile`, `tox.ini`, `noxfile.py`, `.npmrc`, `.envrc`, `.vscode/tasks.json`, `.pre-commit-config.yaml`. Its refusal lists them. Show the user exactly those files' changes from the diff, say that merging them can execute code, and ask for a second explicit confirmation naming them. Only then call `swarm_apply` again with `confirmSensitivePaths: true`. Never pass it pre-emptively.
5. Report the applied files and commit SHA. Remind the user to run their own test suite and review the commit before pushing it anywhere.
