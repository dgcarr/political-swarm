"""Result model and output formatting for the oracle."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class CheckResult:
    id: int
    description: str
    passed: bool
    detail: str


# A check whose detail begins one of these never got as far as judging the thing it exists to judge.
NEVER_EVALUATED_PREFIXES = ("calculation exited", "no numeric result CSV")

# The checks that run the submission (10 reads source, 12 runs its tests). Once check 1, the plainest
# pure-Fe calculation, cannot run, their failures say nothing about the thing they judge, whatever
# their wording ("calculation produced no PNG file", "did not explain the range problem", ...).
PROGRAM_CHECK_IDS = (1, 2, 3, 4, 5, 6, 7, 8, 9, 11)


def blocked_checks(results: list[CheckResult]) -> tuple[CheckResult, ...]:
    """The failures caused by the program not producing a result, rather than producing a wrong one.

    Ten of the twelve checks invoke the submission, so one broken entry point fails almost all of
    them. Separating these keeps a score from reading as ten independent defects.
    """
    never_evaluated = {
        result.id
        for result in results
        if not result.passed and result.detail.startswith(NEVER_EVALUATED_PREFIXES)
    }
    crashes_outright = 1 in never_evaluated
    return tuple(
        result
        for result in results
        if not result.passed
        and (result.id in never_evaluated or (crashes_outright and result.id in PROGRAM_CHECK_IDS))
    )


def two_number_summary(results: list[CheckResult]) -> str:
    """Whether the program runs end to end, and its score on the checks that could judge it.

    Mirrored by summarizeOracle in mcp-server/src/benchmark/runBenchmark.ts, which puts the same
    label in a sweep's metrics.
    """
    blocked = len(blocked_checks(results))
    passed = sum(result.passed for result in results)
    runs = "yes" if blocked == 0 else f"no ({blocked} blocked)"
    return f"runs: {runs} · functional {passed}/{len(results) - blocked}"


def print_report(results: list[CheckResult]) -> None:
    """Emit a JSON report followed by a compact human-readable summary."""
    print(json.dumps([asdict(result) for result in results], indent=2))
    passed_count = sum(result.passed for result in results)
    status = "PASS" if passed_count == len(results) else "FAIL"
    print(f"\nOracle summary: {status} ({passed_count}/{len(results)} checks passed)")
    print(f"  {two_number_summary(results)}")
    blocked = blocked_checks(results)
    if blocked:
        identifiers = ", ".join(str(result.id) for result in blocked)
        print(
            f"  {len(blocked)} of the failures were never evaluated on their own merits: the "
            f"program produced no result for checks {identifiers}. This score counts failed "
            "checks, not independent defects."
        )
    for result in results:
        marker = "PASS" if result.passed else "FAIL"
        print(f"  [{marker}] {result.id}. {result.description}: {result.detail}")
