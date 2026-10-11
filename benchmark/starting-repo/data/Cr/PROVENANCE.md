Element: Cr (chromium, Z=24)
Quantity: neutron atomic displacement cross-section
Model: NRT-dpa (Norgett-Robinson-Torrens), MT=901, effective displacement threshold energy Ed = 40.00 eV
Source: IAEA Nuclear Data Section (IAEA-NDS), CRP "Primary Radiation Damage Cross Sections"
Dataset/library: DXS-2018, evaluation "24Cr0", file 24-Cr-0
Evaluators: A.Yu. Konobeyev, U. Fischer, S.P. Simakov (INR, KIT), EVAL-MAR18
Original data origins: ENDF/B-VIII.0, TENDL-2017
Format of original file: ENDF-6 (MF=3, MT=901)
Original source URL: https://www-nds.iaea.org/public/download-endf/DXS/Displacement_XS/DXS.(2018)/Neutron_irradiation/Files/ENDFBVIII/ENDF_format/24Cr0.dxs
Retrieved: 2026-08-08
Energy units (original file): eV
Cross-section units (original file): barn
Original file: 157029 (E, sigma_d) points

Extracted/derived file: Cr_dpa_nrt.csv
Extraction method: benchmark/raw-source/extract_nrt_dpa.py parses the MF=3 MT=901 TAB1 record
  out of the ENDF-6 file and keeps every value as-parsed from the source evaluation (no
  interpolation or invented values). To keep the file benchmark-sized, points are downsampled
  to a log-spaced subset (~400 points) by selecting the nearest actual source grid point to each
  log-spaced target energy — every retained pair is a genuine evaluated point, not a synthetic
  one. One extra point on each side of the [100 eV, 30 MeV] extraction window is kept so
  interpolation within the benchmark's default 1 keV-20 MeV plotting range never needs to
  extrapolate.
Columns: energy_eV, displacement_xs_barn

## Integrity (SHA-256)

Raw IAEA source (24Cr0.dxs): af28a48f260b4b2bca7565bd4b948ddd921c9f6b44263f6c39b620c188d4ff1b
Extracted/derived CSV (Cr_dpa_nrt.csv): 96c996c93d949f12e9c6d3c2009e1c9118bc57c3443e569ffda4db9ffc5678fa

Verify with: python3 benchmark/verify_provenance.py
