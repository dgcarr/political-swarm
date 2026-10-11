# Operations: runs, recovery and audit

This document covers what a run leaves on disk, what survives a crash, how to resume a run, and how to check that a finished run's record is complete and unaltered. For configuration keys, see [Configuration.md](Configuration.md). For the acceptance protocol between the swarm and Claude, see [Orchestrator-Contract.md](Orchestrator-Contract.md). For the threat model, see [`.github/SECURITY.md`](../.github/SECURITY.md).

## What a run leaves on disk

Each run has a directory under the runs root: `<plugin root>/runs/` by default, or `SWARM_RUNS_DIR` if set. The benchmark writes under `runs/benchmark/` instead.

| File | Contents | How it is written |
| --- | --- | --- |
| `state.json` | The run's current state: status, task graph, budget, governance decisions and mandates, the adopted constitution's digest and configuration, the delivery packet. | Rewritten whole on each change: written to a temp file, fsynced, renamed over the old one, then the directory is fsynced. A reader sees either the old state or the new one, never a torn file. |
| `ledger.jsonl` | The append-only audit trail: every plan, assignment, model call, vote, bid, verdict, check result and human decision. | One JSON line per event, fsynced before the call returns. Each entry carries a `seq` and the `prevHash` of the line before it (see below). |
| `transcripts.jsonl` | Full prompts and replies. Off by default; set `SWARM_FULL_TRANSCRIPTS=1`. | Appended and fsynced. Call ids are numbered per run. |
| `wt/` | The isolated git worktree on branch `swarm/<runId>`, where every change is made. | Ordinary files. The engine never writes to your repository outside it until `swarm_apply`. |

The knowledge store (`runs/knowledge/store.json`) is shared across runs and is written the same atomic way as `state.json`.

## Run states

| Status | Meaning | What you can do |
| --- | --- | --- |
| `running`, `remediation` | A loop is working on it. | `/swarm-status`, `/swarm-stop` |
| `paused_human`, `paused_budget` | Waiting for a human decision or more budget. | `/swarm-decide` |
| `awaiting_acceptance` | The doctrine accepted its own delivery and submitted it. | `/swarm-accept` checks it independently and either completes the run or returns defects. |
| `completed` | Claude accepted the delivery. | `/swarm-apply`, which needs explicit human confirmation. |
| `interrupted` | The server stopped while the run was active. | `/swarm-resume` |
| `terminated_incomplete`, `failed`, `stopped` | Ended without an accepted delivery. | `/swarm-apply` salvage of approved work only; see the command. |

## Crash recovery and resume

**What happens when the server stops:**
- On `SIGINT`, `SIGTERM`, `SIGHUP`, or MCP input EOF/disconnect, the server marks its active owned runs as `interrupted` and releases their leases, closes the dashboard and transport, and exits. Cleanup has a five-second deadline; if it cannot finish, the server exits with an error and startup recovery handles any remaining active states.
- If the process dies without warning (killed, power loss), the run still says `running`. On the next startup the engine checks the run's lease, which records the owner's process id and hostname.
  - If the owning process is gone from this machine, the run is marked `interrupted` at once.
  - An owner the engine cannot see, such as one on another host, is presumed dead only after 10 minutes without a heartbeat.

**What `/swarm-resume` (`swarm_resume`) does:**

Resume first acquires a per-run lock using an atomic Git reference update under `refs/political-swarm/resume/<runId>`. Competing requests are rejected before validation or execution. The lock is released after the new lease and loop are established, including on validation failure. A lock left by an exited process on this host can be reclaimed atomically; a live or unverifiable owner is never displaced.

1. It checks that the worktree still exists and that the run's recorded base revision is still an ancestor of it. If not, the run ends `terminated_incomplete`, with the reason.
2. It replays governance decisions and mandates from the ledger. A decision that was already made is reused, not made again, because decision ids are deterministic. The same replay happens on every relaunch of a run's loop, including the automatic requeue after a transient provider outage.
3. It recovers tasks that were cut off. Before applying a task's change, the engine saves a snapshot of the files it is about to touch. A task that was still running, or whose change was applied but not yet judged, gets its change reverted from that snapshot and is queued again. The ledger records `task_recovered_after_interrupt`.
4. It keeps the adopted constitution. The run continues under the configuration it adopted at start. If `strategies.yaml` has changed since, the ledger records `constitution_drift_on_resume` and the change is not applied to this run.

**Limits of recovery:**
- A model call that was in flight when the process died is lost. Its cost is not recorded, because spend is recorded only when a call returns. Every completed call's cost survives.
- A ledger line cut off by a crash is tolerated as the last line. The next write removes it and records `ledger_repaired`. A malformed line anywhere earlier is treated as corruption, and reading the ledger fails rather than replaying a wrong history.
- If one run's `state.json` cannot be read, that run is skipped with a warning. Every other run still loads.
- Resume requests are serialized across server processes, but other operations do not have a general cross-process transaction boundary. Continue to run one server per runs directory.

## Applying the reviewed snapshot

New delivery packets record an immutable Git `treeId`. Independent acceptance copies it to `acceptedTreeId` and records it in the ledger. Ordinary `swarm_apply` compares the current worktree with that accepted tree, commits exactly that tree, and applies the resulting commit by its fixed ID. Full and subset application both reject changes made after delivery, including changes made before acceptance was recorded.

If a completed worktree has changed, restore the reviewed files or start a new run to review the new content. Existing completed runs without these IDs cannot be applied through the ordinary accepted-delivery path; start a new run. A legacy run still awaiting acceptance can instead be returned for remediation to produce a new delivery. The explicitly confirmed incomplete-run salvage path retains its separate semantics and does not claim an accepted delivery.

## The audit trail

**The hash chain.** Each ledger entry's `prevHash` is the sha256 of the previous line, and `seq` counts from 1. Editing, deleting or reordering any entry breaks the chain at the next entry. Ledgers written before the chain existed have no `seq`; they are reported as an *unchained prefix*, which cannot be checked for edits. The chain shows that the file is internally consistent. It cannot detect a change to the very last line, or a whole file being replaced. For that, keep a copy of a finished run's final `prevHash`, or the whole run directory, somewhere else.

**Provenance of each decision:**
- `constitution_adopted`, the first governance record of a run, carries the whole constitution document: its articles, rights, declared decision rules, validated configuration and digest. The ledger alone says which rules governed the run.
- `governance_decision` records the deciding body, its eligible members, each member's position, the rule it was decided under, the result, and digests of the artefact it decided on.
- `worker_call` records the role, the persona, the task, the model, tokens, cost, and `promptDigest` and `responseDigest`: sha256 hashes of the exact messages sent and the reply received. `decision_call` records an `inputDigest`. When transcripts are kept, each transcript must hash to the digests in the ledger.

## Verifying a run

Run `/swarm-verify` in Claude Code, or `npm run verify:run -- <runId | run directory>` in `mcp-server/` after a build. It exits 0 when the record is consistent and 1 when it is not. It checks:

1. **The hash chain**, entry by entry.
2. **The constitution.** The adopted document must match its own digest and the digest in `state.json`, and must be adopted exactly once.
3. **Governance replay.** Every decision and mandate is rebuilt from the ledger alone, and those in `state.json` must match exactly. Every decision is re-counted:
   - its rule must be one the adopted constitution declares;
   - its result must follow from its ballots.
4. **Spend.** Metered calls in the ledger may not total more than the run's recorded cost. Recorded spend with no metered call in the ledger is reported as a warning.

*Problems* mean the record contradicts itself. *Warnings* are worth a look but are not evidence of tampering; for example, a live run's `state.json` can lag its ledger by one save. `npm run example` shows a verification passing on an honest record and failing on an edited copy.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| `/mcp` shows the server with 0 tools, or old tools | The build is missing or stale: run `npm run build` in `mcp-server/`. If you installed through the marketplace, the server runs from the plugin cache copy; update or reinstall the plugin after pulling. |
| The server exits at startup naming a `strategies.yaml` key | The file failed schema validation. Fix the named key; see [Configuration.md](Configuration.md). |
| Model calls fail with 401 or 402 | `OPENROUTER_API_KEY` is missing or out of credit. The server loads `<plugin root>/.env`, and the key may also come from the launching shell. |
| Model calls fail with 400 on JSON output | That model does not support the requested response format. `npm run probe:models` and `npm run bench:models` grade models before you configure them. |
| A run ends `terminated_incomplete` | Read `lastError` in `/swarm-status`. Common causes: the attempt limit was reached for a task, the budget or wall clock ran out, or the doctrine's own institutions refused the plan. Approved work can be salvaged with `/swarm-apply`. |
| Every check is "skipped" | The target repository lacks the commands in `config/checks.yaml` (default `npm test`). Configure checks for the repository's language. A skipped required check blocks acceptance; it never counts as a pass. |
| Checks fail only with `sandbox: bubblewrap` | The check needs the network or writes outside the worktree, for example to download packages. Install dependencies first, or turn the sandbox off for that repository. |
| A run stays `running` after a crash | Restart the server: a run whose owner process is gone is marked `interrupted` at startup. Then `/swarm-resume`. |
| The dashboard does not load | Port 8731 is in use, or `SWARM_DASHBOARD=0` is set. Set `SWARM_DASHBOARD_PORT`. |
