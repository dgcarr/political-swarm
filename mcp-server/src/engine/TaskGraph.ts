import type { TaskAttempt, TaskGraph, TaskNode } from './types.js';

export function emptyGraph(): TaskGraph {
  return { nodes: {}, order: [] };
}

export function addNode(graph: TaskGraph, node: TaskNode): void {
  graph.nodes[node.id] = node;
  graph.order.push(node.id);
}

export function latestVerdict(node: TaskNode): TaskAttempt['outcome'] | undefined {
  return node.attempts.at(-1)?.outcome;
}

export function recordAttempt(node: TaskNode, attempt: Omit<TaskAttempt, 'attempt'>): TaskAttempt {
  const entry: TaskAttempt = { ...attempt, attempt: node.attempts.length + 1 };
  node.attempts.push(entry);
  return entry;
}

/** Queued nodes whose dependencies have latest approval verdicts. */
export function readyNodes(graph: TaskGraph): TaskNode[] {
  return graph.order
    .map((id) => graph.nodes[id])
    .filter((node) => {
      return (
        node.phase === 'queued' &&
        node.dependsOn.every((dependencyId) => {
          const dependency = graph.nodes[dependencyId];
          if (dependency === undefined) return false;
          if (latestVerdict(dependency) === 'approved') return true;
          // Released by releaseOrphanedDependents: the dependency was abandoned and is never
          // coming, and the node carries the record of what it did not get.
          return node.abandonedDependencies?.includes(dependencyId) === true;
        })
      );
    });
}

/**
 * Frees queued nodes that are waiting only on dependencies the doctrine has abandoned.
 *
 * An abandoned dependency never becomes approved, so its dependents wait forever: one failed task
 * takes its whole subtree with it, which is how every benchmark run has ended. Democratic settled
 * four of eight tasks and delivered nothing, the other four never attempted once.
 *
 * Marks each released node with the dependencies it did not get, so what it builds is reported
 * against their absence rather than as though they had passed. Only nodes whose remaining blockers
 * are ALL abandoned are released — anything still waiting on live work keeps waiting.
 *
 * Returns what it released, so the caller can record it; an empty result means nothing was freed
 * and the run really has run out of work.
 */
export function releaseOrphanedDependents(graph: TaskGraph): Array<{ taskId: string; missing: string[] }> {
  const released: Array<{ taskId: string; missing: string[] }> = [];
  for (const id of graph.order) {
    const node = graph.nodes[id];
    if (node.phase !== 'queued' || node.dependsOn.length === 0) continue;

    const unmet = node.dependsOn.filter((depId) => latestVerdict(graph.nodes[depId]) !== 'approved');
    if (unmet.length === 0) continue;
    const allAbandoned = unmet.every((depId) => graph.nodes[depId]?.phase === 'abandoned');
    if (!allAbandoned) continue;

    node.abandonedDependencies = unmet;
    released.push({ taskId: id, missing: unmet });
  }
  return released;
}

/**
 * Every node has reached a terminal phase. Says nothing about whether the work succeeded — a
 * graph where every motion was rejected is just as "disposed" as one where every motion passed.
 */
export function allDisposed(graph: TaskGraph): boolean {
  return graph.order.every((id) => {
    const phase = graph.nodes[id].phase;
    return phase === 'settled' || phase === 'abandoned';
  });
}

/**
 * Every node was approved. This — not allDisposed — is the precondition for offering a delivery
 * packet. Section 5 forbids "representing partial work as accepted", so a graph carrying a
 * rejected node terminates incomplete instead of proceeding to the acceptance barriers.
 */
/**
 * Attempts that count against a task's rework budget.
 *
 * A provider timeout says nothing about the work, so spending the budget on it abandons tasks for
 * the network's reasons rather than the doctrine's. Transient attempts stay on the record — they
 * are real cost and real elapsed time — but only judged attempts move a task towards abandonment.
 */
export function countedAttempts(node: TaskNode): number {
  return node.attempts.filter((attempt) => !attempt.transient && !attempt.withoutDependency).length;
}

/** Transient attempts in a row at the end, which bound a permanently unreachable provider. */
export function trailingTransientAttempts(node: TaskNode): number {
  let count = 0;
  for (let index = node.attempts.length - 1; index >= 0 && node.attempts[index].transient; index -= 1) count += 1;
  return count;
}

export function allApproved(graph: TaskGraph): boolean {
  return graph.order.length > 0 && graph.order.every((id) => latestVerdict(graph.nodes[id]) === 'approved');
}

export function rejectedNodeIds(graph: TaskGraph): string[] {
  return graph.order.filter((id) => graph.nodes[id].phase === 'abandoned');
}

export function approvedNodeIds(graph: TaskGraph): string[] {
  return graph.order.filter((id) => latestVerdict(graph.nodes[id]) === 'approved');
}

export function hasBlockedNodes(graph: TaskGraph): boolean {
  return graph.order.some((id) => graph.nodes[id].phase === 'blocked');
}

export function progressSummary(graph: TaskGraph): { total: number; approved: number; rejected: number; pending: number } {
  const nodes = graph.order.map((id) => graph.nodes[id]);
  return {
    total: nodes.length,
    approved: nodes.filter((node) => latestVerdict(node) === 'approved').length,
    rejected: nodes.filter((node) => node.phase === 'abandoned').length,
    pending: nodes.filter((node) => latestVerdict(node) !== 'approved' && node.phase !== 'abandoned').length,
  };
}
