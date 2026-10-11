"""Black-box execution and output parsing for a built submission."""

from __future__ import annotations

import csv
import hashlib
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path


PROCESS_TIMEOUT_SECONDS = 90


@dataclass(frozen=True)
class CalculationRequest:
    case_id: str
    alloy_name: str
    composition: dict[str, float]
    minimum_energy_mev: float
    maximum_energy_mev: float
    point_count: int


@dataclass(frozen=True)
class ProcessObservation:
    command: tuple[str, ...]
    return_code: int
    stdout: str
    stderr: str

    @property
    def combined_output(self) -> str:
        return f"{self.stdout}\n{self.stderr}".strip()


@dataclass(frozen=True)
class CsvTable:
    path: Path
    headers: tuple[str, ...]
    rows: tuple[dict[str, float], ...]
    printed: tuple[dict[str, str], ...] = ()

    def printed_interval(self, index: int, header: str) -> tuple[float, float]:
        """The range of true values consistent with what this cell actually printed.

        A submission that writes 0.3983 has disclosed its energy only to half a unit of the last
        decimal place. Demanding a cross-section accurate to more than that judges it on digits it
        never emitted, so a numerically correct program could fail for its output formatting alone.
        """
        value = self.rows[index][header]
        text = self.printed[index].get(header, "") if index < len(self.printed) else ""
        half_ulp = _half_unit_in_last_place(text)
        return (value, value) if half_ulp is None else (value - half_ulp, value + half_ulp)


@dataclass(frozen=True)
class CalculationObservation:
    process: ProcessObservation
    case_directory: Path
    csv_tables: tuple[CsvTable, ...]
    image_paths: tuple[Path, ...]
    text_artifacts: tuple[Path, ...]


DEFAULT_COMMAND_ARGUMENTS = ("calculate", "examples/304L.yaml")


class SubmissionRunner:
    def __init__(self, submission_root: Path, scratch_root: Path) -> None:
        self.submission_root = submission_root.resolve()
        self.scratch_root = scratch_root

    def calculate(self, request: CalculationRequest) -> CalculationObservation:
        return self._calculate_from_root(request, self.submission_root)

    def calculate_with_synthetic_fe(
        self, request: CalculationRequest
    ) -> CalculationObservation:
        clone_root = self.scratch_root / "synthetic-submission"
        _copy_submission_for_synthetic_test(self.submission_root, clone_root)
        synthetic_files = tuple(clone_root.rglob("Fe_dpa_nrt.csv"))
        if not synthetic_files:
            raise RuntimeError("could not locate Fe_dpa_nrt.csv in the isolated clone")
        synthetic_csv = (
            "energy_eV,displacement_xs_barn\n"
            "1000000,10\n"
            "100000000,1000\n"
        )
        for csv_path in synthetic_files:
            _substitute_data_file(clone_root, csv_path, synthetic_csv)
        return self._calculate_from_root(request, clone_root)

    def run_default_command(self) -> CalculationObservation:
        """TASK.md's literal command, `python -m alloydamage calculate examples/304L.yaml`, with no
        flags, from a copy of the submission's root, as a user would type it. TASK.md says it "must
        produce the calculated alloy cross-section and plot", so what it creates or rewrites is
        reported, wherever it lands."""
        clone_root = self.scratch_root / "default-command"
        _copy_submission_for_synthetic_test(self.submission_root, clone_root)
        before = {path: path.stat().st_mtime_ns for path in clone_root.rglob("*") if path.is_file()}
        command = (sys.executable, "-m", "alloydamage", *DEFAULT_COMMAND_ARGUMENTS)
        process = _run_process(command, clone_root, clone_root)
        written = tuple(
            path
            for path in sorted(clone_root.rglob("*"))
            if path.is_file() and before.get(path) != path.stat().st_mtime_ns
        )
        images = tuple(path for path in written if path.suffix.lower() in {".png", ".svg"})
        return CalculationObservation(process, clone_root, (), images, ())

    def discover_test_files(self) -> tuple[Path, ...]:
        ignored = {".git", ".venv", "venv", "__pycache__", "node_modules", ".pytest_cache"}
        return tuple(
            path
            for pattern in ("test_*.py", "*_test.py")
            for path in sorted(self.submission_root.rglob(pattern))
            if not ignored.intersection(path.parts)
        )

    def run_test_suite(self) -> ProcessObservation:
        """Run the submission's own tests, from its own root, the way its author would."""
        command = (sys.executable, "-m", "pytest", "-q")
        return _run_process(command, self.submission_root, self.submission_root)

    def run_module_arguments(self, arguments: tuple[str, ...]) -> ProcessObservation:
        case_directory = self.scratch_root / "provenance"
        case_directory.mkdir(parents=True, exist_ok=True)
        command = (sys.executable, "-m", "alloydamage", *arguments)
        return _run_process(command, self.submission_root, case_directory)

    def read_provenance_artifacts(self) -> tuple[str, ...]:
        case_directory = self.scratch_root / "provenance"
        if not case_directory.is_dir():
            return ()
        texts = []
        for path in case_directory.rglob("*"):
            if (
                path.is_file()
                and path.suffix.casefold() in {"", ".csv", ".json", ".md", ".txt", ".yaml", ".yml"}
                and path.stat().st_size < 1_000_000
            ):
                texts.append(path.read_text(encoding="utf-8", errors="replace"))
        return tuple(texts)

    def _calculate_from_root(
        self, request: CalculationRequest, source_root: Path
    ) -> CalculationObservation:
        case_directory = self.scratch_root / request.case_id
        if case_directory.exists():
            shutil.rmtree(case_directory)
        case_directory.mkdir(parents=True)
        source_data = source_root / "data"
        if source_data.is_dir():
            (case_directory / "data").symlink_to(source_data, target_is_directory=True)
        yaml_path = case_directory / "alloy.yaml"
        yaml_path.write_text(_render_alloy_yaml(request), encoding="utf-8")
        output_prefix = case_directory / "result"
        common_arguments = (
            "calculate",
            str(yaml_path),
            "--emin",
            f"{request.minimum_energy_mev:.16g}",
            "--emax",
            f"{request.maximum_energy_mev:.16g}",
            "--points",
            str(request.point_count),
            "--output",
            str(output_prefix),
        )
        plot_forms = (
            ("--plot", str(case_directory / "result.png")),
            ("--plot",),
            (),
        )
        observations = []
        for plot_form in plot_forms:
            command = (sys.executable, "-m", "alloydamage", *common_arguments, *plot_form)
            observation = _run_process(command, source_root, case_directory)
            observations.append(observation)
            if observation.return_code == 0:
                break
        process = observations[-1]
        # Extensionless files too: TASK.md's `--output results/304L` does not say a ".csv" suffix is
        # appended, and an arm that wrote its correct CSV to exactly that path had six checks blocked.
        csv_tables = tuple(
            table
            for path in sorted(case_directory.rglob("*"))
            if path.is_file()
            and path.suffix.casefold() in {".csv", ""}
            and path.stat().st_size < 1_000_000
            and (table := parse_numeric_csv(path)) is not None
        )
        image_paths = tuple(
            path
            for path in sorted(case_directory.rglob("*"))
            if path.suffix.lower() in {".png", ".svg"} and path.is_file()
        )
        excluded = {yaml_path, *(table.path for table in csv_tables), *image_paths}
        text_artifacts = tuple(
            path
            for path in sorted(case_directory.rglob("*"))
            if path.is_file() and path not in excluded and path.stat().st_size < 1_000_000
        )
        return CalculationObservation(
            process, case_directory, csv_tables, image_paths, text_artifacts
        )


def parse_numeric_csv(csv_path: Path) -> CsvTable | None:
    lines = csv_path.read_text(encoding="utf-8-sig", errors="replace").splitlines()
    header_index = next(
        (
            index
            for index, line in enumerate(lines)
            if "," in line and "energy" in line.casefold()
        ),
        None,
    )
    if header_index is None:
        return None
    reader = csv.DictReader(lines[header_index:])
    if not reader.fieldnames:
        return None
    header_pairs = tuple(
        (header, header.strip()) for header in reader.fieldnames if header is not None
    )
    headers = tuple(clean_header for _raw_header, clean_header in header_pairs)
    numeric_rows: list[dict[str, float]] = []
    printed_rows: list[dict[str, str]] = []
    for row in reader:
        if not row or all(
            not value.strip() for value in row.values() if isinstance(value, str)
        ):
            continue
        cells = {
            clean_header: row[raw_header]
            for raw_header, clean_header in header_pairs
            if row.get(raw_header) is not None
        }
        try:
            numeric_rows.append({header: float(text) for header, text in cells.items()})
        except (TypeError, ValueError):
            continue
        printed_rows.append(cells)
    if not numeric_rows:
        return None
    return CsvTable(csv_path, headers, tuple(numeric_rows), tuple(printed_rows))


def _substitute_data_file(clone_root: Path, csv_path: Path, content: str) -> None:
    """Replace a data file in the clone, and any digest of it the clone records.

    A submission that verifies its inputs by checksum — which this evaluator does itself, in
    `_verify_reference_digest` — would otherwise refuse the substituted curve and fail a check
    about interpolation accuracy. Only the old digest's exact text is rewritten, so nothing else
    the submission records is disturbed.
    """
    previous_digest = hashlib.sha256(csv_path.read_bytes()).hexdigest()
    csv_path.write_text(content, encoding="utf-8")
    replacement = hashlib.sha256(content.encode("utf-8")).hexdigest()
    for path in clone_root.rglob("*"):
        if not path.is_file() or path == csv_path or path.stat().st_size > 1_000_000:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if previous_digest in text:
            path.write_text(text.replace(previous_digest, replacement), encoding="utf-8")


def _half_unit_in_last_place(text: str) -> float | None:
    """Half the value of the last digit printed, or None when that cannot be read off.

    Returned only for a genuinely fractional literal: an integer discloses nothing useful here
    (an energy written "15" would admit a half-MeV window), so it is treated as exact instead.
    """
    try:
        exponent = Decimal(text.strip()).as_tuple().exponent
    except (InvalidOperation, AttributeError, ValueError):
        return None
    if not isinstance(exponent, int) or exponent >= 0:
        return None
    return float(Decimal(1).scaleb(exponent)) / 2.0


def find_energy_header(table: CsvTable) -> str | None:
    return next(
        (
            header
            for header in table.headers
            if "energy" in _normalise_header(header) and "mev" in _normalise_header(header)
        ),
        None,
    )


def find_total_header(table: CsvTable) -> str | None:
    for header in table.headers:
        normalised = _normalise_header(header)
        if "total" in normalised and (
            "alloy" in normalised or "crosssection" in normalised or "displacement" in normalised
        ):
            return header
    return None


def find_contribution_header(table: CsvTable, element: str) -> str | None:
    element_key = element.casefold()
    for header in table.headers:
        tokens = re.findall(r"[a-z]+", header.casefold())
        if element_key in tokens and "contribution" in tokens:
            return header
    return None


def select_result_table(observation: CalculationObservation) -> CsvTable | None:
    return next(
        (
            table
            for table in observation.csv_tables
            if find_energy_header(table) and find_total_header(table)
        ),
        None,
    )


def _render_alloy_yaml(request: CalculationRequest) -> str:
    composition_lines = "\n".join(
        f"  {element}: {amount:.16g}"
        for element, amount in request.composition.items()
    )
    return (
        f"name: {request.alloy_name}\n"
        "composition:\n"
        f"{composition_lines}\n"
        "units: weight_percent\n"
    )


def _run_process(
    command: tuple[str, ...], source_root: Path, case_directory: Path
) -> ProcessObservation:
    environment = os.environ.copy()
    current_python_path = environment.get("PYTHONPATH")
    path_entries = [str(source_root)]
    if current_python_path:
        path_entries.append(current_python_path)
    environment["PYTHONPATH"] = os.pathsep.join(path_entries)
    try:
        completed = subprocess.run(
            command,
            cwd=case_directory,
            env=environment,
            capture_output=True,
            text=True,
            timeout=PROCESS_TIMEOUT_SECONDS,
            check=False,
        )
        return ProcessObservation(
            command, completed.returncode, completed.stdout, completed.stderr
        )
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout.decode() if isinstance(error.stdout, bytes) else error.stdout or ""
        stderr = error.stderr.decode() if isinstance(error.stderr, bytes) else error.stderr or ""
        return ProcessObservation(command, 124, stdout, f"{stderr}\nprocess timed out")


def _copy_submission_for_synthetic_test(source_root: Path, clone_root: Path) -> None:
    if clone_root.exists():
        shutil.rmtree(clone_root)
    ignored_names = {
        ".git",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".venv",
        "__pycache__",
        "benchmark",
        "mcp-server",
        "node_modules",
        "venv",
    }
    shutil.copytree(
        source_root,
        clone_root,
        ignore=lambda _directory, names: ignored_names.intersection(names),
        symlinks=False,
    )


def _normalise_header(header: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", header.casefold())
