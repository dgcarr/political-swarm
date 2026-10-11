"""The loader's policy on repeated energies, which TASK.md now states as a rule for submissions.

Fe's supplied CSV lists 30 MeV twice with the same cross-section. The oracle has always collapsed
such a pair and rejected a contradictory one, but neither behaviour was tested and nothing told a
submission which was expected. An arm that read "do not substitute the data" as forbidding any
deduplication spent all eight of its attempts on the contradiction and was abandoned, so the rule
is now written down in TASK.md and pinned here.
"""

from pathlib import Path

import pytest

from oracle.reference_data import load_damage_curve

HEADER = "energy_eV,displacement_xs_barn\n"


def _csv(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "curve.csv"
    path.write_text(HEADER + body, encoding="utf-8")
    return path


def test_repeated_energy_with_one_cross_section_becomes_one_point(tmp_path: Path) -> None:
    curve = load_damage_curve(_csv(tmp_path, "1.0,10.0\n2.0,20.0\n2.0,20.0\n"), "Xx")

    assert [point.energy_ev for point in curve.points] == [1.0, 2.0]
    assert curve.maximum_energy_ev == 2.0


def test_repeated_energy_with_two_cross_sections_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="conflicting duplicate energy"):
        load_damage_curve(_csv(tmp_path, "1.0,10.0\n2.0,20.0\n2.0,21.0\n"), "Xx")


def test_the_supplied_fe_curve_carries_the_duplicate_this_rule_is_about() -> None:
    """Guards the premise: if the fixture is ever cleaned, the TASK.md paragraph can go too."""
    data = Path(__file__).resolve().parents[2] / "benchmark/starting-repo/data/Fe/Fe_dpa_nrt.csv"
    rows = data.read_text(encoding="utf-8").strip().splitlines()[1:]
    energies = [row.split(",")[0] for row in rows]

    assert len(energies) - len(set(energies)) == 1
    curve = load_damage_curve(data, "Fe")
    assert len(curve.points) == len(rows) - 1
