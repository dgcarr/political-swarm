# Configuration reference

Everything the MCP server reads from disk and from the environment. Every key, default and meaning
below is taken from the code that reads it; the file cited at the top of each section is the source
of truth if this page and the code ever disagree.

## Where configuration lives, and when it is read

All four files live in one directory: `SWARM_CONFIG_DIR`, or `<plugin root>/config` when that is
unset (`mcp-server/src/index.ts`). **There is one configuration for every target repository.** The
server does not look for per-repo config, so whatever `config/checks.yaml` says is what runs against
every repo you point a swarm at. The checked-in `checks.yaml` runs `npm test`, `npx tsc --noEmit` and
`npm run lint`; a Python (or any non-npm) repository needs that file edited first, or its required
`unit` check will fail and block acceptance.

| File | Loaded | Takes effect |
|---|---|---|
| `config/budget.yaml` | once, at server start (`buildDependencies` in `index.ts`) | after an MCP server restart |
| `config/strategies.yaml` | once, at server start, validated | after a restart; a run keeps the constitution it adopted (see below) |
| `config/models.yaml` | once, at server start | after a restart |
| `config/models.local.json` | re-read at every run start (`resolveModelsConfig`) | the next `swarm_start` |
| `config/checks.yaml` | re-read at every run start and context build (`loadChecksConfig`) | the next `swarm_start` |

The benchmark harness (`mcp-server/src/benchmark/runBenchmark.ts`, `buildEngine`) loads the same
files and then overrides some values **in memory only**: wall clock, per-call ceilings, stall
timeout, the whole checks configuration (Python checks, `manualEvidenceAccepted: false`). Nothing it
does writes to `config/`.

---

## config/budget.yaml

Read by `loadBudgetConfig` in `mcp-server/src/util/config.ts` (type `BudgetConfig`) and enforced by
`mcp-server/src/engine/BudgetGuard.ts`. There is no schema validation: keys are read as written,
and an unknown key is ignored. Only `maxTaskAttempts` has a code default (3) when absent.

Budgets are admission limits checked **before** each model call against recorded spend. In-flight
calls can carry actual spend past a limit before the next check, so they are not a guaranteed
maximum bill.

### `defaults`

| Key | Checked-in value | Meaning |
|---|---|---|
| `perRunUsd` | `2.00` | Starting budget of a run when `swarm_start` is not given `budgetUsd`. When spend reaches the run budget the next call throws and the run opens a `budget_increase` approval; approving it without an amount raises the budget by another `perRunUsd` (`SwarmEngine.decide`). |
| `perTaskUsd` | `0.30` | Default task envelope. The socialist doctrine sizes need-weighted reservations from it, and an exhausted envelope is topped up by this amount from uncommitted run funds (`handleTaskError`). |
| `maxWorkerCalls` | `800` | Hard cap on model calls in one run; reaching it stops further dispatch. |
| `maxWallClockMinutes` | `30` | Sets the run's deadline at start. Exceeding it opens a `wall_clock_extension` approval; approving adds 15 minutes, rejecting ends the run `terminated_incomplete`. |
| `maxTaskAttempts` | `8` | Ceiling on attempts (including doctrine-requested rework) for one task. Bounds resources, not doctrine judgment; livelock is caught separately by the attempt fingerprint. Code default when absent: `3`. |
| `maxInstitutionalCallsPerTask` | `24` | Optional. Ceiling on institutional (governance, non-engineering) dispatches charged to one task; reaching it records `institutional_call_ceiling` and fails the call. The final delivery review is exempt. Unset means no ceiling. |
| `stallTimeout.firstTokenMs` | `60000` | Optional block. When present, every chat call **streams**, and an attempt is abandoned for the fallback model if no token arrives within this many ms. OpenRouter keep-alive comments do not count as tokens. |
| `stallTimeout.betweenTokensMs` | `30000` | Abandon the attempt if the stream goes silent this long mid-answer. Remove the whole `stallTimeout` block to go back to unstreamed calls bounded by the ceilings alone. |
| `perCallTimeoutMs` | `300000` | Hard ceiling on one call. With `stallTimeout` set it only bounds a model that keeps producing tokens. Decision (`api: decisions`) calls are additionally capped at 30 s (`DECISION_CALL_TIMEOUT_MS` in `WorkerDispatcher.ts`). |
| `perCallTimeoutMsByRole` | `implementer: 600000`, `planner: 600000` | Optional per-role override of `perCallTimeoutMs`, keyed by role name from `config/models.yaml`. Roles not listed use `perCallTimeoutMs`. |
| `warnAtFractionOfPerRun` | `0.8` | Logs "Run approaching per-run budget" once spend reaches this fraction of the run budget. Warning only. |

The stall and ceiling figures are the same ones the benchmark uses (`BENCHMARK_STALL_TIMEOUT`,
`FAST_ROLE_CALL_TIMEOUT_MS`, `PLANNER_CALL_TIMEOUT_MS` and the default implementer timeout in
`runBenchmark.ts`), so interactive runs and benchmark runs fail over on silence the same way.
`BudgetGuard.test.ts` asserts that the checked-in file matches those constants.

### Top level

| Key | Checked-in value | Meaning |
|---|---|---|
| `hardCeilingUsd` | `10.00` | Absolute cap. No call starts once spend reaches it, envelopes cannot reserve past it, and any approved budget increase is clamped to it (`clampBudgetIncrease`). It cannot be raised through `swarm_decide`. |

---

## config/checks.yaml

Read by `loadChecksConfig` / `normalizeChecksConfig` in `mcp-server/src/util/config.ts`; run by
`mcp-server/src/engine/checks.ts` through `RepoWorktree.runAllowListedCommand`. If the file is
missing, the defaults below apply. Categories run on the run's worktree as a baseline before
planning, after each task's `execute()`, and on the integrated tree at the integration barrier.
The exit code decides pass/fail, never an agent's report. Commands come only from this file, never
from model output.

| Key | Default when absent | Meaning |
|---|---|---|
| `categories` | one category: `unit`, `npm test --silent`, 60000 ms, required | The verification categories, run in order. See below. |
| `testPathGlobs` | `**/*.test.*`, `**/*.spec.*`, `**/test/**`, `**/tests/**`, `**/__tests__/**` | Files treated as tests for the non-waivable integrity floor: deleting a test or weakening its assertions opens a `test_waiver` for a human instead of being accepted. A plan that changes source code but gives no task a path matching these is sent back to the planner once more. An empty list also falls back to the default. |
| `maxConcurrentExecutes` | `3` (minimum 1) | Cap on concurrent `strategy.execute()` calls for tasks with disjoint declared file ownership. Apply, checks, review and decide stay serial. |
| `manualEvidenceAccepted` | `true` | Whether a named, reproducible manual inspection may stand as a criterion's evidence in the test mandate (`strategies/evidenceMandate.ts`). Set `false` for headless acceptance: every criterion must then name a check category. The benchmark sets it `false`. |
| `sandbox` | `none` | `none` or `bubblewrap`; anything else throws at load. See below. |

### Category fields

| Field | Default when absent | Meaning |
|---|---|---|
| `id` | `check-<n>` (1-based position) | Name used in records, findings and the delivery packet. |
| `command` | `npm` | Executable, spawned directly (no shell). |
| `args` | `[]` | Argument list. |
| `timeoutMs` | `60000` | Kill the check's process group after this long; a timeout counts as ran-and-failed. |
| `required` | `false` | `true`: a failure blocks acceptance. `false`: a failure is disclosed as a limitation and an unresolved finding. Note the default is **not required** when a category omits it. |

The checked-in file defines `unit` (`npm test --silent`, required), `typecheck` (`npx tsc --noEmit`,
optional) and `lint` (`npm run --silent lint`, optional), all at 60000 ms, with `sandbox: none`.

### Outcomes: failed, skipped, empty

- **Skipped (not run).** A category is recorded `ran: false` with a `skippedReason` only when its
  executable cannot be spawned (`ENOENT`, e.g. `npx` not installed), or when `sandbox: bubblewrap`
  is set and `bwrap` is unavailable. A skipped category is never counted as a pass: it appears in the
  delivery packet as `Check "<id>" not run: <reason>`, and a required one that did not run blocks
  acceptance. A command that exists but fails (for example `npm run lint` in a repo with no `lint`
  script) is **ran-and-failed**, not skipped.
- **Pre-existing failure.** A category that already failed at the baseline is marked
  `failedAtBaseline` and disclosed as pre-existing; the doctrines' delivery gates do not charge it to
  the swarm's change.
- **Empty suite.** A run whose output says it found no tests is "executed nothing": it does not
  block an individual task (early tasks legitimately land before tests exist), but it is disclosed
  as a limitation and a required empty suite does not satisfy the final gate.

### Sandbox

`sandbox: bubblewrap` (Linux, needs `bwrap`) runs every check with no network, the filesystem
read-only except the worktree, and a private `/tmp`; tool caches are redirected to `/tmp`, so
dependencies must already be installed in the target repo. It fails closed: no `bwrap` means the
check is recorded as not run, never run unconfined (`mcp-server/src/util/sandbox.ts`). With either
setting, checks get a scrubbed environment (PATH, HOME, locale, temp dirs, `VIRTUAL_ENV`, `CI=1`; no
API keys) from `mcp-server/src/util/childEnv.ts`.

### Review commands

`reviewCommands` lists commands a critic may run before its verdict, through a
`run_review_command` tool. The critic roles are `reviewer`, `opposition`, `regulator` and
`verifier`. Left undeclared, it defaults to every check category, each with arguments the critic
appends, so on any repository a critic can run one test file or a name filter (with npm scripts, after
`--`). Declare the list to replace that default, or set `reviewCommands: []` to offer none.

```yaml
reviewCommands:
  - id: cli
    description: "python -m mypkg <args>: run the CLI"
    command: python
    args: ["-m", "mypkg"]
    timeoutMs: 60000
```

The engine fixes `command` and the leading `args`. The critic picks an `id` and may append up to
16 arguments of at most 200 characters each (`maxArgChars` raises the limit for one command). They are passed as an argv array, never through a
shell. Arguments with absolute paths (including after `=`), `~` or `..` segments are refused. Each
command runs in a throwaway copy of the worktree with the change under review applied, with the same
environment scrubbing and `sandbox` setting as checks. Whatever it writes is discarded. A critic may
run at most five commands per verdict. The ledger records each run as `review_command_run` and
each refusal as `review_command_refused`. The benchmark declares three commands: the package CLI
(`python -m alloydamage`), a Python snippet (`python -c`, up to 4,000 characters) and targeted
pytest (`python -m pytest -q`). A command that takes code, such as `python -c`, lets the critic run
anything the snippet does. That is the same trust as the swarm's own tests, under the same scrubbing
and sandbox, so declare one only where you would run those tests.

### Legacy single-command format

Still accepted: a file with no `categories` but a top-level `command` (plus optional `args`,
`timeoutMs`) becomes one required category with id `unit`. `categories`, when non-empty, wins over
the legacy keys.

---

## config/models.yaml

Read by `loadModelsConfig` in `mcp-server/src/util/config.ts` (types `ModelsConfig`, `ModelEntry`),
used by `mcp-server/src/engine/WorkerDispatcher.ts`. Not schema-validated.

### `roles`

Each role maps to `{ primary, fallback }`, two OpenRouter model ids. A dispatch tries the primary,
then the fallback (on error, timeout or stall). A model id with no entry under `models` is skipped
with a warning. Roles in the checked-in file:

| Role | Used for |
|---|---|
| `planner` | Task graph planning. |
| `implementer` | Writing code (the only role with a large output; longest call ceiling). |
| `reviewer` | Written reviews of work. |
| `opposition` | Objections and challenges (democratic Opposition and equivalents). |
| `speaker` | Admissibility rulings and procedure. |
| `regulator` | Regulatory rulings (capitalist). |
| `integrator` | Integration at the acceptance barrier. |
| `verifier` | Independent verification at the acceptance barrier; the engine rejects a manifest whose verifier performed integration. |
| `rhetorician` | Only with `SWARM_DASHBOARD_RHETORIC=llm`: re-voices the dashboard's closing statement. Off the critical path. |
| `generalist` | General-purpose dispatches. |
| `bidder` | Capitalist sealed bids. |
| `decider` | Bounded governance choices (ballots, votes, rulings, allocation) through OpenRouter's Decisions API via `WorkerDispatcher.decide`. Unusable or low-confidence answers fall back to the call site's ordinary chat role. |

### `models`

One entry per model id referenced by a role.

| Field | Meaning |
|---|---|
| `inputPricePerMTok`, `outputPricePerMTok` | USD per million tokens, used to meter spend. |
| `supportsJsonMode` | Whether chat requests initially ask for `response_format` (never alongside tools). If a provider refuses, the client retries without it. |
| `supportsToolCalls` | Whether eligible requests may use repository tools. |
| `contextLength` | Optional context window in tokens; prompt budgets that scale with the model use it, unknown means a conservative default. |
| `api` | Optional. `decisions` marks a Decisions-API model: it answers typed questions with probabilities, cannot take a chat request, and is used only by `decide`. Omitted means `chat`. |

The decider is used when the engine's decision mode is `pure`, the default (`SwarmEngine.ts`;
the benchmark's `--decision-models off` disables it). `npm run smoke:models` checks chat entries
against OpenRouter's live catalog and decision entries by answering one question.

### `models.local.json` override

Written by the `swarm_configure_models` tool (`mcp-server/src/tools/swarmConfigureModels.ts`,
surfaced as `/swarm-setup`) into the config directory. It holds `primary`, `fallback`, `updatedAt`
and catalog-derived `modelEntries`. When it exists, `resolveModelsConfig` assigns that
primary/fallback pair to **every chat role**, merges its entries into `models`, and leaves any role
whose primary is a decision model (the `decider`) unchanged. It is re-read at every run start, so no
restart is needed. Delete the file to return to the roster in `models.yaml`.

---

## config/strategies.yaml

Validated at server start by `parseStrategiesConfig` in `mcp-server/src/constitution/schema.ts`.
Every section and sub-object is a zod `.strict()` schema: **an unknown key, or a value of the wrong
type or range, stops the server** with every bad key path listed. Every default lives in the schema
(or, for the capitalist policy blocks, in the module constant noted below), so a section or key left
out runs exactly as the checked-in value. Sections: `democratic`, `socialist`, `capitalist`,
`managerial`, `single_agent`.

**Constitutions.** At `swarm_start` the run adopts its strategy's constitution: the validated config
section and its digest are stored in run state and the full document is written to the ledger
(`constitution_adopted`). The run keeps that config through resume; if `strategies.yaml` has changed
since, resume records `constitution_drift_on_resume` and the run still obeys what it adopted.
`npm run constitution:export` (in `mcp-server/`) regenerates `docs/constitutions/<strategy>.json`
from the checked-in file, and `constitution/export.test.ts` fails when they are out of date.

Shared value types: `securityPathGlobs` defaults to `["**/auth/**", "**/security/**",
"**/*secret*", "**/*credential*"]`; `seed` is `run-id` (seed draws from the run id, so they can be
re-derived from the ledger) or `fixed` (every run draws identically).

### `democratic`

| Key | Default | Meaning |
|---|---|---|
| `voteThresholds.routine` | `simple_majority` | Threshold for routine motions. |
| `voteThresholds.cross_module` | `three_fifths` | Motions touching several top-level modules. |
| `voteThresholds.security_boundary` | `two_thirds_plus_security_committee` | Two-thirds Commons plus a binding Security Committee vote, before human and safety review. |
| `voteThresholds.constitutional_amendment` | `two_thirds_both_chambers` | Two thirds of all seats in both chambers. |
| `voteThresholds.test_waiver` | `human_required` | Test waivers go to a human. |
| | | Allowed labels: `simple_majority`, `three_fifths`, `two_thirds_plus_security_committee`, `two_thirds_both_chambers`, `human_required`. |
| `riskClassification.securityPathGlobs` | shared globs | Paths that make a motion security-boundary. |
| `riskClassification.crossModuleThreshold` | `2` | Touching at least this many top-level modules counts as cross-module. |
| `committee.electedSpecialistCalls` | `2` | Elected specialists on a full committee. |
| `committee.sortitionCalls` | `1` | Sortition seats on a full committee. |
| `committee.expeditedElectedSpecialistCalls` | `1` | Specialists for routine business and recommittals. |
| `committee.expeditedSortitionCalls` | `0` | Sortition seats for expedited business. |
| `confidenceVote.consecutiveFailuresBeforeSwap` | `3` | Consecutive failures before a confidence vote swaps the role holder. |
| `questionTimeEveryNTasks` | `5` | Cadence of Question Time. |
| `constituencies` | 8 constituencies (frontend ... operations) | One representative each; a motion's portfolio tag routes it. |
| `cabinet.portfolios` | 7 portfolios (architecture ... release-operations) | Executive portfolios. |
| `cabinet.collectiveResponsibility` | `true` | Ministers defend an approved plan or record dissent and resign. |
| `shadowCabinet` | map of portfolio to shadow persona, with `default` | Shadow reviewer per portfolio. Any string keys. |
| `offices.termLengthInTasks` | `6` | Rotation cadence; `0` disables rotation. |
| `offices.candidatesPerOffice` | `3` | Candidates per election. |
| `offices.constituentBallots` | `true` | Equal constituency ballots elect officers. |
| `offices.votersPerConstituency` | `2` (2 to 5) | Virtual constituents electing each representative. |
| `offices.seed` | `run-id` | Seeds sortition and tie draws. |
| `speaker.admissibilityRuling` | `true` | One Speaker dispatch per drafted motion. |
| `speaker.duplicateTitleSimilarity` | `0.85` (0 to 1) | Deterministic duplicate-motion screen. |
| `speaker.maxMotionsPerReading` | `12` | Time-box on motions per reading. |
| `debate.governmentReplyOnObjection` | `true` | Government replies once when the Opposition objects. |
| `debate.maxRoundsPerMotion` | `1` (0 or 1) | `0` means no reply. |
| `houseOfReview.enabled` | `true` | Second chamber. |
| `houseOfReview.minRiskClass` | `medium` | `low`, `medium` or `high`: lowest risk class it reviews. |
| `houseOfReview.maxDelays` | `1` | It delays and revises, never vetoes. |
| `confidence.governmentFailuresBeforeMotion` | `3` | Failures before a no-confidence motion. |
| `confidence.representativeRecallFailures` | `3` | Failures before a representative is recalled. |
| `ceremonialHead.emergencyRollbackAfterRemediationCycles` | `2` | Remediation cycles before emergency rollback. |
| `accountability.postImplementationReport` | `true` | Post-implementation report. |

### `socialist`

| Key | Default | Meaning |
|---|---|---|
| `guilds` | `frontend, backend, testing, security, docs, architecture` | Specialist guilds. |
| `initialCapabilityScore` | `0.5` (0 to 1) | Starting capability score per worker. |
| `councils.membersPerGuild` | `2` | Council members drawn per touched guild. |
| `councils.requirePlanRatification` | `true` | Councils approve, amend or reject their plan mandate. |
| `councils.memberBallots` | `true` | One equal ballot per eligible worker. |
| `councils.seed` | `run-id` | Seeds delegate, convener and appeal-panel draws. |
| `coordinating.termLengthInTasks` | `6` | Coordination authority is temporary. |
| `coordinating.mandate` | `ordering, interface, scarce-resource` | What the coordinating council may decide; values restricted to that set. |
| `coordinating.requireProductiveDuty` | `true` | Coordinators also do inspectable work. |
| `reconnaissance.maxCouncils` | `2` | Councils that inspect in parallel before planning. |
| `reconnaissance.requireProposedTests` | `true` | A report with no proposed acceptance test is refused. |
| `allocation.resourceEnvelopes` | `true` | Reserve task budgets by assessed need (from `perTaskUsd`). |
| `allocation.needsWeighting.{riskClass,breadth,dependencies,priorRejections}` | `2, 1, 1, 2` | Weights of the need assessment. |
| `allocation.lessonBudget.{min,max}` | `3, 8` | Lessons carried into a task brief. |
| `allocation.returnsBeforeReplan` | `2` | Returned assignments before replanning. |
| `mutualAid.enabled` | `true` | Aid before escalation. |
| `mutualAid.rejectionsBeforeAid` | `1` | Rejections before aid arrives. |
| `recovery.failuresBeforeDiagnosis` | `2` | Failures before an independent diagnosis. |
| `recovery.maxAttemptsPerNode` | `3` | Doctrine retry limit per node. |
| `recovery.appealOnScopeChange` | `true` | Scope changes can be appealed. |
| `recall.consecutivePlannerFailuresBeforeSwap` | `3` | Planner recall threshold. |
| `recall.delegateMisallocations` | `3` | Delegate recall threshold. |
| `escalateToHuman.securityPathGlobs` | shared globs | Only security-sensitive work escalates to a human. |

### `capitalist`

| Key | Default | Meaning |
|---|---|---|
| `bidCount` | `3` | Sealed bids per listing. |
| `lowRiskBidCount` | `2` | Bids on a low-risk listing. |
| `escrowFraction` | `0.2` (0 to 1) | Escrow held when a contract has no terms. |
| `escrowReleaseAfterCleanTasks` | `3` | Default retention release (feeds `capitalPolicy.retentionReleaseAfterCleanTasks`). |
| `capitalFloorForHighRisk` | `0` | Capital net of liabilities a firm needs to bid on high-risk work. |
| `initialCapital` | `500` | Starting capital per firm (feeds `capitalPolicy.initialCapital`). |
| `riskClassification.securityPathGlobs` | shared globs | Paths that make a listing high-risk. |
| `riskClassification.highRiskRequiresSpendApproval` | `true` | High-risk awards need spend approval. |
| `bankruptcyThreshold` | `0` | Capital below this bankrupts a firm. |
| `arbitration.maxPerRun` | `2` | Disputes arbitrated per run. |
| `firms.maxSubcontractors` | `1` | Subcontractors a lead firm may engage. |
| `firms.integrationThreshold` | `0.6` (0 to 1) | Coupling at which one firm takes both listings. |
| `specialisations` | none | Map of bidder persona to capability list; unlisted bidders use the published rotation in `exchange.ts`. |

The policy blocks below are optional partial overrides; any key left out keeps the published default
in its module (`mcp-server/src/strategies/capitalist/`). The schema rejects keys those modules do not
have.

| Block | Keys (module default) | Module |
|---|---|---|
| `listingTerms` | `baseBudget` 100, `baseDeadlineMinutes` 20, `baseWarrantyTasks` 1 (all three required if the block is present) | `exchange.ts` |
| `treasuryPolicy` | `levyFraction` 0.1, `publicGoodsShare` 0.7, `maxBailoutsPerRun` 1, `bailoutFraction` 0.5, `maxGrantFraction` 0.5 | `treasury.ts` |
| `creditPolicy` | `baseLimitFraction` 0.5, `minSettlementsForCredit` 1, `riskDiscount` {low 1, medium 0.75, high 0.5}, `maxSystemLeverage` 1 | `credit.ts` |
| `insurancePolicy` | `basePremiumFraction` 0.02, `riskMultiplier` {low 1, medium 2, high 4}, `deductibleFraction` 0.25, `requiredAtRisk` [high], `maxPremiumFraction` 0.4 | `insurance.ts` |
| `capitalPolicy` | `initialCapital`, `neutralReputation` 0.5, `reputationDecayPerSettlement` 0.1, `consecutiveFailuresForInsolvency` 3, `capitalFloorForHighRisk`, `retentionReleaseAfterCleanTasks` (keys here win over the top-level `initialCapital`, `capitalFloorForHighRisk`, `escrowReleaseAfterCleanTasks`) | `capital.ts` |
| `contractPolicy` | `baseRetention` 0.2, `warrantyRetention` 0.4, `timeAndMaterialsCapMultiple` 2, `outcomeContractsEnabled` false, `tournamentSuppliers` 2, `tournamentsEnabled` false | `contracts.ts` |
| `priceList` | `usdToTokens` 1000, `perThousandPromptTokens` 0.5, `perThousandCompletionTokens` 1.5, `perContextWindow` 0.5, `perToolCall` 0.25, `perLatencyMinute` 0.5, `perReviewerCall` 3, `perMergeRiskFile` 0.5, `securityExposure` {low 0, medium 2, high 8}, `perMaintainedFile` 1.5, `perOpenWarranty` 1 | `prices.ts` |

### `managerial` and `single_agent` (benchmark controls)

| Key | Default | Meaning |
|---|---|---|
| `riskClassification.securityPathGlobs` | shared globs | Recorded risk class only; neither control acts on it further. |
| `riskClassification.crossModuleThreshold` | `2` | As for democratic. |
| `managerial.maxReviewAttempts` | `3` | Manager review rounds per task (managerial only). |

---

## Environment variables

Read with `process.env` in `mcp-server/src` (tests excluded). Never commit or print the value of
`OPENROUTER_API_KEY`.

### MCP server

| Variable | Default | Read in | Meaning |
|---|---|---|---|
| `OPENROUTER_API_KEY` | none | `index.ts` | OpenRouter key. The server also loads `<plugin root>/.env` via dotenv. Never passed to check commands. |
| `SWARM_PLUGIN_ROOT` | two levels above `dist/index.js` | `index.ts`, `cli/verifyRun.ts` | Plugin root; base for the default config and runs directories and `.env`. |
| `SWARM_CONFIG_DIR` | `<plugin root>/config` | `index.ts`, `constitution/export.ts` | Directory holding the four config files and `models.local.json`. |
| `SWARM_RUNS_DIR` | `<plugin root>/runs` | `index.ts`, `cli/verifyRun.ts` | Where run state and ledgers are written. |
| `SWARM_DEFAULT_REPO_PATH` | none | `index.ts`, `tools/swarmStart.ts` | Target repo when `swarm_start` gets no `repoPath`. |
| `SWARM_FULL_TRANSCRIPTS` | off | `engine/Ledger.ts` | `1` records full call transcripts (can include repository file contents). The benchmark's `--full-transcripts` sets it. |
| `SWARM_DASHBOARD` | on | `dashboard/config.ts` | `0`/`false`/`no`/`off` disables the dashboard. |
| `SWARM_DASHBOARD_PORT` | `8731` | `dashboard/config.ts` | Preferred port; always bound to 127.0.0.1. If taken, the dashboard stands down. |
| `SWARM_DASHBOARD_OPEN` | on | `dashboard/config.ts` | Open the default browser when `/swarm-dashboard` (the `swarm_dashboard` tool) is used. It never opens at MCP server startup. Set `0` to opt out. |
| `SWARM_DASHBOARD_RHETORIC` | `template` | `dashboard/config.ts` | `llm` re-voices the closing statement with the `rhetorician` role (paid call). |
| `SWARM_DASHBOARD_WATCH` | on | `dashboard/config.ts` | Tail `runs/` for writes by other processes. |
| `SWARM_DASHBOARD_BANNER` | on | `dashboard/config.ts` | Rotating poster banner. |
| `SWARM_DASHBOARD_BANNER_MS` | `3000` (500 to 60000) | `dashboard/config.ts` | Time per poster. |
| `SWARM_DASHBOARD_BANNER_DIR` | `<plugin root>/assets/propaganda` | `dashboard/config.ts` | Poster library root. |
| `SWARM_DASHBOARD_NEWSREEL` | on | `dashboard/config.ts` | Archival newsreel. |
| `SWARM_DASHBOARD_NEWSREEL_DIR` | `<plugin root>/assets/newsreel` | `dashboard/config.ts` | Newsreel library root. |

Boolean dashboard variables treat `0`, `false`, `no` and `off` as off and anything else non-empty as
on. `ComSpec` is read on Windows only, to run `.cmd` shims through `cmd.exe`.

### Smoke tests and examples only

| Variable | Read in |
|---|---|
| `SWARM_EXAMPLE_REPO_DIR`, `SWARM_EXAMPLE_RUNS_DIR` | `examples/governanceTour.ts` |
| `SWARM_SMOKE_SCRATCH_DIR` | `smoke/engineSmoke.ts`, `smoke/capitalistSmoke.ts`, `smoke/dashboardLiveSmoke.ts` |
| `SWARM_SMOKE_DELIVERY_DIR`, `SWARM_SMOKE_DELIVERY_STRATEGY` | `smoke/deliverySmoke.ts` |
| `SWARM_SMOKE_DEM_CHAMBER_DIR`, `SWARM_SMOKE_DEM_ROUTINE_DIR`, `SWARM_SMOKE_DEM_SECURITY_DIR` | `smoke/democraticSmoke.ts` |
| `SWARM_REPLAY_FROM`, `SWARM_SMOKE_HOLD`, `SWARM_RUNS_DIR` | `smoke/dashboardSmoke.ts` |
