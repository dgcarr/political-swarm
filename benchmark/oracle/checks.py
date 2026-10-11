"""The twelve evaluator-owned benchmark checks."""

from __future__ import annotations

import ast
import math
import re
import struct
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .reference_data import (
    ATOMIC_WEIGHTS_G_PER_MOL,
    DamageCurve,
    DataPoint,
    alloy_cross_section,
    atomic_fractions_from_weight_percent,
    interpolation_candidates,
    tabulated_cross_section,
)
from .report import CheckResult
from .submission import (
    CalculationObservation,
    CalculationRequest,
    CsvTable,
    SubmissionRunner,
    find_contribution_header,
    find_energy_header,
    find_total_header,
    select_result_table,
)


RELATIVE_NUMERIC_TOLERANCE = 2.0e-4
ABSOLUTE_NUMERIC_TOLERANCE = 1.0e-8
MINIMUM_PNG_BYTES = 1_024
# Cache key for the run of TASK.md's literal command; no calculation request uses it.
DEFAULT_COMMAND_CASE = "default-command"
# The curve SubmissionRunner.calculate_with_synthetic_fe substitutes for Fe: 1 MeV -> 10 b, 100 MeV -> 1000 b.
SYNTHETIC_FE_CURVE = DamageCurve("Fe", (DataPoint(1.0e6, 10.0), DataPoint(1.0e8, 1000.0)))


@dataclass
class OracleChecks:
    runner: SubmissionRunner
    curves: dict[str, DamageCurve]
    submission_root: Path
    _observations: dict[str, CalculationObservation] = field(default_factory=dict)

    def run_all(self) -> list[CheckResult]:
        checks: tuple[tuple[str, Callable[[], str]], ...] = (
            ("Pure-Fe reproduction", self._check_pure_fe),
            ("50/50 atomic Fe-Ni mixture", self._check_equal_atomic_mix),
            ("wt%-to-atomic-fraction conversion", self._check_weight_conversion),
            ("Normalisation", self._check_normalisation),
            ("Unsupported element", self._check_unsupported_element),
            ("Interpolation accuracy", self._check_synthetic_interpolation),
            ("No extrapolation", self._check_no_extrapolation),
            ("CSV output schema and values", self._check_csv_output),
            ("Plot generation", self._check_plot_generation),
            ("Log-scale neutron-energy axis", self._check_log_axis),
            ("Provenance reachable from program output", self._check_provenance),
            ("Submission's own test suite", self._check_test_suite),
        )
        results = []
        for check_id, (description, check) in enumerate(checks, start=1):
            try:
                detail = check()
                results.append(CheckResult(check_id, description, True, detail))
            except Exception as error:
                results.append(CheckResult(check_id, description, False, str(error)))
        return results

    def _check_pure_fe(self) -> str:
        observation = self._calculate(
            CalculationRequest("pure-fe", "Oracle pure Fe", {"Fe": 100.0}, 0.118816, 15.0, 5)
        )
        table = _require_success_table(observation)
        total_header = _required_header(find_total_header(table), "alloy total")
        energy_header = _required_header(find_energy_header(table), "energy [MeV]")
        checked = 0
        for index, row in enumerate(table.rows):
            bands = _bands_over_printed_energy(
                lambda energy: interpolation_candidates(self.curves["Fe"], energy),
                table,
                index,
                energy_header,
            )
            _require_within_bands(row[total_header], bands, "pure-Fe total")
            checked += 1
        if checked < 2:
            raise AssertionError("pure-Fe output contained fewer than two numeric energy rows")
        return f"{checked} emitted curve points match Fe_dpa_nrt.csv-derived values"

    def _check_equal_atomic_mix(self) -> str:
        mass_total = ATOMIC_WEIGHTS_G_PER_MOL["Fe"] + ATOMIC_WEIGHTS_G_PER_MOL["Ni"]
        composition = {
            "Fe": 100.0 * ATOMIC_WEIGHTS_G_PER_MOL["Fe"] / mass_total,
            "Ni": 100.0 * ATOMIC_WEIGHTS_G_PER_MOL["Ni"] / mass_total,
        }
        observation = self._calculate(
            CalculationRequest("equal-atomic", "Oracle equal atomic Fe Ni", composition, 0.118816, 15.0, 5)
        )
        table = _require_success_table(observation)
        energy_header = _required_header(find_energy_header(table), "energy [MeV]")
        total_header = _required_header(find_total_header(table), "alloy total")
        checked = 0
        for index, row in enumerate(table.rows):
            bands = _bands_over_printed_energy(
                lambda energy: alloy_cross_section(self.curves, {"Fe": 0.5, "Ni": 0.5}, energy),
                table,
                index,
                energy_header,
            )
            _require_within_bands(row[total_header], bands, "50/50 Fe-Ni total")
            checked += 1
        if checked < 3:
            raise AssertionError("equal-atomic output contained fewer than three energy rows")
        return f"{checked} totals match 0.5*Fe + 0.5*Ni from independently loaded CSVs"

    def _check_weight_conversion(self) -> str:
        composition = {"Fe": 72.0, "Cr": 18.0, "Ni": 10.0}
        expected = atomic_fractions_from_weight_percent(composition)
        observation = self._standard_observation()
        table = _require_success_table(observation)
        inferred = _infer_atomic_fractions(table, self.curves, expected)
        return "inferred atomic fractions match CIAAW-weight calculation: " + _format_fractions(inferred)

    def _check_normalisation(self) -> str:
        composition = {"Fe": 71.5, "Cr": 18.2, "Ni": 10.1}
        observation = self._calculate(
            CalculationRequest("normalisation", "Oracle 99.8 percent", composition, 0.118816, 15.0, 3)
        )
        if observation.process.return_code != 0:
            if _contains_clear_warning(observation.process.combined_output):
                return "submission rejected 99.8% input with a clear warning/error"
            raise AssertionError(
                "99.8% input failed without a clear normalisation warning: "
                + _compact(observation.process.combined_output)
            )
        expected = atomic_fractions_from_weight_percent(composition)
        inferred = _infer_atomic_fractions(_require_success_table(observation), self.curves, expected)
        return "99.8% input was normalized correctly: " + _format_fractions(inferred)

    def _check_unsupported_element(self) -> str:
        observation = self._calculate(
            CalculationRequest(
                "unsupported", "Oracle unsupported Cu", {"Fe": 90.0, "Cu": 10.0}, 0.118816, 15.0, 2
            )
        )
        output = observation.process.combined_output.casefold()
        # Whole words, not substrings: "cu" occurs inside "calculate", "accuracy" and "document",
        # so a substring test passes any message that merely mentions calculating.
        words = set(re.findall(r"[a-z]+", output))
        # "supported" covers "unsupported", "not supported" and "has no supported ... data"; "fail" covers
        # "Calculation failed: ...". A list without them passed a bare KeyError traceback (via "error")
        # while failing a sentence that rejected Cu in plain words.
        clear_error = bool(words & {"cu", "copper"}) and any(
            token in output
            for token in (
                "supported", "no data", "missing", "not found", "error", "unknown", "fail",
                "not available", "unavailable", "cannot", "invalid",
            )
        )
        produced_partial_result = select_result_table(observation) is not None
        # A non-zero exit is part of rejecting it loudly: anything scripting the program reads exit
        # 0 as success however clear the message on stderr was.
        if observation.process.return_code == 0:
            raise AssertionError("unsupported Cu was not rejected loudly: the program exited 0")
        if produced_partial_result:
            raise AssertionError("unsupported Cu was reported but a partial result was still produced")
        if not clear_error:
            raise AssertionError("failure did not clearly identify unsupported Cu")
        return f"Cu is identified and rejected (exit {observation.process.return_code})"

    def _check_synthetic_interpolation(self) -> str:
        # 20 MeV, not higher: Cr and Ni, left real in the clone, end at about 30 MeV, and a program that
        # bounds the grid by every loaded dataset would refuse a wider span before interpolating at all.
        request = CalculationRequest(
            "synthetic-interpolation", "Oracle synthetic Fe", {"Fe": 100.0}, 2.0, 20.0, 3
        )
        observation = self.runner.calculate_with_synthetic_fe(request)
        table = _require_success_table(observation)
        energy_header = _required_header(find_energy_header(table), "energy [MeV]")
        total_header = _required_header(find_total_header(table), "alloy total")
        interior_rows = [row for row in table.rows if 1.0 < row[energy_header] < 100.0]
        if not interior_rows:
            raise AssertionError("synthetic run emitted no point strictly between its two source energies")
        # sigma = 10*E is exact for lin-lin and log-log; the other two laws have their own exact answer
        # on this curve. Every row must match one law, the same one throughout.
        per_row = [
            interpolation_candidates(SYNTHETIC_FE_CURVE, row[energy_header]) for row in interior_rows
        ]
        for law in range(len(per_row[0])):
            if all(
                _is_close(row[total_header], candidates[law])
                for row, candidates in zip(interior_rows, per_row)
            ):
                return f"{len(interior_rows)} interior point(s) match one interpolation law exactly"
        first = interior_rows[0]
        _require_matches_any(first[total_header], per_row[0], "synthetic interpolation")
        raise AssertionError("synthetic interpolation: rows do not follow one interpolation law consistently")

    def _check_no_extrapolation(self) -> str:
        request = CalculationRequest(
            "no-extrapolation", "Oracle below Fe range", {"Fe": 100.0}, 1.0e-5, 1.0e-4, 2
        )
        observation = self._calculate(request)
        table = select_result_table(observation)
        minimum_mev = self.curves["Fe"].minimum_energy_ev / 1_000_000.0
        # Two requested points, so every spacing convention produces the same pair of endpoints, and
        # the span straddles Fe's minimum: the lower endpoint is unsupported, the upper one is not.
        requested = (request.minimum_energy_mev, request.maximum_energy_mev)
        if not requested[0] < minimum_mev <= requested[1]:
            raise AssertionError(
                "probe misconfigured: the requested span no longer straddles Fe's native minimum"
            )
        if table is not None:
            energy_header = _required_header(find_energy_header(table), "energy [MeV]")
            for row in table.rows:
                energy = row[energy_header]
                if energy < minimum_mev:
                    raise AssertionError("output contains silently extrapolated Fe values below the native range")
                # Emitting only the supported endpoint is a defensible partial answer; emitting an
                # energy nobody asked for means the unsupported endpoint was clamped into range
                # rather than refused, which reads to a caller exactly like a genuine result.
                if not any(_is_close(energy, point) for point in requested):
                    raise AssertionError(
                        f"output contains an energy ({energy:.6g} MeV) that was never requested: the "
                        "below-range point was clamped into the native range instead of refused"
                    )
        output = observation.process.combined_output.casefold()
        range_patterns = (
            r"outside.{0,40}(range|bound|energy)",
            r"(range|energy).{0,40}(outside|beyond)",
            r"out of range",
            r"extrapolat",
            r"below.{0,40}(range|minimum|energy)",
            r"energy.{0,40}(range|bound)",
            r"minimum energy",
            r"\bemin\b",
            r"available.{0,30}(data|energy)",
            r"clipp?(ed|ing)",
        )
        clearly_flagged = any(re.search(pattern, output) for pattern in range_patterns)
        if observation.process.return_code == 0 and not clearly_flagged:
            raise AssertionError("out-of-range request succeeded without a clear flag")
        if observation.process.return_code != 0 and not clearly_flagged:
            raise AssertionError("out-of-range request failed, but did not explain the range problem")
        return f"below-range request was refused/flagged (exit {observation.process.return_code})"

    def _check_csv_output(self) -> str:
        table = _require_success_table(self._standard_observation())
        energy_header = _required_header(find_energy_header(table), "neutron energy [MeV]")
        total_header = _required_header(find_total_header(table), "total alloy displacement cross-section")
        contribution_headers = {
            element: _required_header(
                find_contribution_header(table, element), f"{element} contribution"
            )
            for element in ("Fe", "Cr", "Ni")
        }
        cross_section_headers = (*contribution_headers.values(), total_header)
        if any("barn" not in _normalise(header) for header in cross_section_headers):
            raise AssertionError("one or more cross-section columns do not state barn/dpa-barn units")
        expected_fractions = atomic_fractions_from_weight_percent(
            {"Fe": 72.0, "Cr": 18.0, "Ni": 10.0}
        )
        rows = table.rows[: min(3, len(table.rows))]
        if len(rows) < 2:
            raise AssertionError("CSV contains fewer than two numerical rows")
        for index, row in enumerate(rows):
            for element, fraction in expected_fractions.items():
                bands = _bands_over_printed_energy(
                    lambda energy, element=element, fraction=fraction: tuple(
                        fraction * value
                        for value in interpolation_candidates(self.curves[element], energy)
                    ),
                    table,
                    index,
                    energy_header,
                )
                _require_within_bands(
                    row[contribution_headers[element]], bands, f"{element} contribution"
                )
            total_bands = _bands_over_printed_energy(
                lambda energy: alloy_cross_section(self.curves, expected_fractions, energy),
                table,
                index,
                energy_header,
            )
            _require_within_bands(row[total_header], total_bands, "alloy total")
            contribution_sum = sum(row[header] for header in contribution_headers.values())
            _require_close(contribution_sum, row[total_header], "sum of contribution columns")
        return f"required unit-bearing columns and {len(rows)} independently computed rows are correct"

    def _check_plot_generation(self) -> str:
        # TASK.md: `python -m alloydamage calculate examples/304L.yaml` "must produce the calculated
        # alloy cross-section and plot". Judging the plot from the probe run, which retries with
        # --plot until something exits 0, passed socialist cycle 4, whose default command wrote no
        # plot at all; the swarm's own verifier had refused that delivery for exactly this.
        default_run = self._default_command_observation()
        command = "python -m alloydamage calculate examples/304L.yaml"
        if default_run.process.return_code != 0:
            raise AssertionError(
                f"`{command}` exited {default_run.process.return_code}: "
                + _compact(default_run.process.combined_output)
            )
        png_paths = [path for path in default_run.image_paths if path.suffix.casefold() == ".png"]
        if not png_paths:
            raise AssertionError(f"`{command}`, run with no flags as TASK.md gives it, wrote no PNG plot")
        failures = []
        for path in png_paths:
            try:
                width, height = _read_png_dimensions(path)
                if path.stat().st_size < MINIMUM_PNG_BYTES:
                    raise ValueError("file is implausibly small")
                return f"valid PNG {path.name} is {width}x{height}, {path.stat().st_size} bytes"
            except ValueError as error:
                failures.append(f"{path.name}: {error}")
        raise AssertionError("; ".join(failures))

    def _check_log_axis(self) -> str:
        evidence = _find_log_axis_evidence(self.submission_root)
        if evidence is None:
            raise AssertionError(
                "PNG pixels do not encode axis-scale metadata, and no executable plotting call "
                "to xscale('log'), semilogx, or loglog was found in submission source"
            )
        return f"source-level verification (PNG cannot expose scale metadata): {evidence}"

    def _check_provenance(self) -> str:
        standard = self._standard_observation()
        texts = [standard.process.combined_output]
        for table in standard.csv_tables:
            texts.append(table.path.read_text(encoding="utf-8", errors="replace"))
        for path in standard.text_artifacts:
            texts.append(path.read_text(encoding="utf-8", errors="replace"))
        yaml_path = standard.case_directory / "alloy.yaml"
        attempts = (
            ("--provenance",),
            ("provenance",),
            ("calculate", str(yaml_path), "--provenance"),
        )
        for arguments in attempts:
            texts.append(self.runner.run_module_arguments(arguments).combined_output)
        texts.extend(self.runner.read_provenance_artifacts())
        reachable_text = "\n".join(texts).casefold()
        categories = {
            "source": ("iaea", "nuclear data section"),
            "model": ("nrt", "norgett"),
            "dataset": ("dxs-2018", "dxs 2018", "26fe0", "24cr0", "28ni0"),
        }
        missing = [
            category
            for category, tokens in categories.items()
            if not any(token in reachable_text for token in tokens)
        ]
        if missing:
            raise AssertionError(
                "program output/provenance command does not surface: " + ", ".join(missing)
            )
        return "runtime output exposes IAEA source, NRT model, and DXS dataset identity"

    def _check_test_suite(self) -> str:
        """The task asks for a test suite, and until now nothing verified one existed.

        Two arms of the 2026-09-24 trial shipped no tests at all — the task that would have written
        them was abandoned and its files discarded — and a third shipped a suite with seven
        failures, while all three scored well on behaviour alone.
        """
        files = self.runner.discover_test_files()
        if not files:
            raise AssertionError("the submission contains no test files")
        observation = self.runner.run_test_suite()
        output = observation.combined_output
        if re.search(r"\bno tests ran\b|collected 0 items", output, re.IGNORECASE):
            raise AssertionError(f"the submission's test files collect no tests: {_compact(output)}")
        if observation.return_code != 0:
            raise AssertionError(
                f"the submission's own test suite fails (exit {observation.return_code}): {_compact(output)}"
            )
        return f"{len(files)} test file(s) present and the suite passes"

    def _standard_observation(self) -> CalculationObservation:
        return self._calculate(
            CalculationRequest(
                "simplified-304l",
                "Simplified 304L",
                {"Fe": 72.0, "Cr": 18.0, "Ni": 10.0},
                0.118816,
                15.0,
                5,
            )
        )

    def _default_command_observation(self) -> CalculationObservation:
        if DEFAULT_COMMAND_CASE not in self._observations:
            self._observations[DEFAULT_COMMAND_CASE] = self.runner.run_default_command()
        return self._observations[DEFAULT_COMMAND_CASE]

    def _calculate(self, request: CalculationRequest) -> CalculationObservation:
        if request.case_id not in self._observations:
            self._observations[request.case_id] = self.runner.calculate(request)
        return self._observations[request.case_id]


def _require_success_table(observation: CalculationObservation) -> CsvTable:
    if observation.process.return_code != 0:
        raise AssertionError(
            f"calculation exited {observation.process.return_code}: "
            + _compact(observation.process.combined_output)
        )
    table = select_result_table(observation)
    if table is None:
        diagnostic = _describe_csv_candidates(observation.csv_tables)
        raise AssertionError(
            "no numeric result CSV with MeV energy and alloy-total columns was found"
            + diagnostic
        )
    return table


def _describe_csv_candidates(tables: tuple[CsvTable, ...]) -> str:
    if not tables:
        return "; no numeric CSV candidates were emitted"

    descriptions = []
    for table in tables:
        missing_headers = []
        if find_energy_header(table) is None:
            missing_headers.append("a neutron-energy header stating MeV")
        if find_total_header(table) is None:
            missing_headers.append("an alloy-total displacement cross-section header")
        unitless_cross_sections = [
            header
            for header in table.headers
            if ("contribution" in _normalise(header) or header == find_total_header(table))
            and "barn" not in _normalise(header)
        ]
        if unitless_cross_sections:
            missing_headers.append(
                f"barn/dpa-barn units on cross-section headers {unitless_cross_sections!r}"
            )
        missing = ", ".join(missing_headers) or "none"
        descriptions.append(
            f"{table.path.name} headers={list(table.headers)!r}; missing {missing}"
        )
    return "; numeric CSV candidates: " + " | ".join(descriptions)


def _infer_atomic_fractions(
    table: CsvTable,
    curves: dict[str, DamageCurve],
    expected: dict[str, float],
) -> dict[str, float]:
    energy_header = _required_header(find_energy_header(table), "energy [MeV]")
    if not table.rows:
        raise AssertionError("cannot infer atomic fractions from an empty table")
    # Only rows sitting on an energy the source CSVs tabulate directly. Every convention agrees
    # there, so what remains in the ratio is the composition alone. Dividing by an interpolated
    # value instead made this check fail whenever the interpolation check did, and cost a
    # submission with correct composition arithmetic two checks for an unrelated defect.
    node_values = [
        (row, values)
        for row in table.rows
        if (values := _tabulated_values(curves, expected, row[energy_header])) is not None
    ]
    if not node_values:
        raise AssertionError(
            "no emitted row lies on an energy the reference data tabulates, so the atomic "
            "fractions cannot be separated from the interpolation convention"
        )
    inferred: dict[str, float] = {}
    for element, expected_fraction in expected.items():
        contribution_header = _required_header(
            find_contribution_header(table, element), f"{element} contribution"
        )
        ratios = []
        for row, values in node_values[:3]:
            ratio = row[contribution_header] / values[element]
            _require_close(ratio, expected_fraction, f"inferred {element} atomic fraction")
            ratios.append(ratio)
        inferred[element] = sum(ratios) / len(ratios)
    _require_close(sum(inferred.values()), 1.0, "sum of inferred atomic fractions")
    return inferred


def _tabulated_values(
    curves: dict[str, DamageCurve], elements: dict[str, float], energy_mev: float
) -> dict[str, float] | None:
    """Every element's listed cross-section at this energy, or None unless all are usable."""
    values = {
        element: tabulated_cross_section(curves[element], energy_mev) for element in elements
    }
    if any(value is None or value == 0.0 for value in values.values()):
        return None
    return values  # type: ignore[return-value]


def _required_header(header: str | None, description: str) -> str:
    if header is None:
        raise AssertionError(f"missing CSV column: {description}")
    return header


def _require_matches_any(actual: float, expected: tuple[float, ...], label: str) -> None:
    if not any(_is_close(actual, candidate) for candidate in expected):
        candidates = ", ".join(f"{value:.12g}" for value in expected)
        raise AssertionError(f"{label}: got {actual:.12g}, independently expected one of [{candidates}]")


def _bands_over_printed_energy(
    values_at: Callable[[float], tuple[float, ...]],
    table: CsvTable,
    index: int,
    energy_header: str,
) -> tuple[tuple[float, float], ...]:
    """One accepted interval per permitted convention, widened to the printed energy's precision.

    The oracle re-derives its expectation at the energy the submission printed, and a cross-section
    is far more sensitive to that energy than the tolerance allows: a correct program emitting four
    significant figures would fail. Each convention is banded separately so the extra room never
    lets a value from a rejected convention slip between two accepted ones.
    """
    low, high = table.printed_interval(index, energy_header)
    per_convention: list[list[float]] = []
    for energy in dict.fromkeys((low, table.rows[index][energy_header], high)):
        try:
            values = values_at(energy)
        except ValueError:
            continue  # an interval end outside the data's range still leaves the printed centre
        for position, value in enumerate(values):
            while len(per_convention) <= position:
                per_convention.append([])
            per_convention[position].append(value)
    return tuple((min(values), max(values)) for values in per_convention if values)


def _require_within_bands(
    actual: float, bands: tuple[tuple[float, float], ...], label: str
) -> None:
    if not bands:
        raise AssertionError(f"{label}: no reference value could be derived for the printed energy")
    for low, high in bands:
        if low <= actual <= high or _is_close(actual, low) or _is_close(actual, high):
            return
    expected = ", ".join(
        f"{low:.12g}" if low == high else f"{low:.12g}..{high:.12g}" for low, high in bands
    )
    raise AssertionError(f"{label}: got {actual:.12g}, independently expected one of [{expected}]")


def _require_close(actual: float, expected: float, label: str) -> None:
    if not _is_close(actual, expected):
        raise AssertionError(f"{label}: got {actual:.12g}, independently expected {expected:.12g}")


def _is_close(actual: float, expected: float) -> bool:
    return math.isclose(
        actual,
        expected,
        rel_tol=RELATIVE_NUMERIC_TOLERANCE,
        abs_tol=ABSOLUTE_NUMERIC_TOLERANCE,
    )


def _read_png_dimensions(path: Path) -> tuple[int, int]:
    image_data = path.read_bytes()
    if image_data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("invalid PNG signature")
    offset = 8
    dimensions: tuple[int, int] | None = None
    saw_image_data = False
    saw_end = False
    while offset + 12 <= len(image_data):
        length = struct.unpack(">I", image_data[offset : offset + 4])[0]
        chunk_type = image_data[offset + 4 : offset + 8]
        data_start = offset + 8
        data_end = data_start + length
        crc_end = data_end + 4
        if crc_end > len(image_data):
            raise ValueError("truncated PNG chunk")
        chunk_data = image_data[data_start:data_end]
        stored_crc = struct.unpack(">I", image_data[data_end:crc_end])[0]
        calculated_crc = zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF
        if stored_crc != calculated_crc:
            raise ValueError(f"bad CRC in {chunk_type.decode(errors='replace')} chunk")
        if chunk_type == b"IHDR":
            if offset != 8 or length != 13:
                raise ValueError("malformed IHDR chunk")
            dimensions = struct.unpack(">II", chunk_data[:8])
        elif chunk_type == b"IDAT":
            saw_image_data = True
        elif chunk_type == b"IEND":
            saw_end = True
            break
        offset = crc_end
    if dimensions is None or not saw_image_data or not saw_end:
        raise ValueError("PNG lacks IHDR, IDAT, or IEND")
    width, height = dimensions
    if width == 0 or height == 0:
        raise ValueError("PNG has a zero dimension")
    return width, height


def _find_log_axis_evidence(submission_root: Path) -> str | None:
    production_package = submission_root / "alloydamage"
    for source_path in sorted(production_package.rglob("*.py")):
        if any(part.startswith(".") or part in {"__pycache__", "venv"} for part in source_path.parts):
            continue
        try:
            tree = ast.parse(source_path.read_text(encoding="utf-8"))
        except (OSError, SyntaxError, UnicodeDecodeError):
            continue
        log_constants = _find_log_string_constants(tree)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            call_name = _call_name(node.func)
            if call_name in {"semilogx", "loglog"}:
                return f"{source_path.relative_to(submission_root)}:{node.lineno} calls {call_name}()"
            if call_name in {"set_xscale", "xscale"} and _call_uses_log_scale(
                node, log_constants
            ):
                return f"{source_path.relative_to(submission_root)}:{node.lineno} sets x scale to log"
            # Any callee, not just .set(): add_subplot(xscale='log') and subplots(subplot_kw=
            # {'xscale': 'log'}) configure the same axis, and a check that only recognised one
            # idiom graded presentation style rather than behaviour.
            if any(
                keyword.arg == "xscale" and _is_log_expression(keyword.value, log_constants)
                for keyword in node.keywords
            ):
                return f"{source_path.relative_to(submission_root)}:{node.lineno} sets xscale='log'"
            if any(
                _maps_xscale_to_log(argument, log_constants)
                for argument in (*node.args, *(keyword.value for keyword in node.keywords))
            ):
                return f"{source_path.relative_to(submission_root)}:{node.lineno} passes xscale='log'"
    return None


def _call_name(function_node: ast.expr) -> str:
    if isinstance(function_node, ast.Name):
        return function_node.id
    if isinstance(function_node, ast.Attribute):
        return function_node.attr
    return ""


def _find_log_string_constants(tree: ast.AST) -> set[str]:
    constants = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Assign, ast.AnnAssign)):
            continue
        value = node.value
        if not isinstance(value, ast.Constant) or str(value.value).casefold() != "log":
            continue
        targets = node.targets if isinstance(node, ast.Assign) else (node.target,)
        constants.update(target.id for target in targets if isinstance(target, ast.Name))
    return constants


def _call_uses_log_scale(node: ast.Call, log_constants: set[str]) -> bool:
    if node.args and _is_log_expression(node.args[0], log_constants):
        return True
    return any(
        keyword.arg in {"value", "scale"}
        and _is_log_expression(keyword.value, log_constants)
        for keyword in node.keywords
    )


def _maps_xscale_to_log(expression: ast.expr, log_constants: set[str]) -> bool:
    """True for a dict literal carrying xscale='log', as `subplot_kw` and `gridspec_kw` take."""
    if not isinstance(expression, ast.Dict):
        return False
    return any(
        isinstance(key, ast.Constant)
        and str(key.value).casefold() == "xscale"
        and _is_log_expression(value, log_constants)
        for key, value in zip(expression.keys, expression.values)
        if key is not None
    )


def _is_log_expression(expression: ast.expr, log_constants: set[str]) -> bool:
    if isinstance(expression, ast.Constant):
        return str(expression.value).casefold() == "log"
    return isinstance(expression, ast.Name) and expression.id in log_constants


def _contains_clear_warning(output: str) -> bool:
    lowered = output.casefold()
    patterns = (
        r"normali[sz]",
        r"composition.{0,40}(sum|total|percent|100)",
        r"(sum|total).{0,40}composition",
        r"weight percent.{0,40}(sum|total|100)",
        r"invalid composition",
        r"99\.8",
    )
    return any(re.search(pattern, lowered) for pattern in patterns)


def _format_fractions(fractions: dict[str, float]) -> str:
    return ", ".join(f"{element}={fraction:.8f}" for element, fraction in fractions.items())


def _normalise(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.casefold())


def _compact(text: str, limit: int = 500) -> str:
    compact = " ".join(text.split())
    return compact if len(compact) <= limit else compact[:limit] + "..."
