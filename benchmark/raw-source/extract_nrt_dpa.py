import re
import sys
import csv
import math

ENDF_NUM = re.compile(r'([+-]?\d\.\d+)([+-]\d+)')

def parse_endf_float(tok: str) -> float:
    tok = tok.strip()
    if not tok:
        return None
    m = ENDF_NUM.match(tok)
    if not m:
        return float(tok)
    mantissa, exp = m.groups()
    return float(mantissa) * (10.0 ** int(exp))


def parse_line_fields(line: str):
    # ENDF-6 fixed format: six 11-character fields, then MAT(4)/MF(2)/MT(3)/line(5) trailer
    fields = []
    for i in range(6):
        chunk = line[i * 11:(i + 1) * 11]
        if not chunk.strip():
            continue
        fields.append(parse_endf_float(chunk))
    return fields


def extract_mt(path: str, mt_target: int):
    with open(path, 'r', encoding='latin-1') as f:
        lines = f.readlines()

    # trailer columns: MAT (66-70), MF (70-72), MT (72-75)
    section_lines = []
    for line in lines:
        if len(line) < 75:
            continue
        try:
            mf = int(line[70:72])
            mt = int(line[72:75])
        except ValueError:
            continue
        if mf == 3 and mt == mt_target:
            section_lines.append(line)

    if not section_lines:
        raise ValueError(f'MF=3 MT={mt_target} not found')

    # section_lines[0] = CONT record (ZA, AWR, ...)
    # section_lines[1] = TAB1 header (QM, QI, LR, ..., N1=num interp regions, N2=num points)
    header = parse_line_fields(section_lines[1])
    n_regions = int(header[4])
    n_points = int(header[5])

    # Each line holds up to 3 NBT/INT pairs (6 fields of 11 chars), not one region per line.
    n_region_lines = math.ceil(n_regions / 3)
    data_start = 2 + n_region_lines  # skip the NBT/INT interpolation-region line(s)
    values = []
    for line in section_lines[data_start:]:
        values.extend(parse_line_fields(line))

    pairs = []
    for i in range(0, len(values) - 1, 2):
        pairs.append((values[i], values[i + 1]))

    if len(pairs) != n_points:
        sys.stderr.write(f'WARNING: expected {n_points} points, parsed {len(pairs)}\n')

    return pairs


def downsample_logspaced(pairs, max_points):
    """Selects actual source grid points nearest a log-spaced target grid, rather than
    inventing new values — keeps every retained (E, xs) pair traceable to the original
    evaluated file while shrinking 170k+ rows to a benchmark-sized dataset."""
    if len(pairs) <= max_points:
        return pairs
    import math
    e0, e1 = pairs[0][0], pairs[-1][0]
    log0, log1 = math.log10(e0), math.log10(e1)
    targets = [10 ** (log0 + (log1 - log0) * i / (max_points - 1)) for i in range(max_points)]
    energies = [p[0] for p in pairs]
    result = []
    seen = set()
    j = 0
    n = len(pairs)
    for t in targets:
        while j + 1 < n and energies[j + 1] <= t:
            j += 1
        # nearest of energies[j] / energies[j+1] to t
        best = j
        if j + 1 < n and abs(energies[j + 1] - t) < abs(energies[j] - t):
            best = j + 1
        if best not in seen:
            seen.add(best)
            result.append(pairs[best])
    result.sort(key=lambda p: p[0])
    return result


def main():
    src = sys.argv[1]
    out_csv = sys.argv[2]
    mt_target = int(sys.argv[3]) if len(sys.argv) > 3 else 901
    emin_ev = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
    emax_ev = float(sys.argv[5]) if len(sys.argv) > 5 else 3.0e7
    max_points = int(sys.argv[6]) if len(sys.argv) > 6 else 400

    pairs = extract_mt(src, mt_target)
    filtered = [(e, y) for e, y in pairs if emin_ev <= e <= emax_ev]

    # keep one point just outside the window on each side (if available) so downstream
    # interpolation never needs to extrapolate right at the requested boundary
    below = [p for p in pairs if p[0] < emin_ev]
    above = [p for p in pairs if p[0] > emax_ev]
    core = downsample_logspaced(filtered, max_points)
    if below:
        core = [below[-1]] + core
    if above:
        core = core + [above[0]]
    filtered = core

    with open(out_csv, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['energy_eV', 'displacement_xs_barn'])
        for e, y in filtered:
            w.writerow([f'{e:.6g}', f'{y:.6g}'])

    print(f'{src}: MT={mt_target} total_points={len(pairs)} written={len(filtered)} -> {out_csv}')


if __name__ == '__main__':
    main()
