# Oracle audit, 2026-09-24

Why the benchmark's eleven evaluator-owned checks changed, and what the three-trial sweep of
2026-09-22/23 actually measured. Kept as the record `README.md` points at; it began as items P2 and
P3 of the project plan, which was retired once every item closed. The earlier planning items (P0,
P0b, P1 — cross-arm fairness and documentation drift, all closed 2026-09-21/22) remain in the git
history.

Every claim below was checked by re-running the oracle over the fifteen preserved worktrees of that
sweep, and every fix by mutation: restoring a defect must fail its own regression test and nothing
else.

## The trial-2 anomaly: the oracle was right, three arms shared a log-linear interpolation bug

**Question:** did the oracle's two accepted interpolation conventions cover what a correct
implementation may do, or did trial 2's arms share a real defect?

**Answer: a real defect.** The conventions are adequate.

Two premises of the original question were wrong. It was three arms, not five: capitalist's entry
point raised and single-agent emitted no CSV, so neither was ever scored numerically. And the value
*does* match a third convention — log-linear, logarithmic in energy and linear in cross-section.
The earlier check that ruled log-lin out evaluated it at ~0.684 MeV; the grid point is 0.3982713 MeV
(`emin` 0.118816, `emax` 15.0, 5 points, log-spaced). At the right energy log-linear reproduces every
emitted row exactly. All three arms do `np.interp(log(E_target), log(E_source), sigma_source)`
— `socialist/nuclear_data.py:111`, `democratic/damage.py:54`, `managerial/damage.py:169`.

**Check 6 is dispositive.** `_check_synthetic_interpolation` substitutes a two-point Fe curve,
1 MeV → 10 barn and 100 MeV → 1000 barn, and requires σ = 10·E at interior points. That curve is both
a straight line and a pure power law, so linear and log-log reproduce it exactly — the probe is
convention-independent by construction. Log-linear gives 10 + log(2)/log(100)·990 = 159.0098 at
2 MeV against 20. An 8× error on a case where both accepted conventions agree is a defect, not a
disagreement about convention. No third convention should be added to `interpolation_candidates()`.

**Six failed checks, one defect.** Checks 3 and 4 are not composition bugs.
`_infer_atomic_fractions` (`checks.py:353`) divides the arm's emitted per-element contribution by the
*oracle's* interpolated value, so an interpolation error surfaces as a wrong atomic fraction. Check
3's got/expected ratio is 1.0006797191 against a log-linear/linear ratio of 1.0006797466 at the same
energy; check 4's is 0.9994964792 against 0.9994952596. The arms' weight-percent → atomic-fraction
maths was most likely correct. Checks 1, 2, 3, 4, 6 and 8 all trace to the single interpolation
choice.

**Why three independent arms made the same choice.** TASK.md:108 says only "use an appropriate
interpolation method and document the choice", and TASK.md:118 requires "a logarithmic neutron-energy
axis" for the *plot*. The plausible reading is that the plotting requirement bled into the numerical
one: all three took the log of energy and left the cross-section linear.

**What lets it survive.** TASK.md Test 6 asks each arm to "verify the interpolation routine against a
simple artificial dataset with a known answer". All three wrote that test and all three generated the
fixture *from* the convention under test, so it cannot fail:
- managerial (`tests/test_damage.py:84`): σ = 0, 100 at E = 1, 10; asserts σ(√10) = 50 "because
  linear interpolation in log-space gives exactly 50 barn";
- democratic (`tests/test_damage.py:49`): σ = 2·log(E) + 1, "linear in log-energy; log-linear interp
  is exact";
- socialist: σ = 1, 2, 3 at E = 100, 1000, 10000 — linear in log E.

Single-agent was the only arm to choose a convention-independent fixture (σ = E², a true power law),
and it never reached scoring. This is the generalisable lesson and the one worth carrying into the
strategies: *a known-answer test must derive its expected values from a relation that holds
independently of the implementation's chosen convention.* None of the five doctrines has any
mechanism that would catch a self-confirming test — the Opposition, the audit and the review boards
all check that a test exists and passes, not that its oracle is independent.

Trial 2 therefore measures correctness after all, and `README.md` has been corrected: its scores are
low because three arms shipped a genuine numerical bug behind a test that could not detect it. The
`terminated_incomplete` status and the entry-point gating remain the reasons t2 is not a clean
doctrine comparison.

## Audit of the checks: seven findings, and a twelfth check added

An audit of the eleven evaluator-owned checks in `benchmark/oracle/checks.py` — the tests applied to
every strategy's output — found seven problems. Two were fixed; both turned out to be latent, and
re-scoring all fifteen preserved worktrees of the three-trial sweep reproduced every published score
exactly, so `README.md`'s table is unchanged.

**Fixed.** Check 5 identified the unsupported element with `"cu" in output`, a substring test that
`"calculate"` satisfies, so it could not do what its failure message claimed. It now matches whole
words against `{cu, copper}`. Check 7 accepted an arm that clamped the out-of-range request into
range: clamped rows sit *at* the data minimum, not below it, so the below-minimum guard never fired,
and `clipp?(ed|ing)` was in the accepted-message list — while `rangeReminder()`, which every arm
receives, forbids clamping. It now rejects any emitted energy that was never requested.

The first attempt at that second fix was itself wrong, in the manner this audit is about: it assumed
the probe span lay entirely below Fe's minimum and failed eleven of fifteen runs that were behaving
correctly. The span straddles the minimum — Fe starts at 9.5e-5 MeV and the probe runs 1e-5 to 1e-4
MeV. The check now asserts that precondition instead of assuming it. This is the concrete argument
for the regression tests that accompany the fix: an unverified boundary assumption inside a grader
is indistinguishable from a defect in everything it grades.

**Open, in rough order of how much they distort a score.**

1. ~~*Checks 3 and 4 are not independent of check 1.*~~ **Fixed 2026-09-24.**
   `_infer_atomic_fractions` divided the arm's emitted per-element contribution by the oracle's own
   interpolated value, so an interpolation defect failed the composition checks too. It now infers
   only from rows sitting on an energy the source CSVs tabulate directly: every convention returns
   the listed value at a tabulated point, so the ratio there is the atomic fraction alone. This is
   check 6's trick applied to composition — choose a probe where the thing you are not testing
   cancels out. The standard probe's endpoints (0.118816 and 15 MeV) were already tabulated in all
   three elements, so no extra submission run was needed. Re-scoring moved exactly four runs, each
   by exactly the two checks concerned and nothing else: t2 democratic 3→5, t2 socialist 5→7,
   t2 managerial 5→7, t0 single-agent 5→7. `README.md`'s table is updated.
2. ~~*Checks 1, 2 and 8 are sensitive to emitted precision.*~~ **Fixed 2026-09-24.** The oracle
   re-derived its expectation at the energy the submission printed, and a cross-section amplifies
   an energy error about sevenfold against a 2e-4 tolerance, so a numerically correct program
   printing four significant figures failed three checks for its output formatting. `CsvTable` now
   keeps each cell's printed text and `printed_interval()` reads half a unit of the last decimal
   place off it; the checks accept any value the permitted conventions reach anywhere in that
   interval. Each convention is banded separately, so the extra room never lets a rejected
   convention's answer slip between two accepted ones — verified by a test that still rejects
   log-linear at coarse precision.
3. ~~*Check 6 would punish data-integrity verification.*~~ **Fixed 2026-09-24.**
   `calculate_with_synthetic_fe` overwrote the Fe CSV in a clone, so a submission that verified its
   inputs by digest — as this evaluator does — would refuse the substituted curve and fail a check
   about interpolation. `_substitute_data_file` now rewrites the old digest's exact text wherever
   the clone records it, leaving everything else untouched.
4. ~~*Check 10 is the only white-box check.*~~ **Narrowed 2026-09-24.** It remains source-level,
   because a PNG cannot expose axis-scale metadata, but it no longer recognises one idiom only:
   `xscale='log'` is accepted as a keyword to any callee (`add_subplot`) and inside a dict literal
   (`subplot_kw`), not just on `.set()`.
5. ~~*Scores cluster.*~~ **Disclosed 2026-09-24.** Ten of the twelve checks invoke the submission,
   so one broken entry point fails almost all of them. `report.blocked_checks()` now separates
   failures where the program produced no result at all from failures on the merits, and
   `print_report` says so in a line under the summary. The score itself is unchanged: this is a
   reporting fix, because inferring distinct root causes automatically is not something the oracle
   can do honestly.
6. ~~*Check 5 accepts a zero exit status.*~~ **Fixed 2026-09-24.** A submission that named the
   unsupported element clearly but exited 0 passed, so anything scripting it read success. A
   non-zero exit is now part of rejecting the input loudly.

All four code fixes above proved latent: re-scoring the fifteen preserved worktrees reproduced the
table in `README.md` unchanged.

**P3 is closed.** All seven findings are fixed or disclosed, and no recorded score moved except the
four the composition decoupling corrected.

The suite is `benchmark/oracle/test_eleven_checks.py` (unit level, constructed observations) and
`benchmark/oracle/test_oracle_end_to_end.py`, which builds a small but genuinely correct
`alloydamage` package over the real data and asserts the oracle passes it — the property that
matters most in a grader and the one stubs cannot cover. 71 tests in about 0.2 s.

Every fix was confirmed by mutation rather than by inspection: restoring a defect makes exactly its
own regression test fail and nothing else, and making the end-to-end submission interpolate
log-linearly reproduces 533.896771725 — the value three arms emitted in trial 2, arrived at here
from an independent direction.

`run_oracle.py --self-test` already covers `reference_data.py` well, and is the model the new tests
follow: every expected value is hand-derived in a comment rather than computed by the code under test.

## A twelfth check: the submission's own test suite

The task asks for a test suite and nothing verified one existed. The 2026-09-24 trial made the gap
plain: two arms shipped **no test files at all** — the task that would have written them was
abandoned and its files discarded — and a third shipped a suite with seven failures, while all three
were scored on behaviour alone and two of them scored well.

Check 12 runs the submission's own tests from its own root and requires that test files exist, that
they collect something, and that the suite exits zero. Re-scoring every preserved worktree moved
each arm by at most one point, upward where it already had a green suite:

| arm | fair-t0 | fair-t1 | fair-t2 |
|---|---:|---:|---:|
| Democratic | 2/12 | 11/12 | 5/12 |
| Socialist | 11/12 | 12/12 | 8/12 |
| Capitalist | 11/12 | 11/12 | 4/12 |
| Managerial | 12/12 | 12/12 | 8/12 |
| Single-agent | 7/12 | 0/12 | 5/12 |

Managerial is the only arm that delivered a passing suite in every trial. That the check changes so
few scores is the point: it was never measuring anything the other eleven measured, which is why a
submission with no tests could reach 11/11.

## What adding the twelfth check broke, and the two fixes that followed

Adding check 12 raised the oracle's output from eleven results to twelve. Two places in the harness
still said eleven, and one of them was not a display constant:

```ts
requiredExternalEvaluationCount: 11
```

`SwarmEngine` treats an evaluation record whose length is not exactly that number as corrupt and
refuses the delivery — sensibly, since a short record means the oracle did not finish. With the
oracle returning twelve, that test was true on every run, so **acceptance became unreachable**. A
run could satisfy all twelve checks and still be sent back with the finding "External oracle
returned 12 checks; exactly 11 are required." Runs then looped until the harness's poll deadline
killed them.

This is what happened to the 2026-09-24 space-bunny socialist run: 135 minutes, 185 worker calls,
537 lines written, ended `harness_error`. The overrun was a symptom; the off-by-one was the cause.

Both sites now read `ORACLE_CHECK_COUNT`, and `oracleCheckCount.test.ts` parses the checks tuple out
of `checks.py` and asserts the constant matches it, so the Python and TypeScript halves cannot drift
apart again silently.

### A harness failure no longer discards the run

`harnessErrorMetrics` returned a zero-filled record — no cost, no calls, no files, and
`oracleDetail: "run did not complete, no worktree to score"` even though the worktree was on disk
with 537 lines in it. The measurements existed; the harness threw them away because it had run out
of patience.

`runStrategy` now catches a failure from `autoResolveUntilTerminal`, stops that one run so its loop
cannot keep writing to the worktree being snapshotted, and scores it exactly as a completed run,
labelling the result `harness_error` with the cause in `note`. The zero-filled record remains only
for a failure so early that no run exists to score.

This is the same argument, one level up, as the decision that an abandoned task should not sink a
run: a deadline is a fact about the harness, not a verdict on the work.

### The Fe duplicate row

`data/Fe/Fe_dpa_nrt.csv` lists 30 MeV twice, with identical cross-sections; Cr and Ni have no
duplicates. `reference_data._validated_unique_points` has always collapsed an exact repeat and
rejected a contradictory one, but nothing said so and no test covered it. TASK.md told submissions
not to substitute the supplied data, and the socialist arm read that — reasonably — as forbidding
deduplication, could not reconcile it with a strictly increasing support, and spent all eight
attempts on the contradiction before being abandoned.

An arm reaching for `numpy.interp`, which tolerates repeated abscissae silently, never noticed. The
benchmark was rewarding not looking. TASK.md now states the rule, and
`test_reference_duplicates.py` pins both branches of the loader's behaviour plus the premise that
the fixture still contains the duplicate the rule is about.

Runs before this TASK.md change saw a task description that did not state the rule; the change is
small and clarifying rather than substantive, but it is a difference in the prompt and is recorded
here for that reason.

## Addendum, 2026-10-07: the log-linear finding is reversed, and two more check defects

**Log-linear is a legitimate convention.** The section above calls it a defect because check 6's
synthetic curve gives 159.01 instead of 20. That probe is two points two decades apart, chosen so
that lin-lin and log-log are exact; it measures agreement with those two laws, not accuracy. Against
the real ground truth, the full ~170k-point IAEA evaluations in `benchmark/raw-source/` (ENDF INT=2),
each law applied to the supplied ~400-point CSV misses by about the same amount over 1 keV-20 MeV
(median relative error):

| element | lin-lin | linear in log E | log-log | log sigma linear in E |
|---|---:|---:|---:|---:|
| Fe | 1.33% | 1.33% | 1.21% | 1.20% |
| Cr | 1.97% | 1.96% | 1.77% | 1.80% |
| Ni | 1.23% | 1.20% | 1.00% | 1.00% |

The downsampled grid cannot resolve the resonances, so no law is right; the laws differ from one
another by 0.07-0.4%, a fraction of that error. At 0.398 MeV the accepted log-log sits 0.38% from
lin-lin and the rejected linear-in-log-E 0.07%. TASK.md asks only for "an appropriate interpolation
method", documented, and the supplied files record no law. `INTERPOLATION_LAWS` in
`benchmark/oracle/reference_data.py` now holds all four ENDF laws (INT=2..5), banded separately as
before; check 6 requires every interior row to match one law's exact answer on the synthetic curve.

**Check 6 also tested range policy.** It asked for 2-50 MeV, while Cr and Ni, left real in the
clone, end at 30.05 MeV. Four arms that bound the grid by every loaded dataset refused with a clear
range error and failed a check about interpolation. The probe now asks for 2-20 MeV.

**Check 5's vocabulary failed plain English.** "Calculation failed: Element 'Cu' has no supported
displacement-damage data", with exit 1 and no output, failed, because it contains none of
`unsupported / no data / missing / not found / error / unknown`, while a bare `KeyError: 'Cu'`
traceback passed via "error". The list now includes `supported`, `fail`, `cannot`, `invalid`,
`not available` and `unavailable`.

**Effect.** Re-scoring all 125 preserved worktrees: 526 -> 590 checks passed, no check lost on any
arm, and 13 -> 21 arms at 12/12. Gains are on checks 1, 2, 8 (14 arms each), 6 (19) and 5 (3).
Sweep scores before this change are not comparable with scores after it.

**Addendum, 2026-10-08: extensionless result CSVs.** The oracle read only `*.csv` files from a
calculation's output directory. TASK.md's example is `--output results/304L`, and it never says a
suffix is appended. The 2026-10-07b socialist arm wrote a correct CSV to exactly the path it was
given, so six numerical checks were blocked and it read `runs: no (6 blocked) · functional 6/6`;
with the file read, it scores 12/12. `SubmissionRunner` now also parses extensionless files.
Re-scoring all 131 preserved worktrees: 625 -> 632 checks. One check moved the other way, and
correctly. With its output now visible, `baseline-off-r2/democratic` turned out to clamp a
below-range request into range, so it fails check 7 and passes checks 1 and 6.

**Addendum, 2026-10-08: check 7 word order.** The capitalist-luna arm refused the below-range probe
with exit 2 and `Requested range [10, 100] is outside supported intersection [95, 3e+07]`. That is
the behaviour check 7 asks for. It still failed, because every pattern wanted the range word *after*
`outside`. Check 7 now also accepts `(range|energy)` followed within 40 characters by `outside` or
`beyond`. Re-scoring all 132 preserved worktrees: 643 -> 644 checks. The only change is that arm,
11/12 -> 12/12. In-run, that arm spent two remediation cycles on code that was already correct,
because the swarm sees only the failed check's name, not its detail.

**Addendum, 2026-10-08: check 9 runs the literal default command.** TASK.md says
`python -m alloydamage calculate examples/304L.yaml` "must produce the calculated alloy cross-section
and plot". Check 9 judged the plot from the probe run, which retries with `--plot <path>`, then
`--plot`, then no flag, and keeps the first form that exits 0. So a submission whose default command
wrote no plot passed. Socialist cycle 4 was one: its own verifier refused the delivery for exactly
this, while the oracle scored it 12/12. Check 9 now runs the literal command, with no flags, in a
copy of the submission (`SubmissionRunner.run_default_command`). It passes only on exit 0 and a new
valid PNG anywhere under that copy. Re-scoring all 146 preserved worktrees: 808 -> 794 checks, all
on check 9. Fifteen arms lose it. Most need `--plot` before they write a plot, and one
(`full-2026-10-07b/capitalist`, in the README table, 6/12 -> 5/12) crashes on a fresh checkout,
writing `results/304L.csv` without creating `results/`. One arm, `abdm2-pure-r1/democratic`, gains
it: its default command plots, but every probe form it was given exited non-zero.
