"""Independent loading and reference mathematics for the oracle."""

from __future__ import annotations

import csv
import hashlib
import math
from bisect import bisect_left
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


# CIAAW/IUPAC standard atomic weights, https://ciaaw.org/atomic-weights.htm
# (table consulted 2026-08-24): Cr 51.9961(6), Fe 55.845(2), Ni 58.6934(4).
ATOMIC_WEIGHTS_G_PER_MOL = {
    "Fe": 55.845,
    "Cr": 51.9961,
    "Ni": 58.6934,
}
# Digests published in each evaluator-owned PROVENANCE.md file.
REFERENCE_CSV_SHA256 = {
    "Fe": "9d22099d26cd32115e278fe445c265f596495e14dfff1911c736b114599c86a5",
    "Cr": "96c996c93d949f12e9c6d3c2009e1c9118bc57c3443e569ffda4db9ffc5678fa",
    "Ni": "405d52dfb69b35131da96ddcdd5132b36814fdc2e8a5089ea909357a03a91dfe",
}
EV_PER_MEV = 1_000_000.0


@dataclass(frozen=True)
class DataPoint:
    energy_ev: float
    cross_section_barn: float


@dataclass(frozen=True)
class DamageCurve:
    element: str
    points: tuple[DataPoint, ...]

    @property
    def minimum_energy_ev(self) -> float:
        return self.points[0].energy_ev

    @property
    def maximum_energy_ev(self) -> float:
        return self.points[-1].energy_ev


def load_damage_curve(csv_path: Path, element: str) -> DamageCurve:
    """Load a source CSV while rejecting malformed or ambiguous reference data."""
    with csv_path.open(newline="", encoding="utf-8") as source_file:
        reader = csv.DictReader(source_file)
        required_columns = {"energy_eV", "displacement_xs_barn"}
        if not reader.fieldnames or not required_columns.issubset(reader.fieldnames):
            raise ValueError(f"{csv_path} does not have the required columns")
        raw_points = tuple(_read_point(row, csv_path) for row in reader)
    return DamageCurve(element, _validated_unique_points(raw_points, csv_path))


def load_reference_curves(data_root: Path) -> dict[str, DamageCurve]:
    curves = {}
    for element in ATOMIC_WEIGHTS_G_PER_MOL:
        csv_path = data_root / element / f"{element}_dpa_nrt.csv"
        _verify_reference_digest(csv_path, REFERENCE_CSV_SHA256[element])
        curves[element] = load_damage_curve(csv_path, element)
    return curves


def atomic_fractions_from_weight_percent(
    composition: Mapping[str, float],
) -> dict[str, float]:
    """Apply x_i = (w_i/A_i) / sum_j(w_j/A_j)."""
    if not composition:
        raise ValueError("composition cannot be empty")
    mole_amounts: dict[str, float] = {}
    for element, weight_percent in composition.items():
        if element not in ATOMIC_WEIGHTS_G_PER_MOL:
            raise ValueError(f"no atomic weight for {element}")
        if not math.isfinite(weight_percent) or weight_percent < 0.0:
            raise ValueError(f"invalid weight percent for {element}")
        mole_amounts[element] = weight_percent / ATOMIC_WEIGHTS_G_PER_MOL[element]
    total_moles = sum(mole_amounts.values())
    if total_moles <= 0.0:
        raise ValueError("composition must contain a positive amount")
    return {element: amount / total_moles for element, amount in mole_amounts.items()}


def interpolate_linear(curve: DamageCurve, energy_ev: float) -> float:
    lower, upper = _bracket(curve, energy_ev)
    if lower.energy_ev == upper.energy_ev:
        return lower.cross_section_barn
    interval_fraction = (energy_ev - lower.energy_ev) / (
        upper.energy_ev - lower.energy_ev
    )
    return lower.cross_section_barn + interval_fraction * (
        upper.cross_section_barn - lower.cross_section_barn
    )


def interpolate_log_log(curve: DamageCurve, energy_ev: float) -> float:
    lower, upper = _bracket(curve, energy_ev)
    if lower.energy_ev == upper.energy_ev:
        return lower.cross_section_barn
    if lower.cross_section_barn <= 0.0 or upper.cross_section_barn <= 0.0:
        raise ValueError("log-log interpolation requires positive cross-sections")
    log_fraction = math.log(energy_ev / lower.energy_ev) / math.log(
        upper.energy_ev / lower.energy_ev
    )
    return math.exp(
        math.log(lower.cross_section_barn)
        + log_fraction
        * math.log(upper.cross_section_barn / lower.cross_section_barn)
    )


def tabulated_cross_section(curve: DamageCurve, energy_mev: float) -> float | None:
    """The value the source CSV lists at this energy, or None when it is not a tabulated point.

    Every interpolation convention returns the listed value at a point the data tabulates, so a
    quantity derived here carries no trace of the convention a submission chose.
    """
    energy_ev = energy_mev * EV_PER_MEV
    index = bisect_left([point.energy_ev for point in curve.points], energy_ev)
    for candidate in curve.points[max(index - 1, 0) : index + 1]:
        if math.isclose(candidate.energy_ev, energy_ev, rel_tol=1.0e-6, abs_tol=0.0):
            return candidate.cross_section_barn
    return None


def interpolate_linear_in_log_energy(curve: DamageCurve, energy_ev: float) -> float:
    lower, upper = _bracket(curve, energy_ev)
    if lower.energy_ev == upper.energy_ev:
        return lower.cross_section_barn
    log_fraction = math.log(energy_ev / lower.energy_ev) / math.log(
        upper.energy_ev / lower.energy_ev
    )
    return lower.cross_section_barn + log_fraction * (
        upper.cross_section_barn - lower.cross_section_barn
    )


def interpolate_log_in_cross_section(curve: DamageCurve, energy_ev: float) -> float:
    lower, upper = _bracket(curve, energy_ev)
    if lower.energy_ev == upper.energy_ev:
        return lower.cross_section_barn
    if lower.cross_section_barn <= 0.0 or upper.cross_section_barn <= 0.0:
        raise ValueError("log-linear interpolation requires positive cross-sections")
    interval_fraction = (energy_ev - lower.energy_ev) / (upper.energy_ev - lower.energy_ev)
    return math.exp(
        math.log(lower.cross_section_barn)
        + interval_fraction
        * math.log(upper.cross_section_barn / lower.cross_section_barn)
    )


# The four ENDF-6 interpolation laws, INT=2..5, in a fixed order so a position means the same law for
# every element. The supplied CSVs are a ~400-point subset of a ~170k-point evaluation and record no
# law, and on that subset every one of these misses the full evaluation by a similar 1-2% median, far
# more than they differ from each other. None is privileged, so each is an accepted convention.
INTERPOLATION_LAWS = (
    interpolate_linear,
    interpolate_log_log,
    interpolate_linear_in_log_energy,
    interpolate_log_in_cross_section,
)


def interpolation_candidates(curve: DamageCurve, energy_mev: float) -> tuple[float, ...]:
    """One value per law in INTERPOLATION_LAWS; a law undefined here repeats the linear value."""
    energy_ev = energy_mev * EV_PER_MEV
    linear_value = interpolate_linear(curve, energy_ev)
    values = []
    for law in INTERPOLATION_LAWS:
        try:
            values.append(law(curve, energy_ev))
        except ValueError:
            values.append(linear_value)
    return tuple(values)


def alloy_cross_section(
    curves: Mapping[str, DamageCurve],
    atomic_fractions: Mapping[str, float],
    energy_mev: float,
) -> tuple[float, ...]:
    """Return independent totals for each allowed interpolation convention."""
    per_element = {
        element: interpolation_candidates(curves[element], energy_mev)
        for element in atomic_fractions
    }
    return tuple(
        sum(fraction * per_element[element][law] for element, fraction in atomic_fractions.items())
        for law in range(len(INTERPOLATION_LAWS))
    )


def _read_point(row: dict[str, str], csv_path: Path) -> DataPoint:
    try:
        energy_ev = float(row["energy_eV"])
        cross_section_barn = float(row["displacement_xs_barn"])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(f"invalid numeric row in {csv_path}: {row}") from error
    if not math.isfinite(energy_ev) or energy_ev <= 0.0:
        raise ValueError(f"non-positive or non-finite energy in {csv_path}")
    if not math.isfinite(cross_section_barn) or cross_section_barn < 0.0:
        raise ValueError(f"negative or non-finite cross-section in {csv_path}")
    return DataPoint(energy_ev, cross_section_barn)


def _validated_unique_points(
    raw_points: tuple[DataPoint, ...], csv_path: Path
) -> tuple[DataPoint, ...]:
    if len(raw_points) < 2:
        raise ValueError(f"{csv_path} must contain at least two points")
    unique_points: list[DataPoint] = []
    for point in raw_points:
        if unique_points and point.energy_ev < unique_points[-1].energy_ev:
            raise ValueError(f"energies are not sorted in {csv_path}")
        if unique_points and point.energy_ev == unique_points[-1].energy_ev:
            if point.cross_section_barn != unique_points[-1].cross_section_barn:
                raise ValueError(f"conflicting duplicate energy in {csv_path}")
            continue
        unique_points.append(point)
    return tuple(unique_points)


def _bracket(curve: DamageCurve, energy_ev: float) -> tuple[DataPoint, DataPoint]:
    if not math.isfinite(energy_ev):
        raise ValueError("energy must be finite")
    if energy_ev < curve.minimum_energy_ev or energy_ev > curve.maximum_energy_ev:
        raise ValueError(
            f"{energy_ev:g} eV is outside {curve.element}'s native range "
            f"[{curve.minimum_energy_ev:g}, {curve.maximum_energy_ev:g}] eV"
        )
    energies = [point.energy_ev for point in curve.points]
    upper_index = bisect_left(energies, energy_ev)
    if upper_index == len(curve.points):
        return curve.points[-1], curve.points[-1]
    if curve.points[upper_index].energy_ev == energy_ev:
        return curve.points[upper_index], curve.points[upper_index]
    return curve.points[upper_index - 1], curve.points[upper_index]


def _verify_reference_digest(csv_path: Path, expected_digest: str) -> None:
    actual_digest = hashlib.sha256(csv_path.read_bytes()).hexdigest()
    if actual_digest != expected_digest:
        raise ValueError(
            f"reference integrity failure for {csv_path}: "
            f"got SHA-256 {actual_digest}, expected {expected_digest}"
        )
