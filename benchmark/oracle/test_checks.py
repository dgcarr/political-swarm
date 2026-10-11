from pathlib import Path

import pytest

from oracle.checks import _require_success_table
from oracle.submission import (
    CalculationObservation,
    CsvTable,
    ProcessObservation,
)


def _observation_with_tables(*tables: CsvTable) -> CalculationObservation:
    process = ProcessObservation(("python", "-m", "alloydamage"), 0, "", "")
    return CalculationObservation(process, Path("case"), tables, (), ())


def test_missing_table_diagnostic_names_found_headers() -> None:
    table = CsvTable(
        Path("result.csv"),
        ("Neutron energy", "Total alloy displacement cross-section"),
        ({"Neutron energy": 1.0, "Total alloy displacement cross-section": 2.0},),
    )

    with pytest.raises(AssertionError, match="result.csv headers=.*Neutron energy"):
        _require_success_table(_observation_with_tables(table))


def test_missing_table_diagnostic_names_absent_semantics() -> None:
    table = CsvTable(
        Path("result.csv"),
        ("Neutron energy", "value"),
        ({"Neutron energy": 1.0, "value": 2.0},),
    )

    with pytest.raises(
        AssertionError,
        match="missing a neutron-energy header stating MeV, an alloy-total displacement cross-section header",
    ):
        _require_success_table(_observation_with_tables(table))


def test_missing_table_diagnostic_names_unitless_cross_sections() -> None:
    table = CsvTable(
        Path("result.csv"),
        ("Neutron energy", "Fe contribution", "Total alloy displacement cross-section"),
        (
            {
                "Neutron energy": 1.0,
                "Fe contribution": 2.0,
                "Total alloy displacement cross-section": 2.0,
            },
        ),
    )

    with pytest.raises(AssertionError, match="barn/dpa-barn units on cross-section headers"):
        _require_success_table(_observation_with_tables(table))


def test_missing_table_diagnostic_reports_no_emitted_csv() -> None:
    with pytest.raises(AssertionError, match="no numeric CSV candidates were emitted"):
        _require_success_table(_observation_with_tables())
