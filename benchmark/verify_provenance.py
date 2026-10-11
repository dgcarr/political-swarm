#!/usr/bin/env python3

import hashlib
from pathlib import Path
import re


BENCHMARK_DIR = Path(__file__).resolve().parent
RAW_SOURCE_DIR = BENCHMARK_DIR / "raw-source"
DERIVED_DATA_DIR = BENCHMARK_DIR / "starting-repo" / "data"
ELEMENT_FILES = {
    "Fe": ("26Fe0.dxs", "Fe_dpa_nrt.csv"),
    "Cr": ("24Cr0.dxs", "Cr_dpa_nrt.csv"),
    "Ni": ("28Ni0.dxs", "Ni_dpa_nrt.csv"),
}
HASH_CHUNK_SIZE = 1024 * 1024
INTEGRITY_SECTION_PATTERN = re.compile(
    r"^## Integrity \(SHA-256\)\n\n"
    r"Raw IAEA source \((?P<raw_filename>[^)\n]+)\): "
    r"(?P<raw_hash>[0-9a-f]{64})\n"
    r"Extracted/derived CSV \((?P<derived_filename>[^)\n]+)\): "
    r"(?P<derived_hash>[0-9a-f]{64})\n\n"
    r"Verify with: python3 benchmark/verify_provenance\.py$",
    re.MULTILINE,
)


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as file:
        for chunk in iter(lambda: file.read(HASH_CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_recorded_hashes(provenance_path: Path) -> dict[str, str]:
    provenance_text = provenance_path.read_text(encoding="utf-8")
    sections = list(INTEGRITY_SECTION_PATTERN.finditer(provenance_text))
    if len(sections) != 1:
        raise ValueError(f"expected one integrity section, found {len(sections)}")

    section = sections[0]
    return {
        section.group("raw_filename"): section.group("raw_hash"),
        section.group("derived_filename"): section.group("derived_hash"),
    }


def main() -> int:
    matched_files = 0
    total_files = sum(len(filenames) for filenames in ELEMENT_FILES.values())

    for element, (raw_filename, derived_filename) in ELEMENT_FILES.items():
        provenance_path = DERIVED_DATA_DIR / element / "PROVENANCE.md"
        files_to_verify = (
            ("raw", RAW_SOURCE_DIR / raw_filename),
            ("derived", DERIVED_DATA_DIR / element / derived_filename),
        )

        try:
            recorded_hashes = read_recorded_hashes(provenance_path)
        except (OSError, UnicodeError, ValueError) as error:
            for file_kind, file_path in files_to_verify:
                print(
                    f"FAIL {element} {file_kind} ({file_path.name}): "
                    f"cannot parse {provenance_path.name}: {error}"
                )
            continue

        for file_kind, file_path in files_to_verify:
            recorded_hash = recorded_hashes.get(file_path.name)
            try:
                computed_hash = sha256_file(file_path)
            except OSError as error:
                print(f"FAIL {element} {file_kind} ({file_path.name}): {error}")
                continue

            if recorded_hash == computed_hash:
                print(f"OK   {element} {file_kind} ({file_path.name}): {computed_hash}")
                matched_files += 1
            elif recorded_hash is None:
                print(
                    f"FAIL {element} {file_kind} ({file_path.name}): "
                    "recorded hash missing"
                )
            else:
                print(
                    f"FAIL {element} {file_kind} ({file_path.name}): "
                    f"recorded {recorded_hash}, computed {computed_hash}"
                )

    if matched_files == total_files:
        print(f"SUMMARY: PASS ({matched_files}/{total_files} files matched)")
        return 0

    mismatched_files = total_files - matched_files
    print(
        f"SUMMARY: FAIL ({matched_files}/{total_files} files matched; "
        f"{mismatched_files} failed)"
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
