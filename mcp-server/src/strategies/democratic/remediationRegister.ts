// The remediation register the House cites when a delivery is returned: prior findings are named
// by id rather than re-embedded, and only the motions a finding names are reopened.

import type { TaskGraph } from '../../engine/types.js';

const NESTED_FINDING_PACKET = /(?:Finding\s+\d+\s*\[[^\]]+\]:\s*)+/g;

function owningTaskIds(graph: TaskGraph, paths: readonly string[]): string[] {
  return graph.order.filter((taskId) => {
    const declared = graph.nodes[taskId]?.targetGlobs ?? [];
    return paths.some((path) =>
      declared.some((glob) => {
        const needle = glob.replace(/\\/g, '/').toLowerCase();
        const hay = path.replace(/\\/g, '/').toLowerCase();
        return hay === needle || hay.endsWith(`/${needle}`) || needle.endsWith(hay) || hay.includes(needle);
      }),
    );
  });
}

/** Collapse recursive remediation packets to a register line the House can cite by id. */
export function compactRemediationRegister(
  findings: ReadonlyArray<{ summary: string; evidence?: string; affectedTaskIds?: string[] }>,
): string {
  return findings.map((finding, index) => {
    const core = finding.summary.replace(NESTED_FINDING_PACKET, '').split('\n')[0]?.trim() ?? finding.summary;
    const clipped = core.length > 200 ? `${core.slice(0, 197)}...` : core;
    const owners = finding.affectedTaskIds?.length ? ` motions=${finding.affectedTaskIds.join(',')}` : '';
    return `F${index + 1}:${clipped}${owners}`;
  }).join('; ');
}

/**
 * Reopen only the motions that own the cited paths. A finding naming two files must not return
 * the whole Order Paper.
 */
export function scopedRemediationTargets(
  graph: TaskGraph,
  findings: ReadonlyArray<{ summary: string; evidence?: string; affectedTaskIds?: string[] }>,
): string[] {
  const named = [...new Set(findings.flatMap((finding) => finding.affectedTaskIds ?? []))]
    .filter((id) => graph.nodes[id]);
  if (named.length > 0) return named;

  const haystack = findings.map((finding) => `${finding.summary}\n${finding.evidence ?? ''}`).join('\n');
  const pathHints = haystack.match(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g) ?? [];
  const fromPaths = owningTaskIds(graph, pathHints);
  if (fromPaths.length > 0) return fromPaths;

  return [...graph.order];
}
