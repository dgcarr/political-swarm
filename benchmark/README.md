# Coding Swarm Benchmark harness

Repeatable harness for the benchmark defined in `docs/Coding-Swarm-Benchmark.md`: run the same
task against the democratic, socialist, capitalist, managerial, and single-agent strategies and compare the
engineering output. This lives outside the plugin surface — it's not a command/skill shipped to
plugin users, just a local tool for evaluating the swarm engine itself.

## Layout

- `starting-repo/` — the shared starting point given to every run (same content, `baseBranch`
  `main`, for all five strategies). Contains `TASK.md` (an extended version of
  `docs/Coding-Swarm-Benchmark.md` — adds a supplied-data notice, unit-bearing CSV header
  requirements, the `--provenance` flag, the `alloydamage/__main__.py` requirement, and the
  provenance-field detail; every arm receives it), pre-fetched
  IAEA-NDS Fe/Cr/Ni displacement-damage cross-section data under `data/` with per-element
  `PROVENANCE.md`, and a `package.json` whose `test` script runs `python -m pytest` (see "Why
  package.json" below). Plain files tracked directly in this repo — deliberately **not** its own
  nested git repo (that would only show up as an opaque submodule gitlink to the outer repo).
  `swarm_start` needs a real git repo to fork worktrees from, so each `npm run benchmark`
  invocation copies `starting-repo/` into a disposable scratch repo under `runs/` (gitignored)
  and `git init`s it fresh before launching any strategy.
- `raw-source/` — the original ENDF-6 `.dxs` files fetched from IAEA-NDS and the extraction
  script (`extract_nrt_dpa.py`) that produced `starting-repo/data/*/*.csv`. Kept for audit/
  reproducibility of the data-prep step; not part of what swarms see.
- `oracle/` — the hidden, evaluator-owned oracle: the 12-check independent suite
  (`checks.py`, `reference_data.py`, `submission.py`, `report.py`) run via `run_oracle.py`. Not
  part of what swarms see. To rescore an arm by hand, use the benchmark venv:
  `benchmark/.venv/bin/python benchmark/oracle/run_oracle.py <results>/<arm>/worktree`. The system
  `python3` lacks matplotlib, so every check that imports the package fails and a 12/12 arm reads
  about 1/12.
  Read an arm's score as two numbers, not one total: `metrics.json` and `summary.json` carry
  `oracle.runsEndToEnd` and `oracle.passed`/`oracle.evaluated` (label like `runs: no (10 blocked) ·
  functional 1/2`), and the oracle prints the same line. Ten of the twelve checks invoke the CLI, so
  one traceback on its path fails them all; blocked checks (never judged, per
  `NEVER_EVALUATED_PREFIXES` in `oracle/report.py`, plus every failed check in `PROGRAM_CHECK_IDS`
  once check 1's pure-Fe calculation cannot run) are left out of the functional score.
- `requirements.txt` — pinned Python packages for the benchmark venv.

**Reading `costUsd`.** It is OpenRouter's own charge per call, requested with `usage: {include: true}`
and used in preference to the `config/models.yaml` price table, which remains only as a fallback for
a provider that reports none. `metrics.json` says how much of a figure is estimated
(`estimatedCostCalls`) and how many calls threw before producing any usage at all
(`unmeteredCalls` — their spend is real and cannot be priced from here). Before 2026-09-24 every
figure was computed from the local table alone: one trial estimated at about $7 was billed roughly
$20, most of it on `z-ai/glm-5.2`, the implementer model at 12x the input and 18x the output price of
every other role. A single hardcoded price per model also cannot be right when OpenRouter routes the
same model to several providers at different rates.
- `.venv/` — the benchmark Python environment, auto-created from `requirements.txt` on first run
  and rebuilt when that file changes (see "Why `package.json` exists" below). Not tracked.
- `verify_provenance.py` — checks the SHA-256 hashes recorded in each element's `PROVENANCE.md`
  against `raw-source/` and the derived CSVs.
- `generate_dashboard.py` and `dashboard_template.html` — build the static results dashboard
  (see "Dashboard").
- `results/` — one directory per benchmark execution: a run-level `environment.json` (Python
  version, full pip freeze, node version, and OS), `manifest.json`, `summary.json`, plus
  `<timestamp>__<label>/<strategy>/` directories, each containing `state.json`, `ledger.jsonl`,
  `diff.patch`, a `worktree/` snapshot, `check-artifacts/` (when the run produced any),
  per-strategy `coverage.json`, and `metrics.json`. Gitignored (see note below) since
  these are large per-run artifacts.
- `score-rubric.md` — the rubric to apply after a run (see that file).

## Running a benchmark

From `mcp-server/`:

```bash
npm run benchmark -- --label <name>
```

Optional flags: `--strategies democratic,socialist` (default: all five), `--budget-usd 8`
(default 8; the engine's hard ceiling is $10/run regardless of what's passed), `--repo <path>`
(source directory to copy from, default `../benchmark/starting-repo` — plain files, not itself a
git repo), `--max-wall-clock-min 150` (default 150), `--trial-index 0` (default 0; rotates the
strategy execution order so sweep trials can vary which strategy runs first, and seeds every arm's
lots, such as sortition, councils, appeal panels and subcontracts, with `benchmark-trial-<n>`, so
arms in one trial share draws instead of each run's random id adding noise; runs before
2026-10-06 drew from their run id),
`--poll-timeout-ms` (harness poll timeout; default `(max-wall-clock-min + 15)` minutes, in ms),
`--call-timeout-ms 600000` (default 600000 ms; implementer ceiling only), `--allowance-usd 8`
and `--allowance-extensions 2` (each arm's own budget-increase and wall-clock-extension allowance
described below), `--resume <results-dir>` (see below;
`--label` or `--resume` is required), and `--full-transcripts` (see "Full logging").

The planner ceiling is 600000 ms and other roles use 300000 ms. Calls stream and fail over after
60000 ms without a first token or 30000 ms of silence between tokens; role timeouts are overall
ceilings.

`--decision-models off|pure` (default `pure` since 2026-10-05; earlier sweeps ran `off`): `pure` consults decision models for bounded governance
choices such as ballots, votes, rulings and allocation, using the configured decider role (primary
`upstage/solar-decide`) through OpenRouter's alpha Decisions API. Work reviews still use written
chat responses. `explain` is no longer accepted. The mode is recorded in the manifest; compare
sweeps using the same mode.

This calls `SwarmEngine.startRun` directly (same pattern as `mcp-server/src/smoke/*.ts`) for each
requested strategy, sequentially by default, against isolated git worktrees — no MCP/chat session
needed. `--concurrent` exists only as a stress mode; controlled comparisons should remain sequential
to avoid provider contention bias.

`--stop-after plan|first-task` stops each arm once its plan has at least one task or at least one
task has settled or been abandoned, respectively. Omit it for a full run. These stage-limited runs
are for debugging; their scores are not comparable with full benchmark runs.

Runs typically take significant wall-clock time and real OpenRouter spend; start with a cheap
single-strategy smoke run:

```bash
npm run benchmark -- --label smoke-test --strategies democratic --budget-usd 0.5
```

### Full logging

Every run already writes `ledger.jsonl` (every institutional event) and `metrics.json` per arm
regardless of any flag. Two things are opt-in on top of that:

- **stdout/stderr** — the harness prints progress to the console but doesn't file it anywhere on
  its own; capture it with `tee` if you want a persistent record alongside the run:
  ```bash
  npm run benchmark -- --label <name> 2>&1 | tee ../benchmark/results/<name>.harness.log
  ```
- **`--full-transcripts`** — also writes `transcripts.jsonl` per arm: the exact system/user prompt
  sent and the raw model response for every call (`WorkerDispatcher.callAndRecord`), keyed by a
  `callId` that's echoed onto the matching `worker_call` ledger entry so the two files can be
  cross-referenced. Off by default — with repository tools in play a single call's prompt can carry
  file contents up to `MAX_TOOL_BYTES`, so this is meaningfully larger than a normal run's
  artifacts. Equivalent to setting `SWARM_FULL_TRANSCRIPTS=1` (`Ledger.recordTranscript`), which is
  also what the interactive engine and any smoke script honor, not just the benchmark harness.

A fully logged complete sweep (all five strategies, default budget/wall-clock), with both of the
above:

```bash
npm run benchmark -- --label <name> --full-transcripts 2>&1 | tee ../benchmark/results/<name>.harness.log
```

The harness has no human in the loop, so approvals that would normally wait for `/swarm-decide`
are answered in two ways, identically for all five strategies:

- **The sovereign decides every doctrine escalation** (`final_diff`, `test_waiver`,
  `vote_threshold`, `spend_approval`, `confidence_vote`). The sovereign is the model the user has
  selected in Claude Code, called through `claude -p` (`mcp-server/src/benchmark/sovereign.ts`) with
  `--safe-mode` and no tools, so nothing in this repository coaches it and it sees only the
  escalation, the task, the required checks and the current diff. The prompt names no doctrine.
  Each consultation records model, cost and fallback metadata in a `sovereign_decision` event;
  its rationale is recorded in the associated `external_evaluator_decision` note. If Claude is
  unavailable or returns no usable answer, the fixed policy below decides and the fallback is recorded.
  - The engine receives the sovereign's actual rationale, so a rejected task's next implementer
    can use it. The same feedback policy applies to every arm.
  - Approvals opened for the same task at the same time (a doctrine's own, such as democratic
    `vote_threshold`, plus the engine's `final_diff`) are put to the sovereign once, with every
    description, and the one answer settles all of them.
  - The sovereign's cost is harness spend, not the arm's `costUsd`. It is reported per arm in
    `metrics.json.sovereign` (`calls`, `fallbacks`, `costUsd`), because doctrines escalate at very
    different rates.
- **The fixed evaluator policy** (`mcp-server/src/benchmark/evaluatorPolicy.ts`) still owns
  `budget_increase` and `wall_clock_extension`, approved only within each arm's own fixed allowance
  (`--allowance-usd`, default 8; `--allowance-extensions`, default 2 of 15 minutes each). Until
  2026-09-22 this was one pool shared by the whole sweep, so an arm that ran early could spend the
  extensions a later arm needed. It is also the sovereign's fallback, under which `test_waiver`,
  `vote_threshold`, `spend_approval` and `confidence_vote` are rejected and `final_diff` is approved
  only when required independent check results are supplied and no required category regressed.
  Categories marked `failedAtBaseline` may remain incomplete for this task, but final delivery
  remains strict.

Deliveries are accepted only if automated evidence for every mandatory criterion and independent
verification pass, and the oracle gate below still applies. `metrics.json.autoApprovals` lists every resolved
approval, rejections included. Outside the benchmark, every escalation still waits for the human.
A run that's still over budget after an approved increase (i.e. it hit the $10 hard ceiling) is
left in `paused_budget` as a genuine terminal outcome, not retried.

Before the first strategy starts, the harness writes `manifest.json`. It updates that manifest,
each strategy's `metrics.json`, and the atomic `summary.json` immediately after every terminal
result. Interrupted sweeps can be continued without resetting run deadlines or budgets:

```bash
npm run benchmark -- --resume ../benchmark/results/<timestamp>__<label>
```

SIGINT and SIGTERM mark engine-owned active runs `interrupted`, capture their synchronization
packets, persist the manifest, and exit. A resume refuses a worktree that no longer validates or a
run still held by another live engine lease.

## Acceptance and scoring

The benchmark sets `manualEvidenceAccepted: false`. Every acceptance criterion must map to an
available automated check category in the test mandate; manual inspection cannot satisfy headless
acceptance. Source-organization and generated-file requirements must be demonstrated by unit tests
that inspect the repository's files.

Per-task checks answer a narrow question: did this task regress a required category that genuinely
passed on the latest accepted tree? Categories that are still incomplete because later components
have not landed are evidence for reviewers, but do not falsely reject the early task. Final checks
are different: every required category must run and pass on the combined tree. The benchmark adds
the literal CLI invocation as a final-only category.

When a doctrine reaches its acceptance barrier, the harness runs the independent evaluator-owned
oracle against the live worktree before `acceptDelivery`. All 12 checks must pass. Failures return to
the same doctrine as scoped oracle remediation; pytest alone cannot satisfy CSV, CLI, plotting,
provenance, composition, or interpolation criteria. Coverage and the later scoring pass are
reporting only and cannot replace acceptance evidence.

## What every arm receives

All five arms receive the same task-agnostic guidance, and nothing beyond it. Every planner is told
that runtime outputs are check artifacts, that required invocations need an owned entry point, that
at least one task must own a test file, that criteria must not contradict each other, and that every
file has exactly one owning task (`WorkerDispatcher.runtimeArtifactPlanningSection`). Every
implementer is given the same reminders through `strategies/implementerReminders.ts`: `python -m`
needs `__main__.py`; don't silently extrapolate or clamp outside the data's own range; parse the key
names the real files use; derive a test's expected values from something independent of the code
under test. Every implementer prompt also carries the whole goal, not only its
task's text, and every implementer call uses the same temperature (`IMPLEMENTER_TEMPERATURE`). No
arm is told which language, module system or test framework to use. Engine rules are the same for
every arm: every doctrine's rejection becomes another attempt up to the shared `maxTaskAttempts`.
`strategies/benchmarkNeutrality.test.ts` fails if any strategy or the dispatcher mentions the
benchmark task's vocabulary, if any arm's implementer prompt lacks the goal or the shared reminders,
if any prompt names a language or test framework, or if an arm samples its implementer differently.

The knowledge store (`runs/benchmark/knowledge/store.json`) is shared across runs outside the
benchmark. The harness sets `isolateKnowledgePerRun`, so each run reads only what it wrote itself:
only democratic and socialist consult the store, and memory carried over from earlier runs would
help those two arms alone and make repeated trials depend on one another.

Differences that remain are properties of each doctrine, paid from the same budget: how many
institutional calls it makes, and which escalations it sends to the sovereign.

Until 2026-09-22 the capitalist implementer was told to write Node.js with `node:assert` tests, the
democratic and single-agent implementers never saw the goal, implementer temperatures ranged from 0
to 0.2, and the sovereign's rejection rationale reached the next implementer. Results recorded
before then are not a like-for-like comparison.

The oracle is hidden in the sense that no arm sees its code or its reference data before the
acceptance barrier. A failed check's id and description come back to the swarm as an
`origin: 'oracle'` finding for bounded remediation, and `SwarmEngine.ORACLE_OWNERSHIP_PATHS` routes
each check to the files that usually own it. Since 2026-10-07 its detail does not: that text carries
the oracle's expected values and probe inputs, and one arm's sovereign had rejected correct code by
quoting them (`oracleRemediationFindings`). The detail stays in the delivery for scoring. This
applies equally to every arm; earlier runs repaired with the detail in view.

Until 2026-09-21 the democratic arm also received alloy-specific guidance and checks that the
other arms did not (`strategies/democratic/outputContract.ts`, since removed). Democratic results
recorded before that date are tuned and not comparable with the other arms.

`summary.json.releaseGate` passes only when democratic, socialist, capitalist, and managerial each
finish `completed` with 12/12 oracle checks. Single-agent is always reported for comparison but is
not a release gate.

## Comparing different models or strategy tunables

Model selection (`config/models.local.json`, written by `/swarm-setup`) and strategy tunables
(`config/strategies.yaml`) are **global**, not per-run — every concurrently running strategy in
one `npm run benchmark` invocation shares them. To compare a different model or tunable set:
change the config, then re-run the whole harness with a new `--label` so results don't overwrite
each other. `benchmark/results/*/summary.json` records the label and args used for each run.

## Why `package.json` exists in `starting-repo/`

The engine's per-task verification step runs whatever `config/checks.yaml` (or an in-memory
override) configures — `runBenchmark.ts`'s `buildEngine()` supplies three required per-task
categories: `python-syntax` (`python -m compileall -q .`), `unit` (a Python wrapper around
`pytest.main()` that maps exit code 5, no tests collected, to success), and `package-import`
(`import alloydamage`). Two final-only checks remain: `benchmark-import` (imports `alloydamage`
and `alloydamage.cli`) and `benchmark-cli` (`python -m alloydamage calculate examples/304L.yaml`).
Empty-suite success establishes the baseline; the acceptance oracle still requires a nonempty
passing test suite. Until the tests task writes one, a task's repair brief lists `unit` as having
no tests yet rather than as failing, so tasks that own no tests are not told to fix it. This gives every strategy real regression feedback during its run, not just
at the final scoring pass. The Python used is `benchmark/.venv`, provisioned automatically by
`ensureBenchmarkPython()` from `requirements.txt` (pytest, pytest-cov, numpy, matplotlib, pyyaml);
no host packages need installing, only a `python3` able to create a venv (on Debian/Ubuntu that
means installing `python3-venv`).

`package.json` itself is still required even though the engine no longer depends on its `test`
script to reach pytest: `strategies/capitalist/diligence.ts` and `strategies/socialist/
reconnaissance.ts` read `package.json` directly as part of their own due-diligence/reconnaissance
steps (declared-test-command detection, manifest discovery), independent of the engine's check
path — removing it would change what those two strategies see about the repo, not just how tests
run.

The oracle gate is acceptance, not the comparative score. See `score-rubric.md` for the separate
reporting rubric; it can be re-run without changing whether a delivery was accepted.

## Dashboard

```bash
python3 benchmark/generate_dashboard.py
```

Scans every `results/<run>/<strategy>/metrics.json`, embeds them into
`dashboard_template.html`, and writes `results/dashboard.html` (gitignored, like the rest of
`results/`) — a static comparison table of every strategy result, sortable and filterable by
doctrine and run, plus three small charts: cost per run, test pass rate, and oracle checks
passed. Re-run the script after any new
benchmark run to refresh it; open the output file directly in a browser.

## Visualizing one arm's run as a graph

```bash
python3 benchmark/generate_run_graph.py results/<timestamp>__<label>/<strategy>
```

Requires the `graphify` CLI (the same one that builds this repo's own code graph) on PATH.
Reads that single arm's `state.json` (the task graph and its `dependsOn` edges) and
`ledger.jsonl` (every institutional event — worker calls, votes, motions, committee findings,
guild assignments, ...), builds a graphify-shaped `graph.json` where each ledger event becomes an
edge labeled with that event's own type between whichever actor and task it names, and renders it
with `graphify export html` — the exact interactive viewer graphify uses for source code, reused
unmodified. Writes to `graphify-out-runs/<timestamp>__<label>__<strategy>/` (gitignored, like
`results/` and `graphify-out/`); open `graph.html` directly in a browser, no server needed.

Because each doctrine writes its own event vocabulary to the ledger, the resulting graphs look
visibly different by doctrine: democratic's reads as `committee_inquiry`/`division_recorded`/
`speaker_ruling` edges radiating from task nodes, socialist's as `guild_assigned`/`work_executed`/
`coordinator_arbitration`, capitalist's as `firm_formed`/`listing_awarded`/`bailout_considered`.
`worker_call` (routinely the largest single event type) carries a `personaId`/`role` but no
`taskId`, so it's wired to a shared per-role hub node rather than a task; a handful of rarer
event types that name a task but no specific actor (`task_decided`, `vote_computed`,
`speaker_ruling`'s admissibility check) currently produce no edge at all — visible in the task
node's own `phase` from `state.json`, just not as a separate edge. `--no-html` writes `graph.json`
only, and `--out-root <dir>` overrides the default output location.
