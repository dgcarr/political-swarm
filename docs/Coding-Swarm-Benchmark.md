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

Export the result as CSV.

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

Optional arguments should include:

```bash
--emin
--emax
--points
--output
--plot
```

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

The program must make nuclear-data provenance inspectable.

For example:

```text
Element: Fe
Quantity: neutron displacement cross-section
Model: NRT-dpa
Source: IAEA Nuclear Data Section
Dataset: DXS
Units: displacement-barn
```

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

Any generic guidance the harness gives (planner rules on ownership and test files, implementer
reminders about entry points, data ranges, file formats and test independence) is given to every swarm in the same
words, and a test enforces it; `benchmark/README.md` ("What every arm receives") lists it. Failed
oracle checks are fed back to the swarm that failed them as remediation findings, equally for all,
naming the check but withholding its expected values and probe inputs.
Escalations a doctrine reserves for its human owner are decided in the benchmark by one sovereign,
the user's selected Claude model, with the same prompt for every swarm; its rationale is recorded
and passed back to the engine for retry feedback. Each swarm gets the same fixed allowance of
budget and time extensions.

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