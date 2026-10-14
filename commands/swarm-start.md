---
description: Start a coding swarm
argument-hint: [task description] [--strategy=democratic|socialist|capitalist] [--budget=usd] [--repo=path] [--base-branch=name]
allowed-tools: mcp__plugin_political-swarm_swarm__swarm_start, AskUserQuestion, Read, Glob, Grep, Bash(git status:*), Bash(git symbolic-ref:*), Bash(git branch:*)
---

Claude prepares the request and checks the result. The chosen strategy controls how the swarm
plans, assigns and reviews its work. Do not replace its decisions with your own.

Parse `$ARGUMENTS` for the task description and any `--strategy=`, `--budget=`, `--repo=`, or `--base-branch=` flags (`--base-branch` becomes `baseBranch`).

Use the strategy selected in this conversation or `--strategy`. If neither exists, use `socialist`
and disclose that default briefly; do not require an everyday user to choose a governance model.
Explain alternatives only if asked: democratic uses votes and opposition review; socialist uses
worker councils and peer review; capitalist uses bids and contracts.

Determine `repoPath`: use `--repo=` if given, otherwise the current project's working directory.
Use an already-established target without asking again. Ask only when multiple plausible targets
remain or no Git repository can be identified. The swarm creates an isolated worktree; applying
changes still requires the separate `/swarm-apply` confirmation.

### Prepare the request

Short or vague prompts are normal. Read the relevant code and tests; reuse what you already know.
Do not ask the user to write a specification.

- Keep the user's stated requirements word for word. For simple tasks, add about 3–5 testable
  requirements labeled `Inferred: ` in `acceptanceCriteria`. Avoid overlap, but never drop a needed
  requirement to meet that target. Respect a request not to infer anything.
- Keep `task` short and clear on its own. Put limits and known test commands in `constraints`.
  Record important guesses there as `Assumption: ... (basis: ...)`, with the code or convention
  behind each one. Do not repeat requirements across fields. Tests must check behavior, not just
  whether a file exists. Do not invent features, evidence, business rules or permission.
- Ask only if a missing answer changes what gets built, which data is used, safety, compatibility,
  cost, or an action that cannot be undone. Check the code and conversation first. Group related
  questions and wait for answers before starting. Do not ask about routine coding choices or typos.
- Otherwise say briefly what you will build and any important assumptions, then start. Do not ask
  for checklist approval. The user's instructions take priority. Keep requirements unchanged during
  review; never weaken them just to pass a test. Let the swarm plan and divide the work.

Use one strategy per run. If the user requests a comparison, use separate runs.

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
