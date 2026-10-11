#!/usr/bin/env python3
"""Turn one completed benchmark arm's ledger + task graph into a graphify graph.json,
then render it with graphify's own `export html` — the same interactive viewer graphify
uses for a codebase, repurposed to show what a doctrine's run actually looked like.

Reads `<run-dir>/state.json` (the TaskGraph: tasks and their dependsOn edges) and
`<run-dir>/ledger.jsonl` (every institutional event: worker calls, votes, motions,
committee findings, sovereign decisions, ...) and emits one node-link graph where task
nodes are wired by dependsOn, and every ledger event that names an actor (personaId,
assigneeId, a committee finding's own personaId, ...) and a task (taskId, motionId, ...)
becomes an edge between them labeled with that event's own type — so a democratic run's
graph reads as a web of motion/vote/speaker edges, a capitalist run's as a market network
of firm/bid/contract edges, and so on, mirroring each doctrine's own vocabulary.

Usage:
    python3 benchmark/generate_run_graph.py benchmark/results/<timestamp>__<label>/<strategy>
    python3 benchmark/generate_run_graph.py benchmark/results/<timestamp>__<label>/<strategy> --out-root graphify-out-runs

Requires the `graphify` CLI on PATH (the same one used for this repo's own code graph) to
render graph.html; the graph.json is written either way.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

BENCHMARK_DIR = Path(__file__).resolve().parent
REPO_ROOT = BENCHMARK_DIR.parent
DEFAULT_OUT_ROOT = REPO_ROOT / "graphify-out-runs"

# Ledger `data` fields that name an actor (a persona, office-holder, or committee member).
ACTOR_KEYS = ("personaId", "assigneeId", "source", "appellant", "primeCoordinator", "speaker", "ceremonialHead")
ACTOR_LIST_KEYS = ("representatives", "cabinet")
# Ledger `data` fields that name a task. motionId is a doctrine's own name for a taskId.
TASK_KEYS = ("taskId", "motionId")
TASK_LIST_KEYS = ("ownerTaskIds",)


def parse_run_dir(run_dir: Path) -> tuple[str, str, str]:
    """(<timestamp>__<label>, strategy) from .../results/<timestamp>__<label>/<strategy>."""
    strategy = run_dir.name
    results_folder = run_dir.parent.name
    return results_folder, strategy, f"{results_folder}__{strategy}"


def extract_ids(data: dict[str, Any], keys: tuple[str, ...]) -> list[str]:
    return [data[k] for k in keys if isinstance(data.get(k), str) and data[k]]


def extract_list_ids(data: dict[str, Any], keys: tuple[str, ...]) -> list[str]:
    ids: list[str] = []
    for k in keys:
        v = data.get(k)
        if isinstance(v, list):
            ids.extend(item for item in v if isinstance(item, str) and item)
    return ids


def extract_nested_actor_ids(data: dict[str, Any]) -> list[str]:
    """One level deep: a list-of-dict field (e.g. committee_inquiry's `findings`) may carry
    its own personaId/source per entry that the top-level ACTOR_KEYS scan never sees."""
    ids: list[str] = []
    for v in data.values():
        if not isinstance(v, list):
            continue
        for item in v:
            if isinstance(item, dict):
                ids.extend(extract_ids(item, ACTOR_KEYS))
    return ids


class GraphBuilder:
    def __init__(self, strategy: str, ledger_source: str, state_source: str) -> None:
        self.strategy = strategy
        self.ledger_source = ledger_source
        self.state_source = state_source
        self.nodes: dict[str, dict[str, Any]] = {}
        self.links: list[dict[str, Any]] = []
        self.task_community: dict[str, int] = {}
        self.actor_home_community: dict[str, int] = {}
        self.next_community = 0
        # A star node for actor-only events (e.g. offices_constituted) that name no task.
        self.institution_community = -1

    def _community_for_task(self, task_id: str) -> int:
        if task_id not in self.task_community:
            self.task_community[task_id] = self.next_community
            self.next_community += 1
        return self.task_community[task_id]

    def add_task_node(self, task_id: str, title: str, phase: str, risk_class: str | None) -> None:
        community = self._community_for_task(task_id)
        self.nodes[f"task_{task_id}"] = {
            "id": f"task_{task_id}",
            "label": title,
            "community": community,
            "community_name": title,
            "file_type": "task",
            "source_file": self.state_source,
            "source_location": task_id,
            "phase": phase,
            **({"risk_class": risk_class} if risk_class else {}),
        }

    def add_depends_on(self, task_id: str, depends_on_id: str) -> None:
        if f"task_{depends_on_id}" not in self.nodes:
            return
        self.links.append(self._link(f"task_{depends_on_id}", f"task_{task_id}", "depends_on", self.state_source))

    def _actor_node_id(self, actor: str) -> str:
        return f"actor_{actor}"

    def _ensure_actor_node(self, actor: str, home_community: int) -> None:
        node_id = self._actor_node_id(actor)
        if node_id in self.nodes:
            return
        if actor not in self.actor_home_community:
            self.actor_home_community[actor] = home_community
        community = self.actor_home_community[actor]
        self.nodes[node_id] = {
            "id": node_id,
            "label": actor,
            "community": community,
            "community_name": (
                self.nodes[f"task_{self._task_for_community(community)}"]["label"]
                if community in self.task_community.values()
                else f"{self.strategy} institutional offices"
            ),
            "file_type": "actor",
            "source_file": self.ledger_source,
            "source_location": actor,
        }

    def _task_for_community(self, community: int) -> str:
        for task_id, c in self.task_community.items():
            if c == community:
                return task_id
        return ""

    def _link(self, source: str, target: str, relation: str, source_file: str) -> dict[str, Any]:
        return {
            "source": source,
            "target": target,
            "relation": relation,
            "confidence": "OBSERVED",
            "confidence_score": 1.0,
            "context": "ledger_event",
            "source_file": source_file,
            "weight": 1.0,
        }

    def add_ledger_event(self, event_type: str, data: dict[str, Any]) -> None:
        actors = list(dict.fromkeys(extract_ids(data, ACTOR_KEYS) + extract_list_ids(data, ACTOR_LIST_KEYS) + extract_nested_actor_ids(data)))
        tasks = list(dict.fromkeys(extract_ids(data, TASK_KEYS) + extract_list_ids(data, TASK_LIST_KEYS)))
        tasks = [t for t in tasks if f"task_{t}" in self.nodes]

        if not actors:
            return

        if tasks:
            for task_id in tasks:
                community = self._community_for_task(task_id)
                for actor in actors:
                    self._ensure_actor_node(actor, community)
                    self.links.append(self._link(self._actor_node_id(actor), f"task_{task_id}", event_type, self.ledger_source))
            return

        # A lone actor with no task (the common case: worker_call carries personaId+role but
        # no taskId — it's by far the largest single event type, 36% of a typical run) gets
        # wired to a shared per-role hub instead of dropped, so the busiest signal in the
        # ledger isn't silently invisible. A role hub is deliberately reused across every
        # event of that role rather than made per-call, so it groups without exploding node
        # count the way one hub per worker_call instance would.
        if len(actors) == 1:
            role = data.get("role")
            if not isinstance(role, str) or not role:
                return
            hub_id = f"role_{role}"
            if hub_id not in self.nodes:
                self.nodes[hub_id] = {
                    "id": hub_id,
                    "label": f"role: {role}",
                    "community": self.institution_community,
                    "community_name": f"{self.strategy} institutional offices",
                    "file_type": "role",
                    "source_file": self.ledger_source,
                    "source_location": role,
                }
            self._ensure_actor_node(actors[0], self.institution_community)
            self.links.append(self._link(self._actor_node_id(actors[0]), hub_id, event_type, self.ledger_source))
            return

        # No task named and 2+ actors (e.g. offices_constituted): star the actors around one
        # synthetic event node instead of guessing a task to blame it on.
        hub_id = f"event_{event_type}_{len(self.nodes)}"
        self.nodes[hub_id] = {
            "id": hub_id,
            "label": event_type.replace("_", " "),
            "community": self.institution_community,
            "community_name": f"{self.strategy} institutional offices",
            "file_type": "event",
            "source_file": self.ledger_source,
            "source_location": event_type,
        }
        for actor in actors:
            self._ensure_actor_node(actor, self.institution_community)
            self.links.append(self._link(self._actor_node_id(actor), hub_id, event_type, self.ledger_source))

    def to_graph_json(self) -> dict[str, Any]:
        return {
            "directed": True,
            "multigraph": True,
            "graph": {"hyperedges": []},
            "nodes": list(self.nodes.values()),
            "links": self.links,
        }


def build_graph(run_dir: Path) -> dict[str, Any]:
    results_folder, strategy, _ = parse_run_dir(run_dir)
    state_source = f"{results_folder}/{strategy}/state.json"
    ledger_source = f"{results_folder}/{strategy}/ledger.jsonl"

    state = json.loads((run_dir / "state.json").read_text())
    task_nodes: dict[str, dict[str, Any]] = state.get("graph", {}).get("nodes", {})

    builder = GraphBuilder(strategy, ledger_source, state_source)
    for task_id, node in task_nodes.items():
        builder.add_task_node(task_id, node.get("title", task_id), node.get("phase", "unknown"), node.get("riskClass"))
    for task_id, node in task_nodes.items():
        for dep in node.get("dependsOn", []):
            builder.add_depends_on(task_id, dep)

    ledger_path = run_dir / "ledger.jsonl"
    if ledger_path.exists():
        with ledger_path.open() as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                entry = json.loads(line)
                builder.add_ledger_event(entry["type"], entry.get("data", {}))

    return builder.to_graph_json()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("run_dir", type=Path, help="benchmark/results/<timestamp>__<label>/<strategy>")
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT, help=f"default: {DEFAULT_OUT_ROOT}")
    parser.add_argument("--no-html", action="store_true", help="write graph.json only, skip graphify export html")
    args = parser.parse_args()

    run_dir = args.run_dir.resolve()
    if not (run_dir / "state.json").exists():
        parser.error(f"{run_dir} has no state.json — pass a single arm's directory, e.g. .../<label>/democratic")

    _, _, out_name = parse_run_dir(run_dir)
    out_dir = args.out_root / out_name
    out_dir.mkdir(parents=True, exist_ok=True)
    graph_path = out_dir / "graph.json"

    graph = build_graph(run_dir)
    graph_path.write_text(json.dumps(graph, indent=2))
    print(f"wrote {graph_path} ({len(graph['nodes'])} nodes, {len(graph['links'])} links)")

    if args.no_html:
        return
    result = subprocess.run(["graphify", "export", "html", "--graph", str(graph_path)], capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stdout, file=sys.stdout)
        print(result.stderr, file=sys.stderr)
        sys.exit(result.returncode)
    print(f"open {out_dir / 'graph.html'}")


if __name__ == "__main__":
    main()
