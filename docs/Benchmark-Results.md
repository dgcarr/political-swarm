# Benchmark results

The repository includes a reproducible, sequential-by-default harness that gives an identical,
versioned engineering task and equal base budget to all five strategies. It requires Python 3: on first run it creates `benchmark/.venv` from
`benchmark/requirements.txt` (rebuilt when that file changes), and runs the checks, coverage and
oracle under that venv.

Results below are from one controlled, fully logged sweep (2026-10-07/08, label `full-2026-10-07b`,
commit `dfe3a62`): the five strategies run one after another on the same task and the same model roster,
with `--budget-usd 8 --max-wall-clock-min 150 --decision-models pure --full-transcripts` and the
trial-0 arm order. The oracle columns read as two numbers: whether the program runs end to end, and
its score over the checks it could actually judge. A *blocked* check never reached the property it
tests, because the program produced no result to judge (see [`benchmark/README.md`](../benchmark/README.md)).
Scores are from the oracle as of the commit that added this table. The sweep's own `metrics.json`
was scored one fix earlier and reports socialist as `runs: no (6 blocked) · functional 6/6`: that
arm writes its CSV to exactly the `--output` path with no `.csv` suffix, which the oracle did not then read.
Capitalist reads 5/12 rather than the 6/12 first published: check 9 now runs TASK.md's literal
`python -m alloydamage calculate examples/304L.yaml`, which crashes on a fresh checkout of that arm
because it writes `results/304L.csv` without creating `results/`.

| Governance | Status | Oracle | Cost | Time | Worker calls | How the run ended |
| --- | --- | --- | ---: | ---: | ---: | --- |
| Democratic | completed | runs: yes · functional 12/12 | $0.48 | 184m | 422 | Accepted under its own rules, with 5 of 7 tasks settled and 2 abandoned and declared as limitations; the sovereign was consulted 10 times |
| Socialist | terminated_incomplete | runs: yes · functional 12/12 | $0.36 | 179m | 268 | Refused its own delivery: a council rejected `nuclear_data.py` for duplicating the weighted-sum logic in `damage.py` |
| Capitalist | terminated_incomplete | runs: yes · functional 5/12 | $0.41 | 165m | 257 | Refused its own delivery: the unit check failed and the contractual assessor withheld acceptance; the oracle finds wrong atomic fractions (Fe 0.254 against 0.714) |
| Managerial | terminated_incomplete | runs: no (10 blocked) · functional 0/2 | $0.24 | 119m | 156 | Rejected all 5 tasks and exhausted graph remediation; no `alloydamage/__main__.py`, so the CLI never ran |
| Single-agent | terminated_incomplete | runs: no (10 blocked) · functional 1/2 | $0.25 | 93m | 137 | Refused its own delivery with the unit check failing; it wrote no CSV output and no test files |

The sweep cost $1.74 in OpenRouter charges, plus the sovereign's Claude calls, which only
democratic made. This is one nondeterministic trial: earlier sweeps showed run-to-run variance
larger than the differences between arms, so read it as a current baseline, not a ranking.

Three engine changes landed after the previous sweeps and before this one. The final delivery
review is no longer charged to individual tasks' institutional-call ceilings. A verifier that passes
a delivery but leaves criteria unlisted is asked once more about those criteria. And oracle failures
no longer reach the swarm with their expected values. Earlier sweeps are therefore not a
like-for-like comparison.

<details>
<summary>History: the 2026-09-22/23 trials and what they found</summary>

These notes analyse the three earlier trials (commit `26d0d1c`), whose table this one replaced.
Those trials predate the implementer repository-reading fix (`3428b9f`), per-trial seeding of
lots (`36aedff`), the 2026-10-07 oracle fixes, and the engine changes above.

**All fifteen runs ended `terminated_incomplete`, and the reason was an engine defect rather than a
property of any doctrine.** It is not that the arms refused their own deliveries: eighteen of the
twenty runs across both sweeps never reached the acceptance barriers at all. One task abandoned at
the attempt ceiling made `allApproved()` false, which ended the run and discarded the five to seven
tasks the doctrine had already approved. Almost always that task was the one writing the tests, and
it could not converge because `toTaskTestResult().passed` means "introduced no regression": a check
that has never passed is classed pre-existing, so the task creating the first test suite could never
register a regression and the engine recorded `testsPassed: true` however broken its tests were. The
decision fell entirely to the reviewer, which read the real output and rejected — 79 of 411 attempts
were rejected while the engine called the tests passing. A further 37 attempts were spent on provider
timeouts, which counted against the same ceiling.

All three are fixed (`7e57ccb`): the test-owning task is judged on the strict whole-suite status,
transport failures no longer consume the rework budget, and an abandoned task is declared as a
limitation in the delivery packet instead of sinking the run. **The table above predates those fixes**
— it measures doctrines through an engine that threw away most of their work, so the spread between
arms is not yet a doctrine comparison.

**Trial 2's low scores are a real shared defect, not an oracle artefact.** Three of the five arms
(democratic, socialist, managerial) interpolate log-linearly — logarithmic in energy, *linear* in
cross-section, `np.interp(log(E_target), log(E_source), sigma_source)` — where the oracle accepts
only linear and log-log (`benchmark/oracle/reference_data.py` `interpolation_candidates`). Log-linear
reproduces every emitted value exactly, including the 533.896772 pure-Fe total against an expected
533.534123 or 531.515430. The other two arms never produced a number: capitalist's entry point
raised, and single-agent emitted no CSV.

Check 6 settles whether the oracle is simply too narrow. It swaps in a synthetic Fe curve of two
points — 1 MeV → 10 barn, 100 MeV → 1000 barn — and requires σ = 10·E at interior points. That curve
is both a straight line and a pure power law, so linear and log-log agree on it exactly; it is a
convention-independent probe. Log-linear returns 159.01 at 2 MeV instead of 20, an 8× error. The
accepted set is not too narrow.

**Revised 2026-10-07: that conclusion was wrong, and log-linear is now accepted.** Check 6 cannot
settle it: a two-point curve spanning two decades is a probe *built* so that only the two accepted
laws are exact, which says nothing about accuracy on the real data. The real test is the
full-resolution IAEA evaluation in `benchmark/raw-source/` (~170k points per element, ENDF law
INT=2). Interpolating the supplied ~400-point CSVs and comparing at 4000 energies over 1 keV-20 MeV,
every convention misses the full evaluation by a similar 1-2% median: lin-lin 1.33%, linear-in-log-E
1.33%, log-log 1.21% for Fe. The laws differ from each other by 0.07-0.4%, much less than that error,
so none is privileged, yet the oracle accepted log-log while rejecting a law closer to lin-lin.
The oracle now accepts all four ENDF laws (INT=2..5), each banded separately, and check 6 accepts
the exact answer of whichever law a submission uses. See `docs/Oracle-Audit-2026-09-24.md`, addendum.

Checks 3 and 4 ("wrong atomic fraction") were never composition errors at all. `_infer_atomic_fractions`
divided the arm's emitted per-element contribution by the *oracle's* interpolated value, so an
interpolation error appeared as a composition error — the ratio of observed to expected fraction was
1.00067972, the log-linear/linear ratio at that energy to seven digits. The oracle now infers those
fractions only at energies the source CSVs tabulate directly, where every convention returns the
listed value, so composition is judged on its own. The t2 scores above rose by two for the three
arms affected, and single-agent's t0 by the same, which is what one defect costing four checks
looked like. One interpolation bug still accounts for checks 1, 2, 6 and 8.

**All three arms wrote the test TASK.md asked for, and all three made it tautological.** Test 6 of
the task says to "verify the interpolation routine against a simple artificial dataset with a known
answer". Each arm built its dataset *from* the convention it had chosen — managerial asserts
σ(√10) = 50 because "linear interpolation in log-space gives exactly 50 barn"; democratic uses
σ = 2·log(E) + 1, commented "linear in log-energy; log-linear interp is exact"; socialist uses
σ = 1, 2, 3 at E = 100, 1000, 10000. A test whose fixture is generated by the implementation's own
convention cannot fail. Single-agent was the only arm to pick a convention-independent fixture
(σ = E², a true power law) — and it never got far enough to be scored on it.

**"Oracle" is the independent 12-check acceptance oracle** (`benchmark/oracle/run_oracle.py`),
run directly against each strategy's final worktree — not the swarm's own self-reported test
results. An audit of those checks on 2026-09-24 fixed two defects — check 5 identified the
unsupported element by substring, which `"calculate"` satisfies, and check 7 accepted a submission
that clamped an out-of-range request instead of refusing it. Both were latent, and re-running the
corrected oracle over all fifteen preserved worktrees reproduced every score unchanged. A third
finding did move scores: checks 3 and 4 could not fail independently of check 1, so the table above
was regenerated after decoupling them. All seven findings of that audit are now closed
([`docs/Oracle-Audit-2026-09-24.md`](Oracle-Audit-2026-09-24.md)), and the checks themselves
are covered by `benchmark/oracle/test_checks.py`, `test_oracle_checks.py` and `test_reference_duplicates.py`, plus an end-to-end suite (`test_oracle_end_to_end.py`) that builds a correct submission and asserts the oracle passes it. Scores still
cluster — ten of the twelve checks invoke the submission, so one broken entry point fails almost
all of them — and a column therefore counts failed checks, not independent defects. The oracle now
says so explicitly in its report, listing the checks it never got to evaluate on their merits. Cost and time are per run; every run in this sweep ended `terminated_incomplete`, so the
"Human Intervention/Retries" column of earlier tables would be 1 throughout and has been dropped.

**Scores are bimodal because the entry point gates ten of the twelve checks.** The oracle invokes
`python -m alloydamage` for every check but one, so an arm whose entry point raises scores near
zero regardless of the physics beneath it. Three of the ten t0/t1 results were decided this way:
democratic's 2/12 was a single unrepaired `ImportError` (`cli.py` imported `load_elements`;
`nuclear_data.py` exported `load_multiple_elements`) on a task killed by repeated 300-second
provider timeouts, and single-agent's 0/12 was a missing `__main__.py` — three files changed in
the whole run. Report the entry-point status alongside the score; the score alone overstates how
much of the work differed.

**Single-owner mandates worked, but they do not settle interfaces.** Democratic's t0 ledger shows
**zero** paths claimed by more than one task, `motions_recommitted` down to 8 (16 in the 2026-09-12
v9 sweep) and no `ownership_handoff` events at all (19 in v9). The `ImportError` above happened
anyway: one task owned `cli.py`, another owned `nuclear_data.py`, neither violated ownership, and
nobody agreed on the names between them.

**Earlier results are not comparable.** Before 2026-09-21 the democratic arm alone received
guidance written for this task (literal CSV headers, provenance tokens, the supported-range detail,
and deterministic checks mirroring part of the hidden oracle); every arm's planner received shared
alloy-specific text; and the four doctrine arms' implementers received alloy-specific reminders that
single-agent did not. All of it was removed; see "What every arm receives" in
[`benchmark/README.md`](../benchmark/README.md). The previous sweep (2026-09-12) scored socialist and
capitalist 11/11 and managerial 5/11; part of those scores likely came from the removed text.

**The 2026-09-21 sweep still had unequal treatment**, found and removed on 2026-09-22 — this is the
first sweep run after all six were fixed:
- the capitalist implementer was told to write Node.js on this Python task;
- the democratic and single-agent implementers never saw the goal;
- implementer temperatures differed;
- the sovereign's rejection reasons coached only the arms that escalate;
- the extension allowance was a single first-come pool;
- democratic and socialist read memory left by earlier runs.

"What every arm receives" in [`benchmark/README.md`](../benchmark/README.md) lists what every arm gets
now.

**Provider flakiness is an uncontrolled variable, and it costs wall clock rather than money.** Arms
run sequentially, so each samples a different hour of OpenRouter health. Overnight on 2026-09-22 the
implementer models timed out repeatedly at 300s each; capitalist's t1 run spent 184 minutes and was
terminated after its third wall-clock extension was refused, having reached 4 of 6 tasks on $2.66 of
its $8. The `--trial-index` rotation moves each arm to a different slot per trial, which launders
some of this, but three trials mitigate it rather than remove it. No run in this sweep was stopped
by the cost budget.

</details>

**Repeat trials rather than treating one nondeterministic run as conclusive.** See [`benchmark/README.md`](../benchmark/README.md)
for the reproducible command and artifacts, [`benchmark/starting-repo/TASK.md`](../benchmark/starting-repo/TASK.md)
for the verbatim shared prompt, and [`benchmark/score-rubric.md`](../benchmark/score-rubric.md) for
scoring. The task builds a tested Python CLI for Fe-Cr-Ni neutron displacement-damage calculations
using traceable data—a bounded but non-trivial software-engineering task.

**OpenRouter models.** The roster lives in `config/models.yaml`, and the sweep above used the
current one. Every chat role uses `upstage/solar-mini4` (primary) → `openai/gpt-6-luna` (fallback),
and the `decider` role uses `upstage/solar-decide` → `typesafe/jev-1.13` through the Decisions API.
Every arm of a sweep uses the same roster.

The harness records status, wall-clock time, cost, model calls, phase-grouped spend, prompt/completion
tokens, files changed, approvals, task errors, verification runs, the acceptance-time 12-check oracle,
coverage, state, ledger, recovery manifest, and final patch. Democratic, socialist, capitalist, and
managerial gate release; single-agent is a comparison. The `managerial` and `single_agent` strategies run only through `npm run benchmark`, not `swarm_start`. Run from `mcp-server/`:

```bash
npm run benchmark -- --label controlled-run --budget-usd 8 --max-wall-clock-min 150
```

Add `--strategies democratic,socialist` to run a subset (default: all five).

Add `--decision-models off|pure` to choose how bounded governance choices are made (default: `pure`, since 2026-10-05). `pure` consults decision models through OpenRouter’s alpha Decisions API, using the configured `decider` role (`upstage/solar-decide`, with `typesafe/jev-1.13` fallback); unsuccessful or insufficiently decisive results fall back to the ordinary chat procedure. The engine option is `decisionModels: 'off' | 'pure'`. The former `explain` mode is no longer supported. Keep this setting identical across arms in a controlled comparison.

Use `--stop-after plan` or `--stop-after first-task` for an early-stop diagnostic run. Arms run sequentially by default; `--concurrent` runs the selected arms together as a stress test. The live log prints each doctrine’s governing milestone headlines alongside periodic status, cost, and task counts.

Resume an interrupted sweep with `npm run benchmark -- --resume ../benchmark/results/<run-dir>`.

This invokes real models and costs money. Use identical configuration, task commit, budget, environment, and scoring for every strategy; repeat trials rather than treating one nondeterministic run as conclusive.

