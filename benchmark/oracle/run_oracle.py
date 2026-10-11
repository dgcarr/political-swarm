#!/usr/bin/env python3
"""Command-line entry point for the evaluator-owned alloy-damage oracle."""

from __future__ import annotations

import argparse
import math
import sys
import tempfile
from pathlib import Path


ORACLE_DIRECTORY = Path(__file__).resolve().parent
BENCHMARK_DIRECTORY = ORACLE_DIRECTORY.parent
sys.path.insert(0, str(BENCHMARK_DIRECTORY))

from oracle.checks import OracleChecks  # noqa: E402
from oracle.reference_data import (  # noqa: E402
    DamageCurve,
    DataPoint,
    alloy_cross_section,
    atomic_fractions_from_weight_percent,
    interpolate_linear,
    interpolate_log_log,
    load_reference_curves,
)
from oracle.report import print_report  # noqa: E402
from oracle.submission import SubmissionRunner  # noqa: E402


REFERENCE_DATA_ROOT = BENCHMARK_DIRECTORY / "starting-repo" / "data"


def main() -> int:
    arguments = _parse_arguments()
    if arguments.self_test:
        return _run_self_test()
    if arguments.submission is None:
        print("error: a submission worktree path is required without --self-test", file=sys.stderr)
        return 2
    submission_root = arguments.submission.resolve()
    if not submission_root.is_dir() or not (submission_root / "alloydamage").is_dir():
        print(
            f"error: {submission_root} must be a directory containing alloydamage/",
            file=sys.stderr,
        )
        return 2
    curves = load_reference_curves(REFERENCE_DATA_ROOT)
    with tempfile.TemporaryDirectory(prefix="alloydamage-oracle-") as scratch_name:
        scratch_root = Path(scratch_name)
        runner = SubmissionRunner(submission_root, scratch_root)
        results = OracleChecks(runner, curves, submission_root).run_all()
    print_report(results)
    return 0 if all(result.passed for result in results) else 1


def _parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run independent evaluator checks against an alloydamage submission."
    )
    parser.add_argument(
        "submission",
        nargs="?",
        type=Path,
        help="built worktree containing the alloydamage package",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="test only the oracle's independent reference mathematics",
    )
    return parser.parse_args()


def _run_self_test() -> int:
    tests = (
        ("linear interpolation", _self_test_linear_interpolation),
        ("log-log interpolation", _self_test_log_interpolation),
        ("interpolation boundary refusal", _self_test_no_extrapolation),
        ("weight-to-atomic conversion", _self_test_atomic_conversion),
        ("50/50 atomic mixture", _self_test_equal_mix),
        ("real reference CSV loading", _self_test_real_data),
    )
    failures = []
    for description, test in tests:
        try:
            detail = test()
            print(f"[PASS] {description}: {detail}")
        except Exception as error:
            failures.append(description)
            print(f"[FAIL] {description}: {error}")
    status = "PASS" if not failures else "FAIL"
    print(f"Self-test summary: {status} ({len(tests) - len(failures)}/{len(tests)} passed)")
    return 0 if not failures else 1


def _self_test_linear_interpolation() -> str:
    curve = DamageCurve("X", (DataPoint(1.0, 10.0), DataPoint(3.0, 20.0)))
    # Hand calculation: 10 + ((2-1)/(3-1))*(20-10) = 15.
    _assert_close(interpolate_linear(curve, 2.0), 15.0)
    return "10 + (1/2)*10 = 15"


def _self_test_log_interpolation() -> str:
    curve = DamageCurve("X", (DataPoint(1.0, 1.0), DataPoint(100.0, 10_000.0)))
    # In log space (0,0) to (2,4), x=10 has log10(y)=2, hence y=100.
    _assert_close(interpolate_log_log(curve, 10.0), 100.0)
    return "log10 interpolation gives 10^2 = 100"


def _self_test_no_extrapolation() -> str:
    curve = DamageCurve("X", (DataPoint(1.0, 1.0), DataPoint(2.0, 2.0)))
    try:
        interpolate_linear(curve, 0.5)
    except ValueError as error:
        if "outside" not in str(error):
            raise AssertionError("boundary error did not explain the native range") from error
        return "0.5 is rejected below native [1, 2]"
    raise AssertionError("reference interpolation silently extrapolated")


def _self_test_atomic_conversion() -> str:
    fractions = atomic_fractions_from_weight_percent({"Fe": 50.0, "Cr": 50.0})
    # Equal masses give x_Fe=(1/A_Fe)/(1/A_Fe+1/A_Cr)=A_Cr/(A_Fe+A_Cr).
    # With A_Fe=55.845 and A_Cr=51.9961 this is 0.48215476288724796.
    _assert_close(fractions["Fe"], 0.48215476288724796)
    _assert_close(fractions["Cr"], 0.517845237112752)
    worked_example = atomic_fractions_from_weight_percent(
        {"Fe": 72.0, "Cr": 18.0, "Ni": 10.0}
    )
    _assert_close(worked_example["Fe"], 0.7139520416796498)
    _assert_close(worked_example["Cr"], 0.19170020332101848)
    _assert_close(worked_example["Ni"], 0.09434775499933185)
    return "50/50 mass and TASK section 9 worked values match hand-derived constants"


def _self_test_equal_mix() -> str:
    curves = {
        "Fe": DamageCurve("Fe", (DataPoint(1.0e6, 10.0), DataPoint(2.0e6, 20.0))),
        "Ni": DamageCurve("Ni", (DataPoint(1.0e6, 30.0), DataPoint(2.0e6, 50.0))),
    }
    first = alloy_cross_section(curves, {"Fe": 0.5, "Ni": 0.5}, 1.0)
    second = alloy_cross_section(curves, {"Fe": 0.5, "Ni": 0.5}, 2.0)
    # Endpoint arithmetic: (10+30)/2=20 and (20+50)/2=35.
    _assert_close(first[0], 20.0)
    _assert_close(second[0], 35.0)
    return "(10+30)/2 = 20 and (20+50)/2 = 35"


def _self_test_real_data() -> str:
    curves = load_reference_curves(REFERENCE_DATA_ROOT)
    expected_endpoints = {
        "Fe": ((95.0, 0.0685984), (30_000_000.0, 3335.53)),
        "Cr": ((93.75, 0.271739), (30_052_600.0, 3359.0)),
        "Ni": ((95.0, 0.107185), (30_291_500.0, 3804.57)),
    }
    summaries = []
    for element, curve in curves.items():
        first_expected, last_expected = expected_endpoints[element]
        first_point, last_point = curve.points[0], curve.points[-1]
        _assert_close(first_point.energy_ev, first_expected[0])
        _assert_close(first_point.cross_section_barn, first_expected[1])
        _assert_close(last_point.energy_ev, last_expected[0])
        _assert_close(last_point.cross_section_barn, last_expected[1])
        preview = (*curve.points[:2], *curve.points[-2:])
        preview_text = ", ".join(
            f"({point.energy_ev:g} eV,{point.cross_section_barn:g} b)" for point in preview
        )
        summaries.append(f"{element}[{len(curve.points)}]: {preview_text}")
    return "; ".join(summaries)


def _assert_close(actual: float, expected: float) -> None:
    if not math.isclose(actual, expected, rel_tol=1.0e-12, abs_tol=1.0e-12):
        raise AssertionError(f"got {actual:.16g}, expected {expected:.16g}")


if __name__ == "__main__":
    raise SystemExit(main())
