#!/usr/bin/env python3
"""Build a static HTML dashboard from benchmark/results/*/<strategy>/metrics.json.

Reads every completed benchmark run and strategy directory, extracts the
comparison fields, embeds them as JSON into dashboard_template.html, and
writes the result to benchmark/results/dashboard.html.

Usage: python3 benchmark/generate_dashboard.py
"""

from __future__ import annotations

import json
from pathlib import Path

BENCHMARK_DIR = Path(__file__).resolve().parent
RESULTS_DIR = BENCHMARK_DIR / "results"
TEMPLATE_PATH = BENCHMARK_DIR / "dashboard_template.html"
OUTPUT_PATH = RESULTS_DIR / "dashboard.html"

STRATEGY_ORDER = ["democratic", "socialist", "capitalist", "managerial", "single_agent"]


def parse_run_folder_name(name: str) -> tuple[str, str]:
    """Split a `<timestamp>__<label>` results folder name into (timestamp, label)."""
    if "__" in name:
        ts, label = name.split("__", 1)
        return ts, label
    return name, name


def test_summary(test_runs: list[dict] | None) -> dict:
    runs = test_runs or []
    ran = [r for r in runs if r.get("ran")]
    passed = [r for r in ran if r.get("passed")]
    return {
        "ran": len(ran),
        "passed": len(passed),
        "lastPassed": ran[-1]["passed"] if ran else None,
    }


def oracle_summary(oracle_results: list[dict] | None) -> dict | None:
    if oracle_results is None:
        return None
    passed = sum(1 for r in oracle_results if r.get("passed"))
    return {"passed": passed, "total": len(oracle_results)}


def load_run(run_dir: Path) -> list[dict]:
    ts, label = parse_run_folder_name(run_dir.name)
    summary_path = run_dir / "summary.json"
    args = {}
    if summary_path.exists():
        summary = json.loads(summary_path.read_text())
        args = summary.get("args", {})
        label = summary.get("label", label)

    rows = []
    for strategy_dir in sorted(run_dir.iterdir()):
        metrics_path = strategy_dir / "metrics.json"
        if not metrics_path.exists():
            continue
        m = json.loads(metrics_path.read_text())
        tokens = m.get("tokensUsed", {}) or {}
        rows.append(
            {
                "runFolder": run_dir.name,
                "runTimestamp": ts,
                "runLabel": label,
                "budgetUsdArg": args.get("budgetUsd"),
                "trialIndex": args.get("trialIndex"),
                "strategy": m.get("strategy", strategy_dir.name),
                "status": m.get("status"),
                "costUsd": m.get("costUsd"),
                "budgetUsd": m.get("budgetUsd"),
                "tokensPrompt": tokens.get("prompt", 0),
                "tokensCompletion": tokens.get("completion", 0),
                "workerCalls": m.get("workerCalls"),
                "wallClockMs": m.get("wallClockMs"),
                "filesChanged": m.get("filesChanged"),
                "taskErrors": m.get("taskErrors"),
                "autoApprovalsCount": len(m.get("autoApprovals") or []),
                "tests": test_summary(m.get("testRuns")),
                "coveragePercent": (m.get("coverage") or {}).get("percent"),
                "oracle": oracle_summary(m.get("oracleResults")),
                "fallbackCount": m.get("fallbackCount"),
                "retryCount": m.get("retryCount"),
                "timeoutCount": m.get("timeoutCount"),
                "providersUsed": m.get("providersUsed"),
            }
        )
    return rows


def main() -> None:
    if not RESULTS_DIR.exists():
        raise SystemExit(f"no results directory at {RESULTS_DIR}")

    rows: list[dict] = []
    for run_dir in sorted(RESULTS_DIR.iterdir()):
        if not run_dir.is_dir():
            continue
        rows.extend(load_run(run_dir))

    if not rows:
        raise SystemExit(f"no metrics.json files found under {RESULTS_DIR}")

    rows.sort(key=lambda r: (r["runTimestamp"], STRATEGY_ORDER.index(r["strategy"]) if r["strategy"] in STRATEGY_ORDER else 99))

    data = {
        "strategyOrder": STRATEGY_ORDER,
        "generatedFrom": str(RESULTS_DIR.relative_to(BENCHMARK_DIR.parent)),
        "rows": rows,
    }

    template = TEMPLATE_PATH.read_text()
    html = template.replace("__BENCHMARK_DATA__", json.dumps(data))
    OUTPUT_PATH.write_text(html)
    print(f"wrote {OUTPUT_PATH} ({len(rows)} rows across {len(set(r['runFolder'] for r in rows))} runs)")


if __name__ == "__main__":
    main()
