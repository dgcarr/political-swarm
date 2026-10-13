---
description: Start a governance-driven code swarm on a task
argument-hint: [task description] [--strategy=democratic|socialist|capitalist] [--budget=usd] [--repo=path] [--base-branch=name]
allowed-tools: mcp__plugin_political-swarm_swarm__swarm_start, AskUserQuestion, Read, Glob, Grep, Bash(git status:*), Bash(git symbolic-ref:*), Bash(git branch:*)
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

Use the strategy selected in this conversation or `--strategy`. If neither exists, use `socialist`
and disclose that default briefly; do not require an everyday user to choose a governance model.
If the user asks about alternatives, describe them:
- **democratic** — Westminster-style: committees + an adversarial opposition review every change, votes decide merges with thresholds scaled to risk (simple majority for routine work, supermajority + Security Committee for security-boundary changes).
- **socialist** — a federated council swarm: worker councils inspect the repository before the plan is written, a rotating coordinating council holds a bounded, recallable mandate, specialist guilds advise across councils, no agent reviews its own work, and overruled objections survive as minority reports.
- **capitalist** — an internal task-exchange: worker personas bid on subtasks, work is awarded by expected value (not just lowest price), and capital/reputation accounts gate who can take on risky work.

Determine `repoPath`: use `--repo=` if given, otherwise the current project's working directory.
Use an already-established target without asking again. Ask only when multiple plausible targets
remain or no Git repository can be identified. The swarm creates an isolated worktree; applying
changes still requires the separate `/swarm-apply` confirmation.

### Turn an everyday prompt into a checkable brief

Expect short, blunt, misspelled or detail-light requests such as "fix the search" or "add CSV export".
Do this preparation yourself; do not ask the user to write a specification or acceptance criteria.

1. Read the relevant repository instructions, entry points, existing behavior, tests and check
   commands. Use focused inspection, not a repository-wide audit. Reuse context already established
   in the conversation. Never claim to have inspected something you could not access.
2. Preserve every explicit user criterion **verbatim** in `acceptanceCriteria`. User instructions
   override inferred requirements. When criteria are absent or incomplete, derive a small checklist
   of observable behavior from the request and inspected context. Include the main success case,
   relevant edge/failure behavior, compatibility that matters, and evidence that would demonstrate
   success. Do not pad simple work into a large feature, invent performance targets, add dependencies,
   or promise unrelated cleanup. A spelling error is not an ambiguity when intent is clear.
3. Prefix each added criterion with `Inferred: `; keep that exact text throughout the evidence matrix.
   Record consequential defaults separately in `constraints` as `Assumption: ... (basis: ...)`.
   Cite a concrete file, established convention or conservative default as the basis; distinguish
   inspected facts from guesses. Also carry scope boundaries and known validation commands in
   `constraints`. Do not invent command names or treat file existence as proof of correct behavior.
   Criteria and assumptions must travel in the actual tool arguments, not only in chat.
4. Ask a focused question only if an unresolved choice materially changes user-visible behavior,
   scope, data handling, security, compatibility, cost or an irreversible action, and the repository
   and conversation do not settle it. Explain the practical choice in plain language. Batch related
   blocking choices into one short question with a recommended option. Wait for the answer before
   starting dependent work. Do not invent essential domain rules, missing secrets, or authorization.
   Routine implementation details and reversible defaults do not require approval.
5. Otherwise show a short statement of what you will do and the important assumption(s), then start
   immediately. This is disclosure, not a request to approve a checklist. Keep the full brief in the
   tool call; do not overwhelm the user with internal process. If the user explicitly asks for no
   inference, honor that and retain their scope; disclose any verification gap instead of fabricating
   criteria.

Keep `task` self-contained: preserve the user's request, add only the relevant inspected context,
and identify the intended output and boundaries. Never send only a pointer to another instruction
file. Leave task decomposition, worker ownership and internal decisions to the selected doctrine.
Use the prepared checklist as the top-level `acceptanceCriteria`, so inferred requirements receive
the same evidence checks as explicit ones. Do not silently relax it after a failed check.

Examples:
- "fix the search" with a reproduced regression and existing tests: describe the observed failure,
  infer restoration of that behavior plus a regression test, preserve existing search conventions,
  and proceed. If neither context nor inspection identifies what is broken, ask what the user sees
  and what they expected instead of inventing a bug.
- "add CSV export" on an existing table: infer export of its displayed columns using the current
  export conventions, escaping commas/quotes/newlines and a content-level test. If filtered versus
  all-record export has no established convention and changes the intended scope, ask that one
  question; do not ask the user to choose a parser library or write test cases.
- "delete old customer records": ask about the retention cutoff and deletion semantics if not
  established; never guess a destructive policy.

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
