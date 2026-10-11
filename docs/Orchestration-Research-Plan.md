# Orchestration research plan

Date: 2026-10-09

Status: Deferred proposal; no implementation or paid experiments authorised by this plan.

## Question

Can selective context sharing and bounded model selection improve coding outcomes or reduce coordination overhead while preserving Political Swarm's governance procedures?

## Sources and hypotheses

| Source | Idea to investigate | Testable hypothesis |
| --- | --- | --- |
| [Fugu, §3.2.2](2606.21228v2.pdf) | Selective sharing within a workflow; reusable evidence across workflows | Keeping initial reviewer judgments independent reduces correlated mistakes, while revision-bound repository observations reduce repeated tool reads. |
| [Conductor, §3.1 and §4.5](2512.04388v5.pdf) | Explicit information dependencies and task-sensitive coordination | Specifying which earlier outputs each agent receives improves useful collaboration without increasing unnecessary calls. |
| [TRINITY, §3.2 and §4.5](2512.04695v3.pdf) | Separate model selection from role selection | A different model after repeated identical failures improves recovery more than another attempt with the same model. |

These are hypotheses for this project, not outcomes established by the papers. TRINITY explicitly identifies grounded tool execution as a limitation; benchmark gains in the papers do not establish gains in repository editing or validate any political doctrine.

## Proposed sequence

1. **Audit and instrument the baseline.** Trace context construction in `WorkerDispatcher`, strategy review prompts, `KnowledgeStore`, and repair briefs. Record evidence supplied to each role, exposure to earlier verdicts, repeated repository reads, model choice, calls, cost, and elapsed time. Verify whether the proposed isolation already exists before adding it.
2. **Test context policy.** Compare the existing policy with an independent first review followed by explicit exchange of findings. Supply the same task, immutable code snapshot, and factual check evidence to reviewers. Test reuse of revision-bound tool observations separately so its effect is distinguishable from reviewer independence.
3. **Test bounded model switching.** After a predeclared repeated-failure threshold, select an alternative eligible model using the existing failure signatures and repair brief. Compare with the same-model retry policy under equal attempt and spending limits. Keep transport-error failover separate from task-failure switching.
4. **Consider broader coordination only if warranted.** If the simpler interventions help, specify information dependencies separately from task dependencies. Consider a TRINITY-inspired benchmark-only control. Defer coordinator training and recursive orchestration until a broader dataset and a clear benefit justify them.

## Experimental controls

- Freeze the task suite, model identifiers, engine revision, prompts, budgets, thresholds, and primary metric before evaluation. Use several repository tasks covering implementation, debugging, integration, and verification, with repeated trials and rotated arm order.
- Separate development tasks from held-out evaluation tasks. Choose the repetition count and total spending cap after a development-only variance pilot, before opening held-out results.
- Compare each intervention with the unchanged baseline within each doctrine. Use the same model pool and policy in each arm, subject to the doctrine's existing authority rules. Change one mechanism at a time; evaluate combinations only after their individual effects are understood.
- Preserve institutional decisions, independent acceptance, immutable delivery snapshots, test-integrity protections, and spending ceilings. A routing policy cannot waive a required review or replace a doctrine's decision procedure.
- Preserve run-scoped benchmark knowledge isolation. Any reusable context must remain within its assigned arm and carry source and revision provenance. Hidden oracle answers must never enter worker context or tuning prompts.
- Record all runs, including interruptions, provider failures, rejected deliveries, and unknown/unmetered costs. Separate infrastructure failures from task failures; do not silently discard either.

## Measures and decision gate

Primary measure: externally verified end-to-end task success. Report functional correctness separately from the swarm's acceptance status.

Secondary measures: false acceptance, rejection of externally correct work, recovery after repeated failure, repeated tool reads, worker calls, known cost, unmetered calls, and elapsed time. External correctness alone does not establish that a rejection was unjustified: inspect disclosed risks and unmet non-functional requirements.

Report task-level paired differences and uncertainty across repeated trials. Before held-out evaluation, define the minimum useful improvement and acceptable correctness, safety, cost, and latency trade-offs. Adopt an intervention only if it meets those criteria without weakening governance or contaminating evaluation. An inconclusive result remains inconclusive.

## Deliverables when resumed

1. Context-flow audit and a frozen experiment specification, including repetition count and spending cap.
2. Reproducible configurations, run manifests, ledger-linked measurements, and external evaluation results.
3. A short comparison report recommending adoption, revision, or rejection of each intervention.

Next action: perform the read-only context-flow audit. Implementation and paid runs remain deferred.
