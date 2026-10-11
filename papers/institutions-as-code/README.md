# Institutions as Code

Working paper (Political Analysis / APSA computational-methods style).

## Compile

Requires a TeX Live installation with `pdflatex`, `bibtex`, `natbib`, `booktabs`, `tikz`, `hyperref`, `geometry`, and `microtype`.

```bash
cd papers/institutions-as-code
pdflatex -interaction=nonstopmode main
bibtex main
pdflatex -interaction=nonstopmode main
pdflatex -interaction=nonstopmode main
```

The PDF is `main.pdf`. Do not commit auxiliary files (`*.aux`, `*.bbl`, `*.blg`, `*.log`, `*.out`).

## Sources

Claims about implemented institutions are checked against `docs/Orchestrator-Contract.md` and the strategy modules under `mcp-server/src/strategies/`. Essay-only mechanisms are listed in Appendix A, not treated as runtime behaviour. Benchmark numbers are from the 2026-09-21 five-arm sweep documented in the repository `README.md`.
