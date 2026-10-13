# The Orchestrator Contract

How the runtime implements the requirements each doctrine in `docs/philosophy/` places on Claude
Code, and where each one lives in the code.

Section 5 of all three philosophy documents is reproduced **verbatim and identically** — it is the
one part of the three doctrines that does not differ. It defines a doctrine-neutral boundary:

> **Claude Code is the external, politically neutral orchestrator.** … Claude may sequence execution
> phases, create multiple OpenRouter model instances within the selected political swarm, pass
> repository context and artefacts between those instances, enforce resource limits, and resolve
> runtime failures. It must not replace, shortcut or overrule the doctrine's internal decision
> procedure.

Everything below follows from that division: the engine owns **sequence and floors**, the strategies
own **judgment**, and the human owns **the criteria and the final say**.

For everyday prompts, Claude prepares the brief before starting: it preserves explicit criteria
verbatim, derives observable requirements from inspected context with an `Inferred:` prefix, and
records consequential defaults as `Assumption:` constraints. These inferred requirements join the
top-level evidence matrix without becoming claims that the user explicitly specified them. Claude
briefly discloses assumptions and proceeds unless a consequential unresolved choice needs an answer.
The human's instructions always override inferred scope; applying the result remains a separate
confirmation. This is orchestrator guidance, not server-side generation for callers that omit criteria.

---

## 1. The run lifecycle

```
baseline → plan → declareOwnership
  → loop( assign → execute* → apply → checks → review → decide → recordOutcome )
  → incomplete-integration assessment → scoped graph remediation (when needed)
  → integrate → verifyDelivery → disposeFindings → accept
  → external evaluation (when configured) → awaiting_acceptance
  → completed | remediation | interrupted | terminated_incomplete | failed | stopped
```

`execute*` is the only concurrent step, and only across tasks with disjoint declared ownership.
Everything after it is a serial acceptance barrier.

Driven by `mcp-server/src/engine/SwarmEngine.ts`; the barrier contract is
`mcp-server/src/engine/SwarmStrategy.ts`.

## 2. Run states

Section 5 defines three distinct endings and forbids reporting one as another. `RunStatus` in
`engine/RunStore.ts` keeps them apart:

| Status | Meaning |
|---|---|
| `running` | The engine loop is active and the swarm is working under its own procedure. |
| `paused_budget` | The run's budget or wall-clock deadline is exhausted. The engine has opened a `budget_increase` or `wall_clock_extension` approval and parks here until the human answers it via `swarm_decide`. |
| `paused_human` | The run is waiting on a human decision the engine or the doctrine has opened — a test waiver, a final-diff sign-off, a doctrine vote or spend approval, or a task that failed unexpectedly. Released only by `swarm_decide`. |
| `awaiting_acceptance` | The doctrine reached its own acceptance decision and submitted a delivery packet. **Not complete** — Claude has not checked it. |
| `completed` | The doctrine accepted **and** Claude independently accepted the packet. The only status `swarm_apply` will act on, apart from the human-invoked partial salvage of a `terminated_incomplete` run. |
| `remediation` | Claude rejected the delivery; the same swarm is reopening the work under its own rules. |
| `interrupted` | A persisted, lease-protected run stopped unexpectedly (a signal, a crash, a dead owner process found at startup) and may be resumed with `swarm_resume` without resetting its deadline. Resume replays governance from the ledger and reverts and requeues any task cut off mid-verdict — see [Operations.md](Operations.md). |
| `terminated_incomplete` | A rejected graph, an acceptance barrier that could not be completed, or the doctrine's own recorded terminal failure. Never presented as success. Resource exhaustion does not end the run by itself — the engine first parks it as `paused_budget`, and reaches this status only if the human then rejects the wall-clock extension. |
| `failed` | The run loop crashed, or a task exhausted a budget limit no approval can lift; the reason is in `lastError`. Terminal, and never presented as success. |
| `stopped` | The user halted the run with `swarm_stop`. Distinct from `terminated_incomplete`: no doctrine or engine verdict was reached. Never presented as success. |

A run whose every task was **rejected** ends as `terminated_incomplete`, never `completed` — section 5:
"Claude must preserve the last synchronization packet and report the reason rather than representing
partial work as accepted."

## 3. Section-by-section traceability

| Requirement | Mechanism | Where |
|---|---|---|
| §5 One doctrine per run; doctrines never run concurrently | One `StrategyId` per run, fixed at `startRun` | `engine/SwarmEngine.ts`, `commands/swarm-start.md` |
| §5 Claude never overrules the internal decision procedure | Every judgment is a `SwarmStrategy` method; the engine sequences and never decides | `engine/SwarmStrategy.ts` |
| §5 Synchronization packet passed between instances | `ctx.syncPacket()` — base revision, decisions, ownership map, changed-file manifest, evidence, open findings | `engine/packets.ts`, `SwarmEngine.buildSyncPacket` |
| §5 Delivery packet Claude independently checks | `DeliveryPacket`, assembled at the acceptance barrier | `engine/delivery.ts`, tool `swarm_get_delivery` |
| §5 Rejection returns concrete defects to the **same** swarm | `swarm_remediate` → `RemediationPacket` → `strategy.remediate()`; empty findings refused | `tools/swarmRemediate.ts`, `SwarmEngine.submitRemediation` |
| §5 Preserved delivery evidence travels with a rejection | `RemediationPacket.preservedDelivery` | `engine/packets.ts` |
| §5 Every doctrine's retry sees the same evidence | The engine reverts a rejected attempt from the shared tree, so no other task is judged against it. When the task goes round again, its files are kept on the node (`retainedAttempt`): its own repository tools show them as they were judged, and its next attempt resubmits them under its own operations, so a retry can `edit` its work instead of rewriting it from nothing. A refused `final_diff` that requeues keeps its work the same way; remediation reopening a node starts it afresh. The engine then builds one repair brief per node: each failing required check (new or still failing) with clipped output, failing advisory checks by name only, reject and flag findings with their evidence, the review's own required changes, the attempt's file operations shown whole up to 24,000 characters, one line for each of the last three attempts, and how many consecutive attempts ended with the same failure. It is rendered for every implementer dispatch, so no doctrine pastes its own copy. Repetition is judged on a signature of the normalized error lines rather than the code or reviewers' prose. Transient provider failures are not defects and do not count. The brief is cleared on approval and on a remediation reopen. Why the work was refused, and who does it next, stays with the doctrine; `Decision.repairDirective` lets a doctrine give an engineering-only directive in place of its rationale (capitalist uses it so a firm is not told about settlement money it cannot fix) | `engine/repairBrief.ts`, `engine/WorkerDispatcher.ts`, `engine/RepoWorktree.ts` (`RepositoryOverlay`), `SwarmEngine.settleTask` |
| §5 Partial graph receives bounded remediation | Strict partial-tree checks plus the doctrine's integration barrier produce scoped graph findings; at most four graph cycles | `SwarmEngine.attemptGraphRemediation` |
| §5 Durable recovery | Atomic state snapshots, persisted deadline/heartbeat/lease, stale-run interruption, `resumeRun()` | `engine/RunStore.ts`, `SwarmEngine.ts` |
| §5 Model unavailable / incomplete response | Primary→fallback per role; a failed task preserves partial state and blocks for a human rather than inventing an outcome. A transient provider failure (timeout, 5xx, `fetch failed`) is never a verdict: acceptance barriers and graph remediation pass it up instead of ending the run incomplete, and the loop is requeued after 30s, 60s, 120s, then 240s (four requeues, about 7.5 minutes), so a short outage is waited out. A stop during the wait wins | `engine/WorkerDispatcher.ts`, `SwarmEngine.handleTaskError`, `SwarmEngine.handleLoopCrash` |
| §8 Dependency and ownership map published before dispatch | `strategy.declareOwnership()`, merged over the planner's `targetGlobs` | `engine/ownership.ts` |
| §8 Concurrency only on disjoint ownership | `batchByOwnership`, capped by `maxConcurrentExecutes` | `engine/ownership.ts`, `SwarmEngine.runLoop` |
| §8 Undeclared overlap is a coordination defect | `undeclaredPaths()` → `unresolved` finding + `undeclared_overlap` ledger event | `engine/ownership.ts`, `SwarmEngine.settleTask` |
| §8 An abandoned owner's files stay repairable | When graph remediation names a file whose every owner is abandoned and cannot be reopened, ownership moves to one live task (preferring a reopened dependent) and that task is reopened; `ownership_transferred` records it | `engine/ownership.ts` (`orphanedPathTransfers`), `SwarmEngine.attemptGraphRemediation` |
| §8 A handoff never leaves two tasks waiting on each other | A task that blames another owner's file hands the defect to that owner, unless the owner already waits on it directly or transitively. In that case the task keeps the repair, and `ownership_handoff_declined` records it. Sign-off refusals follow the same rule | `SwarmEngine.ts` (`waitsOn`) |
| §8 Undeclared writes never touch the tree | `WorkerDispatcher` rejects implementer `FileOp[]` outside exact ownership and declared overlaps, with a corrective retry | `engine/WorkerDispatcher.ts` |
| §8 "No change" only for work already done | An implementer may return no file operations when its owned files already meet the task. If it owns a concrete source path that does not exist, the empty answer is sent back on every attempt, so a task is never approved with its work missing. Globs and runtime outputs (e.g. `results/*.csv`) are exempt | `engine/ownership.ts` (`missingOwnedSources`), `engine/WorkerDispatcher.ts` |
| §8 Dependency order | `readyNodes` gates every assignment; out-of-order assignments are deferred, not dispatched. A plan whose `dependsOn` links form a cycle is sent back to the planner with the cycle named, on every attempt, since none of its tasks could ever start | `engine/TaskGraph.ts`, `SwarmEngine.runLoop`, `engine/ownership.ts` (`dependencyCycle`) |
| §9 Requirement→test traceability matrix | `TaskNode.evidence` → `buildRequirementMatrix()`; a criterion whose check failed or never ran blocks acceptance. When `ChecksConfig.manualEvidenceAccepted` is true (the default), named manual inspections may reach Claude's independent acceptance check and appear under `criteriaRestingOnManualInspection`. The benchmark sets it to false: the test mandate must map every acceptance criterion to a check category, and headless acceptance rejects manual evidence | `engine/delivery.ts` |
| §9 Task verification versus final verification | Tasks block only on regressions from the latest accepted-tree snapshot; final required checks are strict regardless of baseline | `engine/checks.ts`, `SwarmEngine.settleTask` |
| §9 A suite with no tests in it is not a failing check | A required category that collected no tests before and after a change is named in the repair brief as having no tests yet, not charged as failing. The test-owning task is still held to the suite. Reviewers keep the "collected 0 items" log, and sign-off context names which required checks collected no tests | `engine/checks.ts`, `engine/repairBrief.ts` |
| §9 Baseline inspection before editing | All categories and the protected baseline-test manifest are captured against the untouched worktree | `engine/checks.ts`, `SwarmEngine.runLoop` |
| §9 All applicable check categories; omissions recorded with reasons | `config/checks.yaml` categories; `skippedReason` on every unrun category | `util/config.ts`, `engine/checks.ts` |
| §9 Independent verification outside the authorship chain | `strategy.verifyDelivery()`; a manifest whose verifier **is** its integrator is rejected. Every integrator and verifier prompt states that the diff is already applied and that the engine ran the listed checks on that tree, so the barrier decides on that evidence (reading files with its tools as needed). A withheld verdict whose rationale rests only on not having run or read something itself is sent back while retries remain; the last answer stands | `engine/delivery.ts` (`deliveryPacketErrors`), `engine/WorkerDispatcher.ts` (`deliveryEvidenceSection`) |
| §9 No weakening a test to obtain a pass | Engine-level guard, checked **before** fileOps touch the tree the check runs in; opens a `test_waiver` for a human. Either answer only requeues the task (or abandons it once attempts run out), and the guard re-checks every attempt, so no approval lets a weakening change land | `engine/testIntegrity.ts`, `SwarmEngine.guardTestIntegrity` |
| §9 Defect fixes add or strengthen a regression test | A remediation touching no test path delegates its regression-test obligation to another test-owning task in the same remediation round (or matching remediation origin for older state). If no such task exists, it raises an `unresolved` finding; the test-owning task must still submit test changes | `SwarmEngine.settleTask` |
| §10 Complete-diff review of the **combined** tree | `strategy.integrate()` receives the aggregate `git diff`, plus post-integration checks | per-strategy `integrate()` |
| §10 A work review judges the task's own files | Failure sites (`path:line`, `path::test`, traceback `File` lines) are read from the attempt's check output and mapped to their owners, and every work review is told where the checks fail. When none of those sites belongs to the task, the review is told not to reject it for them. Reviewer and opposition verdicts on the attempt being settled must name `defectPaths`. A reject naming only other tasks' files gets a corrective retry, and if it persists it stands as a flag (`review_reject_downgraded`). `defectPaths` join `evidenceRefs`, so an ownership handoff reads structure, not prose. The rule is the same for every doctrine | `engine/failureLocation.ts`, `engine/WorkerDispatcher.ts` |
| §10 Every finding gets exactly one disposition | `Finding.disposition`; an unanswered finding stays `unresolved` with that recorded | `strategies/barriers.ts` (`applyDispositions`) |
| §10 Deferred findings name an owner and return condition | `findingDispositionError()`; a malformed manifest cannot be submitted | `engine/packets.ts` |
| §10 Minority reports preserved | `Finding.minority` → `DeliveryPacket.minorityReports`, surfaced in `swarm_status`; the democratic Speaker restores a mark disposition dropped | `engine/delivery.ts`, `strategies/democratic/speaker.ts` |
| §10 Doctrine's own disclosures reach the manifest | `strategyState.deliveryNotes` appended to `limitations` / `residualRisks` / `rollback`; additive only, and it can never remove what the engine found | `engine/delivery.ts` |
| §10 Non-waivable floor above the doctrine's own procedure | A `nonWaivable` finding cannot be dispositioned `accepted` without being remedied. Findings are put on the floor by the ground their text names (security, safety, privacy, licensing, human-control, test-integrity, acceptance-evidence). The patterns match words, not stems: "authored" is not authentication, model token counts are not credentials, and "weakening a requirement" is test-integrity only when a test or assertion is weakened | `SwarmEngine.runAcceptanceBarriers`, `strategies/floors.ts` |
| §10 Internal approval never binds Claude | `awaiting_acceptance` ≠ `completed`; `swarm_apply` refuses every other status | `tools/swarmApply.ts` |
| Benchmark external oracle | The live worktree must pass all 12 evaluator-owned checks; exact results are preserved in `DeliveryPacket.externalEvaluations` | `mcp-server/src/benchmark/runBenchmark.ts`, `benchmark/oracle/` |
| §12 Human sovereignty | Explicit acceptance criteria passed verbatim; inferred additions labeled and assumptions disclosed; consequential ambiguity resolved before starting; approvals resolved only by the user; `/swarm-apply` needs explicit in-chat confirmation. In the headless benchmark only, the user's selected Claude model stands in as sovereign for doctrine escalations, and a fixed per-arm allowance decides budget and time extensions (`benchmark/README.md`) | `commands/*.md`, `mcp-server/src/benchmark/sovereign.ts` |

## 4. The same barrier, three institutions

The engine fixes only that the barriers happen and in what order. Who performs them is the
doctrine's own business, which is why `SwarmStrategy` declares them **required** rather than
supplying a shared default:

| Barrier | Democratic | Socialist | Capitalist |
|---|---|---|---|
| `integrate` | Integration Committee, answerable to the Commons | integration council of producers | separately procured integration assessor |
| `verifyDelivery` | verifier appointed by the Commons who did not author | independent peer outside the authorship chain | contractual assessor with no success fee |
| `disposeFindings` | majority report with minority report preserved | common ledger, dissent preserved | acceptance schedule with priced obligations |
| `accept` | constitutional verification gate, then assent | councils' recorded acceptance on reproducible evidence | escrow release under the regulatory safety floor, above a constitutional gate on articles 3, 4 and 10 |
| `remediate` | motions recommitted for renewed scrutiny | returned to the responsible council; repeat failure reassigns | warranty claim to the liable firm; repeat failure relists |

Democratic and capitalist acceptance gates are deterministic. Socialist acceptance first applies
deterministic evidence and constitutional checks, then, when plan ratification is enabled, obtains
recorded final-delivery ballots from each council. With member ballots enabled, eligible workers
vote; otherwise each delegate votes. Every council must approve.

### Where a doctrine's own institutions sit

The barrier table above is the part the engine fixes. Everything else a doctrine does happens inside
those methods, and the democratic strategy — the fullest worked example — hangs its whole §6
institutional architecture off them:

| Institution | Where it runs | Deterministic? |
|---|---|---|
| Offices: constituency ballot for Prime Coordinator, performance appointments, sortition, rotation, recall | top of `plan()`; rotation and recall in `recordOutcome()` | ballots require one model response per constituency; appointment scores and lots are deterministic |
| Speaker: order of debate, admissibility, duplicates, time limit | `plan()`, before motions become graph nodes | screen yes, ruling one dispatch per surviving motion |
| Select committees (elected seats + sortition seats) | `assign()` | no — one dispatch per seat |
| Loyal Opposition / Shadow Cabinet | `review()` | no — one dispatch, by portfolio |
| Government reply (§7 stage 4) | `review()`, only when the Opposition objects | no — one dispatch |
| Code Commons division, delegate-vs-trustee, abstention | `decide()` | with `constituentBallots`, engaged elected representatives cast model ballots; tallying is deterministic; without it, the advisory division is deterministic |
| Collective responsibility, confidence, alternative programme | `recordOutcome()` | confidence requires one recorded ballot per representative when `constituentBallots` is enabled |
| House of Review (second chamber) | `decide()` for constitutional amendments; `disposeFindings()` for programme findings review | no — chamber ballots for amendments, plus the programme review dispatch |
| Ceremonial Head's reserve powers | `execute()`, `recordOutcome()`, `accept()` | yes |
| Question Time (§11) and the stage 9 report | `recordOutcome()` and `accept()` | yes |
| Constitutional verification gate | `accept()` | yes |

The socialist strategy hangs its §6 federation off the same methods, with the same posture:

| Institution | Where it runs | Deterministic? |
|---|---|---|
| Collective reconnaissance (§7 stage 2) | `plan()`, before the planner call | no — one dispatch per council, capped by `reconnaissance.maxCouncils` |
| Plan synthesis, council challenge, and plan-version ratification | `plan()` | planner proposal and delegated council ballots are model calls; a rejected or stale version cannot be assigned |
| Worker councils, delegates, the coordinating council | end of `plan()`; rotation and recall in `recordOutcome()` | yes — drawn by lot from the run id |
| Needs assessment, council-based subsidiarity, budget reservations | `assign()` | yes — need sets a real task envelope within uncommitted run funds |
| Coordinating-council arbitration, bounded by its mandate | `assign()`, only on a cross-council node | one dispatch; the mandate check on its answer is deterministic |
| A worker's right to return an assignment | `execute()` | yes — it rides the implementer dispatch, so it costs nothing |
| Peer review outside the authorship chain | `review()` | yes — the reviewer is neither the implementer nor the convener who allocated the node (§6: coordinators cannot approve their own decisions) |
| Mutual aid | `decide()`, only on an actual block | no — one dispatch |
| Minority reports | `decide()`, and retained after `disposeFindings()` | yes |
| Independent diagnosis, retry limit, appeal panel, planner recall/revision | `remediate()` | diagnosed specification failures can recall the planner and trigger same-run revision and new council ratification |
| The commons report | end of `disposeFindings()` | yes |
| Constitutional gate, assembly ratification | `accept()` | evidence and constitutional gates: yes; council acceptance ballots: no |

The engine option `decisionModels` accepts `off` or `pure` (default). In `pure`, supported bounded
governance choices first use the `decider` role (`upstage/solar-decide`) through OpenRouter's alpha
Decisions API. An unusable or insufficiently confident result falls back to the ordinary chat call.
Decision calls are metered and ledgered but do not consume the institutional-call ceiling. This
route handles bounded choices, not a decide-then-explain review shortcut; `explain` is not a
supported mode.

The pattern is the one §5 implies: model calls supply institutional judgments; deterministic code
applies the rules. Ballot choices and council consent are recorded model judgments; tallying, scope
checks, reserve powers and final gates apply published rules.

The **House of Review** reviews programme findings at `disposeFindings()` and separately votes on
constitutional motions at `decide()`; it does not implement its programme review through `accept()`.
The **Speaker** never strikes the last motion on
the paper, because a procedural office able to cancel the entire programme would be deciding the
substantive question it is barred from deciding.

The socialist **commons report** has a third forced placement, for a different reason: it is written
at the end of `disposeFindings()` rather than in `accept()`, because `assembleDelivery` reads
`strategyState.deliveryNotes` before `accept()` runs. A report filed in `accept()` would be built
into nothing, and the run would read as though it had accounted for itself while disclosing none of
it — worse than filing no report at all.

## 5. Claude's tools at the boundary

| Tool | Role |
|---|---|
| `swarm_get_delivery` | Read the packet, plus an `independentCheck` block listing what to satisfy yourself of. It surfaces; it does not judge. |
| `swarm_decide` | Record the human's resolution of a pending approval — `budget_increase`, `wall_clock_extension`, `final_diff`, `test_waiver`, plus the doctrines' own `vote_threshold`, `spend_approval` and `confidence_vote`. It is the only way to release a run parked in `paused_budget` or `paused_human`, and `swarm_apply` refuses to apply while an approval is unresolved. The judgment is the user's; the tool records it. |
| `swarm_accept` | Record acceptance after the check. Completes the run, unlocks `swarm_apply`. |
| `swarm_remediate` | Reject with at least one concrete defect. Returns to the same swarm. Bounded: remediation cycles are capped per remediation kind — a third delivery rejection is a hard error that leaves the run `awaiting_acceptance`. |
| `swarm_apply` | The only tool that writes outside the worktree. Refuses any status but `completed` — one exception, human-invoked, not something Claude reaches for on its own: the user-typed `/swarm-apply` command may pass `allowPartialFromIncomplete: true` (with optional `taskIds` and `commitMessage`) to salvage just the swarm-approved subset of a `terminated_incomplete` run. It also refuses a diff touching files that execute code (CI configs, git hooks, build manifests) unless called again with `confirmSensitivePaths: true` after a second, explicit human confirmation naming them. |
| `swarm_verify_run` | Audit a run's record offline: the ledger's hash chain, the adopted constitution's digest, every governance decision replayed from the ledger and re-counted under its declared rule, and spend. Use it before accepting a delivery whose governance you are relying on. |
| `swarm_resume` | Continue an `interrupted` run under the constitution it adopted at start. |

The procedure Claude follows is `commands/swarm-accept.md`, written so that reading the packet is
explicitly *not* the check.

---

## Repository context and limits

Engineering and institutional worker roles can inspect the worktree with three centrally supplied,
read-only tools: paginated file listing, bounded line reads, and literal repository search. Every
path crosses `RepoWorktree`'s traversal and symlink boundary. A dispatch is limited to six tool
rounds, eight calls, 64 KiB returned content, 400 lines per read, and 100 search matches; metadata
and failures reach the ledger, never file contents. Providers without dependable function calling
receive a deterministic bundle of owned files, settled interfaces, manifests, referenced paths,
provenance, and data headers under the same byte cap. `FileOp[]` remains the only write path.
A call that offers the tools does not set `response_format`: under JSON mode the primary,
`upstage/solar-mini4`, wrote each tool call as JSON text instead of making it, so no worker read
the repository in any sweep it ran. The prompt still asks for JSON, the parser still extracts it,
and the tool-free final round keeps JSON mode.

Ordinary planner and bidder caching is limited to before implementation begins. Explicit
institutional replay keys also permit reuse of matching council plan, recall, and final-delivery
ballot responses; the chat cache key includes the replay key, role, persona, prompts, and schema.
Ordinary content-dependent review, opposition, integration, and verification are not cached. Worker ledger entries classify engineering versus institutional spend, and a
configurable per-task institutional-call ceiling records a resource failure rather than fabricating
a doctrine decision. The final delivery review is not charged to it (`WorkerDispatcher.outsideTaskCeilings`):
a doctrine that convenes per-task councils at delivery would otherwise bill them to whatever each
task had already spent, and lose a finished delivery to a budget meant for one task's procedure.
Those calls are still ledgered and still count against `maxWorkerCalls` and the spend ceiling.

## Known limitations

**Bid collusion detection is informational only** in the capitalist strategy. What *is* enforced is
article 4's self-dealing rule (`strategies/capitalist/constitution.ts`, `antitrustBreaches`): a firm
that assessed the contract it was paid for, a prime contractor assessing work it subcontracted, and
one party holding both integration and final verification all block acceptance, because each is
visible in a single run's register. Concentration of awards is reported rather than blocking — on a
three-listing plan one firm winning two is arithmetic, not capture, and refusing sound work over the
shape of a plan would be its own failure. Collusion between nominally independent bidders remains a
logged statistical flag (`trackCollusionWatch` in `strategies/capitalist/CapitalistStrategy.ts`): distinguishing a cartel from
three bidders who happen to price similarly needs cross-run history this runtime does not keep.

**Test-integrity detection is heuristic.** It counts assertion-like call sites and test cases rather
than parsing a suite, so it catches removal and emptying reliably but cannot judge whether a
rewritten assertion is weaker. It fails toward stopping the task and asking a human.

**Implementation scope and remaining limits.** The philosophy essays state each doctrine as
intended; the mechanisms below have these implemented boundaries and remaining gaps.

- *Democratic two-chamber vote.* With `constituentBallots` enabled, constitutional amendments
  require two thirds of all Commons seats and a separate two-thirds House of Review ballot before
  referral to the human and safety gates.
- *Democratic Security Committee.* With `constituentBallots` enabled, security-boundary motions
  that pass the Commons requirement receive a separate two-thirds ballot from a three-member
  Security Committee outside both chambers. Failure rejects the motion; success proceeds to human
  and safety review.
- *Socialist recall grounds.* Misallocation recall transfers a delegate's mandate; diagnosed
  specification failures recall the planner and revise unfinished work in the same run. Eligible
  council workers cast equal ballots on plan adoption and final delivery. With member ballots
  enabled, workers may initiate concealment or loss-of-confidence recall motions during plan or
  delivery voting. A separate absolute-majority ballot can replace the delegate and transfer its
  mandate. Blocked information is not a separate encoded recall ground.
- *Capitalist grants.* Public-goods grants can fully cover a named shared-work tender shortfall from
  unpledged levy funds. Uncertain prototype tenders can likewise draw from the unpledged venture
  pool, with findings published at settlement even on failure. Amended tenders get fresh bids;
  unfilled grants return to their fund.
- *Capitalist credit.* Premium-shortfall credit is repaid from verified profitable settlements.
  Credit remains limited to that use case.
- *Capitalist warranty enforcement.* Retention matures by contract and attempt; a named later
  remediation claims the latest live lot. There is no monitoring after run closure or court-grade
  attribution of a latent defect to its original artifact.
- *Capitalist contract shapes.* Outcome and tournament commissioning cannot be enabled at runtime;
  evaluator-owned baselines and separate supplier worktrees remain to be built. Time-and-materials
  payments follow priced use within a cap, but a single in-flight call can overrun it. A contract
  is metered by each of its own calls' reported tokens, since subcontractors and arbitration
  hearings run concurrently; the run-wide counter's delta is only the fallback for a failed call.
  Published delivery deadlines are checked at settlement against the supplier's delivery
  timestamp. Work that passes review, scope and checks but misses its deadline or spend cap is
  kept and settled in breach: the retention is forfeited and the failed contract goes on the
  firm's standing. It is not reverted.
- *Capitalist recovery.* A warranty repair by the same firm is available once per acceptance: it
  counts judged attempts since the last acceptance, so a remediation reopen or a transient first
  attempt still gets one. A reviewer finding of a fundamentally wrong approach goes to re-tender
  instead. Re-tenders carry the last three failed rounds' required changes, labelled by attempt.
- *Capitalist disputes.* The essay lists "whether a bid was misleading" among arbitrable
  matters. The runtime no longer raises that dispute, because its ruling was never read. Only
  regression-cause and scope-change disputes go to arbitration.
- *Managerial and single-agent risk class* is recorded, not acted on. Both now have a
  `strategies.yaml` section using the doctrines' security globs.
