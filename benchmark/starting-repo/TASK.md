# Coding Swarm Benchmark — Alloy Neutron Damage Cross-Section Calculator

## Objective

Develop a small Python engineering application called `alloydamage` that calculates and plots the neutron displacement-damage cross-section of an alloy as a function of neutron energy.

The program must use displacement-damage cross-section data obtained from, or traceable to, the IAEA Nuclear Data Section.

The same technical problem will be given independently to several AI coding swarms operating under different organisational philosophies.

The purpose of the benchmark is to compare how effectively each swarm designs, implements, verifies and documents the same engineering calculation.

---

# 1. Engineering calculation

For an alloy containing \(n\) elements, calculate the effective displacement-damage cross-section:

\[
\sigma_{d,\mathrm{alloy}}(E)
=
\sum_{i=1}^{n}
x_i \sigma_{d,i}(E)
\]

where:

- \(\sigma_{d,\mathrm{alloy}}(E)\) = effective alloy displacement cross-section at neutron energy \(E\);
- \(\sigma_{d,i}(E)\) = displacement cross-section of constituent element \(i\);
- \(x_i\) = atomic fraction of constituent \(i\);
- \(\sum x_i = 1\).

Cross-section units shall be displacement-barns unless the source data specify otherwise.

The program must clearly distinguish **mass fraction** from **atomic fraction**.

---

# 2. Alloy input

The user shall be able to enter an alloy composition in weight percent.

Example:

```yaml
name: Simplified 304L
composition:
  Fe: 72.0
  Cr: 18.0
  Ni: 10.0
units: weight_percent
```

The program must:

1. check that the composition is valid;
2. normalise the composition if necessary;
3. convert weight fractions to atomic fractions using atomic masses;
4. report both weight and atomic fractions.

The weight-to-atomic conversion must be documented mathematically.

---

# 3. Nuclear data

Use neutron displacement-damage cross-section data from the IAEA Nuclear Data Section.

**This data is already supplied in the repository.** `data/<element>/<element>_dpa_nrt.csv`
contains pre-fetched IAEA-NDS displacement-damage cross-sections for Fe, Cr and Ni, with
`data/<element>/PROVENANCE.md` recording the source of each. Read these files; do not create,
regenerate or substitute them, and do not fetch nuclear data from the internet.

A supplied file may list the same energy on consecutive rows. Where such rows agree on the
cross-section, treat them as one point: collapse them when loading and carry on. Where they
disagree, the file is inconsistent and the program must say so rather than pick one. Collapsing a
duplicate in memory is not modifying the data, and the files on disk stay untouched either way.

For the initial benchmark, support at least:

```text
Fe
Cr
Ni
```

These are sufficient to calculate a simplified Fe-Cr-Ni stainless steel.

Additional elements may be supported if suitable IAEA data are available.

For every nuclear-data file, record:

- element;
- data source;
- library or dataset name;
- displacement model, e.g. NRT-dpa;
- energy units;
- cross-section units;
- date or version where available.

Do not silently substitute invented or approximate cross-sections for missing data.

If an alloy contains an unsupported constituent, the application must identify it clearly.

---

# 4. Energy grid

Different elemental datasets may use different neutron-energy grids.

The software must therefore construct a common energy grid and interpolate the elemental cross-sections onto it.

Use an appropriate interpolation method and document the choice.

The program must not extrapolate beyond the available nuclear-data range unless explicitly requested.

Default neutron-energy plotting range:

```text
1 keV to 20 MeV
```

Use a logarithmic neutron-energy axis.

---

# 5. Required outputs

For a supplied alloy, calculate:

1. weight fraction of every constituent;
2. atomic fraction of every constituent;
3. elemental displacement cross-section versus neutron energy;
4. effective alloy displacement cross-section versus neutron energy;
5. contribution of each element to the alloy damage cross-section.

Produce a table containing:

```text
Neutron energy
Fe contribution
Cr contribution
Ni contribution
Total alloy displacement cross-section
```

Export the result as CSV. The header row is read by an independent evaluator, not just by a
human, so state units in the header text itself rather than only in a caption or the README —
e.g.:

```text
Neutron energy [MeV],Fe contribution [barn],Cr contribution [barn],Ni contribution [barn],Total alloy displacement cross-section [barn]
```

Every cross-section column (each element's contribution and the alloy total) must state its unit
(`barn` or `dpa-barn`) in that column's own header, and the energy column must state `MeV` in its
own header.

The line above is an illustration of the format, not a string to match character for character.
`barn` and `dpa-barn` are equally acceptable, and the two spellings are interchangeable anywhere a
cross-section unit appears — CSV headers, plot axis labels, elsewhere. Pick one and use it
consistently. Do not restate that example line as a literal expected value in a task description,
an acceptance criterion or a test assertion: a task that demands `[barn]` exactly, while the
module it depends on emits `[dpa-barn]`, is a contradiction no implementer can satisfy, and the
requirement is the unit being stated, not which of the two spellings states it.

---

# 6. Required plot

Produce a publication-quality graph showing:

```text
Displacement cross-section [dpa-barn]
        |
        |
        |           Alloy total
        |          /---------
        |     Fe  /
        |    ----
        |  Cr
        | ----
        | Ni
        |---
        +--------------------------------
             Neutron energy [MeV]
```

Requirements:

- logarithmic neutron-energy axis;
- clear units;
- legend;
- title containing the alloy name;
- elemental curves shown separately;
- total alloy curve clearly distinguishable;
- sensible axis limits;
- PNG output;
- optional SVG output.

---

# 7. Command-line interface

Provide a CLI similar to:

```bash
python -m alloydamage calculate alloy.yaml
```

This is a `python -m <package>` invocation, not `python -m <package>.<module>` — running it requires
an `alloydamage/__main__.py` that dispatches to your CLI logic (a `cli.py` with the actual argument
parsing is fine, but `__main__.py` must exist and call into it). `python -m alloydamage` alone, with
no `__main__.py`, fails with "'alloydamage' is a package and cannot be directly executed" — this is
section 15's literal, must-pass final command, not just illustrative.

Optional arguments should include:

```bash
--emin
--emax
--points
--output
--plot
--provenance
```

`--provenance` (or a `provenance` subcommand) should print the nuclear-data provenance described in
section 13 — this is the concrete mechanism section 13 asks for; without a flag or subcommand that
does this, "inspectable" and "accessible to the user" have no way to be satisfied.

Example:

```bash
python -m alloydamage calculate examples/304L.yaml \
    --emin 1e-3 \
    --emax 20 \
    --output results/304L
```

Energy arguments are in MeV.

---

# 8. Verification

The program must contain automated tests.

At minimum test:

### Test 1 — Pure element

For:

```yaml
composition:
  Fe: 100
```

the resulting alloy curve must equal the Fe displacement cross-section.

### Test 2 — Equal atomic mixture

For an artificial alloy containing:

```text
50 atomic % Fe
50 atomic % Ni
```

verify:

\[
\sigma_{\mathrm{alloy}}
=
0.5\sigma_{\mathrm{Fe}}
+
0.5\sigma_{\mathrm{Ni}}
\]

at several neutron energies.

### Test 3 — Weight-to-atomic conversion

Independently verify conversion of a known Fe-Cr-Ni composition from weight fraction to atomic fraction.

### Test 4 — Normalisation

A composition entered as:

```text
Fe = 71.5
Cr = 18.2
Ni = 10.1
```

must either be normalised correctly or produce a clear warning.

### Test 5 — Unsupported element

An alloy containing an element for which no damage data are available must not silently ignore that element.

### Test 6 — Interpolation

Verify the interpolation routine against a simple artificial dataset with a known answer.

---

# 9. Example engineering case

Calculate a simplified 304L stainless steel:

```text
Fe = 72 wt%
Cr = 18 wt%
Ni = 10 wt%
```

Calculate and plot:

\[
\sigma_{d,304L}(E)
\]

from approximately:

```text
1 keV to 20 MeV
```

Report:

- converted atomic fractions;
- elemental displacement cross-sections;
- alloy displacement cross-section;
- dominant damage-producing element as a function of neutron energy.

Do not assume the element with the greatest weight fraction necessarily dominates at every neutron energy.

---

# 10. Optional engineering extension

If a neutron spectrum is supplied as:

\[
\phi(E)
\]

calculate the spectrum-averaged displacement cross-section:

\[
\bar{\sigma}_d
=
\frac
{\int \sigma_d(E)\phi(E)\,dE}
{\int \phi(E)\,dE}
\]

and, where absolute neutron flux is available, calculate the displacement rate:

\[
\dot D
=
\int
\sigma_d(E)\phi(E)\,dE
\]

with appropriate conversion of barns to square centimetres.

This extension is optional for the first release.

---

# 11. Code-quality requirements

The implementation should be simple rather than over-engineered.

Prefer approximately:

```text
alloydamage/
    __init__.py
    composition.py
    nuclear_data.py
    damage.py
    plotting.py
    cli.py

tests/

data/

examples/
    304L.yaml

README.md
```

Requirements:

- Python 3.11 or later;
- type hints;
- NumPy;
- Matplotlib;
- PyYAML or equivalent;
- pytest;
- no database;
- no web application;
- no GUI required;
- no unnecessary framework.

---

# 12. Documentation

The README must explain:

1. what displacement-damage cross-section means;
2. the source of the nuclear data;
3. the mixture rule;
4. weight-to-atomic fraction conversion;
5. interpolation methodology;
6. assumptions and limitations;
7. how to run the program;
8. how to add another element.

The README must clearly state that an alloy-averaged displacement cross-section is an engineering approximation and that radiation-damage response depends on the adopted damage model and nuclear-data evaluation.

---

# 13. Provenance requirement

The program must make nuclear-data provenance inspectable. This means relaying the specific
identifying fields already present in each `data/<element>/PROVENANCE.md` — not restating them in
generic terms — because a review checks for exactly those identifiers in program output: the
source (e.g. "IAEA Nuclear Data Section"), the model (e.g. "NRT-dpa"), and the dataset/evaluation
identifier as PROVENANCE.md states it (e.g. "DXS-2018" and the evaluation code, such as "26Fe0" for
iron) — a paraphrase like "Dataset: DXS" on its own is not specific enough to satisfy this.

Parse the actual key names `PROVENANCE.md` uses, which are not all single words — notably
`Dataset/library:`, not `Dataset:`. A parser that only recognises `Dataset:` will silently produce
an empty field against the real files, which all use `Dataset/library:`
(`data/Fe/PROVENANCE.md`, `data/Cr/PROVENANCE.md`, `data/Ni/PROVENANCE.md`).

For example, for iron:

```text
Element: Fe
Quantity: neutron displacement cross-section
Model: NRT-dpa
Source: IAEA Nuclear Data Section
Dataset/library: DXS-2018, evaluation 26Fe0
Units: displacement-barn
```

This illustrates the four identity fields a review looks for (element, model, source, dataset) —
it does not name a literal, fixed set of dict keys to reproduce. In particular, the real
`PROVENANCE.md` files do not have a single `Units:` line: they separately state
`Energy units (original file):` and `Cross-section units (original file):`. Do not write an
acceptance criterion or test that demands a `parse_provenance` return value have keys named
exactly `Energy units` or `Cross-section units` (or any other key not shown above) — key names
beyond the four identity fields must be read from, and matched against, the real files, not
invented or guessed from this illustration.

The source information must not exist only in developer comments.

It should be accessible to the user.

---

# 14. Benchmark restrictions

All coding swarms receive:

- the same prompt;
- the same nuclear-data files;
- the same starting repository;
- the same model access;
- the same tool access;
- the same token budget.

Do not give one swarm additional engineering guidance.

The nuclear-data files should preferably be downloaded once and supplied locally to every swarm rather than allowing each swarm to retrieve different versions from the internet.

---

# 15. Deliverables

The completed repository must contain:

1. working Python application;
2. automated tests;
3. Fe, Cr and Ni nuclear-data files;
4. example 304L input;
5. calculated CSV result;
6. damage cross-section plot;
7. README;
8. data-source/provenance information.

The command:

```bash
python -m pytest
```

must pass.

The command:

```bash
python -m alloydamage calculate examples/304L.yaml
```

must produce the calculated alloy cross-section and plot.

---

# 16. Evaluation criteria

Score each swarm using:

| Criterion | Weight |
|---|---:|
| Numerical correctness | 30% |
| Correct nuclear-data handling | 20% |
| Verification/tests | 15% |
| Engineering clarity | 10% |
| Code simplicity and maintainability | 10% |
| Plot and outputs | 5% |
| Nuclear-data provenance | 5% |
| Compute/token efficiency | 5% |

Record separately:

- total tokens used;
- tool calls;
- number of files created;
- test failures encountered;
- duplicated work between agents;
- final test coverage;
- wall-clock completion time if available.

Do **not** award points merely because a swarm followed its political or organisational philosophy more visibly.

The benchmark is intended to determine whether the different organisational structures produce better or worse engineering software.