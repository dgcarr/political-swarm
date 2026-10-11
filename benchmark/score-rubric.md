# Scoring rubric — Coding Swarm Benchmark

Use this procedure after `npm run benchmark` completes. It deliberately separates blind
technical and resource scoring from governance-process review so strategy identity cannot affect
the engineering assessment.

## Pass 1 — blind technical scoring

1. From `mcp-server/`, create a blinded copy of the completed run:

   ```sh
   node scripts/anonymize-results.mjs ../benchmark/results/<run>
   ```

2. Give the scorer only `benchmark/results/<run>/blind/candidate-*/`. Do **not** reveal or open
   `blind/strategy-mapping.json`, the original strategy-named directories, `summary.json`, any
   `state.json`, or any `ledger.jsonl` until Pass 1 is finalized. Score every candidate directory
   present; a run may contain fewer than all five candidate labels.
3. For each candidate, use only its `worktree/`, `diff.patch`, and engineering-safe
   `metrics.json`. Run `python -m pytest -q` inside the worktree and record pass/fail/error counts.
   This is the authoritative check for section 8's Tests 1–6 and the `python -m pytest`
   deliverable; do not rely solely on the mid-run test results in `metrics.json`.
4. Run `python -m alloydamage calculate examples/304L.yaml` in each worktree and confirm it
   produces the required `results/304L*` CSV and plot without crashing.
5. Use `metrics.json.coverage.percent`, which the harness measured with
   `python -m pytest --cov=.` against the output worktree. Spot-check it rather than recomputing.
   If it is `null`, read `coverage.detail` and rerun
   `python -m pytest --cov=alloydamage` yourself if needed.
6. Inspect `diff.patch` and the worktree for duplicated implementation, such as multiple copies
   of the same weight-to-atomic conversion. Do not inspect the ledger during this pass; agent-level
   duplicated-work analysis belongs to Pass 2.
7. Write and finalize the per-candidate tables, justifications, metrics, and ranking in
   `benchmark/results/<run>/blind/SCORES.md`, using only `candidate-A` through `candidate-E` labels.
   Do not include or infer strategy names. Once Pass 1 is finalized, do not revise its scores in
   response to information learned in Pass 2; append the joined report separately.

### Engineering quality (95% of the optional overall score)

Score each criterion from 0–10, then calculate its contribution as `weight × score / 10`.

| Criterion | Weight | What to check |
|---|---:|---|
| Numerical correctness | 30% | Verify section 8 Tests 1–3 by hand or through substantive tests: a pure element equals its elemental curve; a 50/50 atomic mixture matches the arithmetic mean; and Fe-Cr-Ni weight-to-atomic conversion matches an independent calculation. Spot-check CSV points against `σ_alloy(E) = Σ x_i σ_i(E)`. |
| Correct nuclear-data handling | 20% | Uses supplied `data/<element>/*_dpa_nrt.csv` without invented values; correctly handles the documented MT=901 NRT-dpa units (barn, eV); refuses or flags unsupported elements (section 3, Test 5); and does not extrapolate beyond each element's native range (section 4). |
| Verification / tests | 15% | `python -m pytest` passes and tests substantively cover all six section 8 scenarios, rather than only happy-path smoke tests. |
| Engineering clarity and documentation | 10% | README covers section 12's eight required points and documents the mixture rule and weight-to-atomic conversion with actual mathematics, not only prose. |
| Code simplicity / maintainability | 10% | Follows the section 11 layout without unnecessary abstractions, frameworks, or premature generalization. Penalize both over-engineering and an unstructured one-file dump. |
| Plot and outputs | 5% | PNG has a log energy axis, legend, alloy-name title, distinguishable elemental and total curves, and sensible limits; CSV contains section 5's required columns. |
| Nuclear-data provenance | 5% | Source, model, dataset, and units are inspectable from program output (for example, a CLI flag or CSV/README field), not only source comments, as required by section 13. |

Keep these engineering observations visible per candidate: files changed, authoritative test
failures, final coverage, and duplicated implementation found in the diff/worktree.

### Resource efficiency (5% of the optional overall score)

Score resource efficiency from 0–10 relative to the other candidates from the same run and the
same task/models. Use only the safe metrics: `tokensUsed`, `costUsd`, `workerCalls`, and
`wallClockMs`. Record all four raw values alongside the score so the dimension remains auditable.
Status, `taskErrors`, `testRuns`, `filesChanged`, coverage, and note may explain an incomplete or
failed artifact, but do not expose governance information.

The optional Pass 1 overall score is the sum of Engineering quality (95%) and Resource efficiency
(5%). Keep both dimension totals visible; do not replace them with only the overall number.

## Pass 2 — reveal and join

Begin only after `blind/SCORES.md` has been finalized and written.

1. Open `blind/strategy-mapping.json` and map each frozen candidate score to its strategy.
2. Now inspect the corresponding original strategy directory. Read `metrics.json.autoApprovals`
   and `ledger.jsonl` for governance/process behaviour. Use repeated `worker_call` and
   `task_decided` records touching the same task/file to identify duplicated work between agents,
   and cite concrete examples. Record approval counts and kinds, task/decision patterns,
   coordination overhead, repeated work, and harness-level failures. An auto-approval is not by
   itself evidence of worse engineering; the engineering score is already frozen.
3. Append the final joined report to `blind/SCORES.md` (or write a clearly linked final report in
   the run directory). Preserve candidate labels beside revealed strategy names for auditability.

The final report must contain three separate sections and show their raw metrics or supporting
observations:

1. **Engineering quality** — the frozen 95-point technical total, criterion table, test results,
   coverage, documentation, code, and output assessment from Pass 1.
2. **Resource efficiency** — the frozen 5-point resource score plus tokens, cost, worker calls,
   and wall-clock time from Pass 1.
3. **Governance-process behaviour** — auto-approvals, decision/coordination patterns, duplicated
   agent work, task errors, and relevant ledger evidence added only after identity is revealed.

An overall score may be reported, but these three dimensions must remain visible and must not be
collapsed into one opaque number. Governance-process behaviour is reported separately rather than
retroactively changing the blind engineering or resource scores.
