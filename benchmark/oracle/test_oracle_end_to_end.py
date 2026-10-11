"""End-to-end checks against a correct reference submission.

The most important property of a grader is that it passes work that is right. Everything in
`test_eleven_checks.py` drives the checks with constructed observations; this file instead builds a
small but genuinely correct `alloydamage` package over the real reference data, runs the oracle
against it as a subprocess exactly as a graded submission is run, and asserts it comes back clean.

That covers the parts a stubbed observation cannot: the CLI contract, CSV parsing and header
matching, and the printed precision of the emitted energies.

Derived from a suite drafted by a subagent during the 2026-09-24 oracle audit; its unit-level tests
duplicated `test_eleven_checks.py` and were dropped, and these were kept.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from oracle.checks import OracleChecks
from oracle.reference_data import load_reference_curves
from oracle.submission import SubmissionRunner

BENCHMARK_DIRECTORY = Path(__file__).resolve().parent.parent
REFERENCE_DATA_ROOT = BENCHMARK_DIRECTORY / "starting-repo" / "data"
REFERENCE_CURVES = load_reference_curves(REFERENCE_DATA_ROOT)


ALLOYDAMAGE_MAIN = '''
"""A deliberately minimal, correct alloydamage submission used only by tests."""

import argparse
import csv
import random
import struct
import sys
import zlib
from pathlib import Path

ATOMIC_WEIGHTS = {"Fe": 55.845, "Cr": 51.9961, "Ni": 58.6934}

print("source: IAEA Nuclear Data Section; model: NRT; dataset: DXS-2018 (26Fe0)")


def read_composition(path):
    composition = {}
    inside = False
    for line in Path(path).read_text().splitlines():
        if line.startswith("composition:"):
            inside = True
        elif inside and line.startswith("  "):
            element, amount = line.split(":", 1)
            composition[element.strip()] = float(amount)
        elif inside:
            inside = False
    return composition


def data_root():
    for candidate in (Path("data"), Path(__file__).resolve().parent.parent / "data"):
        if candidate.is_dir():
            return candidate
    raise SystemExit("no data directory found")


def load(element):
    path = data_root() / element / (element + "_dpa_nrt.csv")
    with path.open(newline="") as handle:
        reader = csv.DictReader(handle)
        return [
            (float(row["energy_eV"]), float(row["displacement_xs_barn"]))
            for row in reader
        ]


def interpolate(points, energy_ev):
    if energy_ev < points[0][0] or energy_ev > points[-1][0]:
        raise SystemExit("error: %g eV is outside the available energy range" % energy_ev)
    for index in range(1, len(points)):
        low, high = points[index - 1], points[index]
        if low[0] <= energy_ev <= high[0]:
            if high[0] == low[0]:
                return low[1]
            fraction = (energy_ev - low[0]) / (high[0] - low[0])
            return low[1] + fraction * (high[1] - low[1])
    return points[-1][1]


def atomic_fractions(composition):
    moles = {k: v / ATOMIC_WEIGHTS[k] for k, v in composition.items()}
    total = sum(moles.values())
    return {k: v / total for k, v in moles.items()}


def write_png(path):
    generator = random.Random(3)
    width = height = 48
    scanlines = b"".join(
        bytes([0]) + bytes(generator.randrange(256) for _ in range(width * 3))
        for _ in range(height)
    )
    def chunk(tag, data):
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)
    blob = b"\\x89PNG\\r\\n\\x1a\\x0a"
    blob += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    blob += chunk(b"IDAT", zlib.compress(scanlines, 0))
    blob += chunk(b"IEND", b"")
    Path(path).write_bytes(blob)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command")
    parser.add_argument("alloy")
    parser.add_argument("--emin", type=float, default=1.0e-3)
    parser.add_argument("--emax", type=float, default=20.0)
    parser.add_argument("--points", type=int, default=50)
    parser.add_argument("--output", default="results/304L")
    parser.add_argument("--plot", nargs="?", const="plot.png")
    arguments = parser.parse_args()

    composition = read_composition(arguments.alloy)
    for element in composition:
        if element not in ATOMIC_WEIGHTS:
            raise SystemExit("error: unsupported element %s" % element)
    fractions = atomic_fractions(composition)
    curves = {element: load(element) for element in fractions}

    ratio = arguments.emax / arguments.emin
    steps = max(arguments.points - 1, 1)
    energies = [
        arguments.emin * ratio ** (index / steps) for index in range(arguments.points)
    ]

    elements = list(fractions)
    headers = ["Neutron energy [MeV]"]
    headers += ["%s contribution [barn]" % element for element in elements]
    headers.append("Total alloy displacement cross-section [barn]")

    rows = []
    for energy in energies:
        contributions = [
            fractions[element] * interpolate(curves[element], energy * 1.0e6)
            for element in elements
        ]
        rows.append([energy] + contributions + [sum(contributions)])

    Path(arguments.output).parent.mkdir(parents=True, exist_ok=True)
    with open(arguments.output + ".csv", "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(headers)
        for row in rows:
            writer.writerow(["%.12g" % value for value in row])

    write_png(arguments.plot or arguments.output + ".png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
'''

ALLOYDAMAGE_PLOTTING = '''
import matplotlib.pyplot as plt


def draw(energies, values, path):
    figure, axes = plt.subplots()
    axes.set_xscale("log")
    axes.plot(energies, values)
    figure.savefig(path)
'''


@pytest.fixture(scope="module")
def correct_submission(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("submission")
    package = root / "alloydamage"
    package.mkdir()
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "__main__.py").write_text(ALLOYDAMAGE_MAIN, encoding="utf-8")
    (package / "plotting.py").write_text(ALLOYDAMAGE_PLOTTING, encoding="utf-8")
    (root / "data").symlink_to(REFERENCE_DATA_ROOT, target_is_directory=True)
    (root / "examples").mkdir()
    (root / "examples" / "304L.yaml").write_text(
        "name: Simplified 304L\ncomposition:\n  Fe: 72\n  Cr: 18\n  Ni: 10\nunits: weight_percent\n",
        encoding="utf-8",
    )
    return root


@pytest.fixture(scope="module")
def real_checks(correct_submission: Path, tmp_path_factory: pytest.TempPathFactory) -> OracleChecks:
    scratch = tmp_path_factory.mktemp("scratch")
    runner = SubmissionRunner(correct_submission, scratch)
    return OracleChecks(runner, REFERENCE_CURVES, correct_submission)


def test_end_to_end_pure_fe_reproduction_passes(real_checks: OracleChecks) -> None:
    assert real_checks._check_pure_fe().startswith("5 emitted curve points match")


def test_end_to_end_csv_schema_passes(real_checks: OracleChecks) -> None:
    assert "3 independently computed rows are correct" in real_checks._check_csv_output()


def test_end_to_end_weight_conversion_passes(real_checks: OracleChecks) -> None:
    assert "Fe=0.71395204" in real_checks._check_weight_conversion()


def test_end_to_end_plot_generation_passes(real_checks: OracleChecks) -> None:
    assert "48x48" in real_checks._check_plot_generation()


def test_end_to_end_log_axis_passes(real_checks: OracleChecks) -> None:
    assert "sets x scale to log" in real_checks._check_log_axis()


def test_end_to_end_accepts_a_csv_written_to_the_exact_output_path(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    # TASK.md's example is `--output results/304L`; writing the CSV to that path, unsuffixed, is a
    # reading of it, as the 2026-10-07b socialist arm showed. Its six numerical checks were blocked.
    root = tmp_path_factory.mktemp("unsuffixed-submission")
    package = root / "alloydamage"
    package.mkdir()
    (package / "__init__.py").write_text("", encoding="utf-8")
    main = ALLOYDAMAGE_MAIN.replace('arguments.output + ".csv"', "arguments.output")
    assert main != ALLOYDAMAGE_MAIN
    (package / "__main__.py").write_text(main, encoding="utf-8")
    (package / "plotting.py").write_text(ALLOYDAMAGE_PLOTTING, encoding="utf-8")
    (root / "data").symlink_to(REFERENCE_DATA_ROOT, target_is_directory=True)
    checks = OracleChecks(SubmissionRunner(root, tmp_path_factory.mktemp("scratch")), REFERENCE_CURVES, root)
    assert checks._check_pure_fe().startswith("5 emitted curve points match")
