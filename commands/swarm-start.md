---
description: Start a governance-driven code swarm on a task
argument-hint: [task description] [--strategy=democratic|socialist|capitalist] [--budget=usd] [--repo=path] [--base-branch=name]
allowed-tools: mcp__plugin_political-swarm_swarm__swarm_start, AskUserQuestion
---

<!--
Section 5 of every doctrine in docs/philosophy/ defines Claude's role here, in identical words
across all three: Claude is the external, politically neutral orchestrator. It instantiates exactly
one doctrine per run — philosophies do not communicate with one another and do not run concurrently.
Claude may sequence phases, spin up model instances, pass artefacts between them, enforce resource
limits and resolve runtime failures. It must not replace, shortcut or overrule the doctrine's
internal decision procedure.
-->

Parse `$ARGUMENTS` for the task description and any `--strategy=`, `--budget=`, `--repo=`, or `--base-branch=` flags (`--base-branch` becomes `baseBranch`).

If `--strategy` was not given, ask the user (via AskUserQuestion) to pick one, briefly describing each:
- **democratic** — Westminster-style: committees + an adversarial opposition review every change, votes decide merges with thresholds scaled to risk (simple majority for routine work, supermajority + Security Committee for security-boundary changes).
- **socialist** — a federated council swarm: worker councils inspect the repository before the plan is written, a rotating coordinating council holds a bounded, recallable mandate, specialist guilds advise across councils, no agent reviews its own work, and overruled objections survive as minority reports.
- **capitalist** — an internal task-exchange: worker personas bid on subtasks, work is awarded by expected value (not just lowest price), and capital/reputation accounts gate who can take on risky work.

Determine `repoPath`: use `--repo=` if given, otherwise the current project's working directory. Confirm this is the correct target with the user before proceeding — the swarm will create an isolated git worktree and branch there, and never touches the real working tree until `/swarm-apply` is run and explicitly confirmed.

Capture the acceptance criteria **verbatim** from the user and pass them through unchanged. They are
sovereign over both Claude and the swarm, they become the requirement-to-test matrix the swarm must
produce evidence against, and they are what you will check the delivery against at the end. If they
are ambiguous, ask the user to clarify before starting rather than interpreting them yourself — no
interpretation may silently replace the user's instruction.

Exactly one doctrine runs per task. Do not offer to run two for comparison within a single run, and
do not mix mechanisms between them.

The swarm uses whatever OpenRouter models `/swarm-setup` last configured (or `config/models.yaml`'s built-in default if it's never been run). Mention `/swarm-setup` is available to change this, but don't block on it.

Call `swarm_start` with `{task, strategy, repoPath, baseBranch, budgetUsd, acceptanceCriteria, constraints}`.

`baseBranch` is the branch the isolated worktree forks from, and the one `/swarm-apply` eventually
merges back onto. It defaults to `main`, which silently forks from the wrong place for any repo
whose trunk is named differently — check the repo's actual default branch and pass `baseBranch`
explicitly whenever it is not `main`. `constraints` optionally carries extra plain-language
constraints (an array of strings) that reach the swarm's worker prompts alongside the acceptance
criteria.

Report the returned `runId`, `worktreePath`, and `branch`. Then explain how the run ends, because
the swarm finishing is not the same as the work being done:

- `/swarm-status` shows progress and any approvals only a human may resolve.
- `/swarm-diff` previews changes at any point.
- When the swarm reaches its own acceptance decision the run goes to **awaiting_acceptance**, not
  "completed" — its internal approval does not settle anything. Run `/swarm-accept` and Claude will
  independently check the delivery against the acceptance criteria, then either accept it or send
  concrete defects back to the same swarm.
- On the ordinary path, `/swarm-apply` requires that independent check to pass and the user's explicit
  confirmation. A `terminated_incomplete` run instead permits explicitly confirmed salvage through
  `allowPartialFromIncomplete: true`, subject to the tool's approval checks; report it as incomplete.
