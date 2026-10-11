import type { RemediationFinding } from './packets.js';
import { clipCheckOutput } from '../util/checkOutput.js';

/** Per finding. Enough for a pytest error and its summary line; several findings may share a note. */
const MAX_EVIDENCE_CHARS = 1500;

/**
 * Closes every non-empty note. A finding is one reviewer's reading of the delivery, and the task
 * statement outranks it: socialist cycle 4's integration council called --plot "a no-op because
 * the plot is always written", the repair made plotting depend on the flag, and the next cycle
 * found the default command no longer produced the plot the task requires. The code had been right.
 */
export const REMEDIATION_PRECEDENCE =
  'A finding never overrides the task statement or your acceptance criteria. If acting on one would ' +
  'break a stated requirement, keep the requirement, leave that part as it is, and say why in your rationale.';

/**
 * The remediation directive a reopened task's implementer reads.
 *
 * Every doctrine used to build this from `finding.summary` alone, which says THAT something failed
 * ("Required final check unit failed on the partial combined tree", "Task tests was blocked by
 * defects owned by: core-modules") while the WHY — the failing check output, the blocked task's
 * last rationale — sat in `finding.evidence` and was dropped. A reopened task then regenerated the
 * same defect. Shared so no doctrine is told more than another.
 *
 * With a taskId, only findings naming that task (or naming no task) are included, so a reopened
 * task is not handed every other task's defects.
 */
export function remediationNote(findings: readonly RemediationFinding[], taskId?: string): string {
  const relevant = taskId
    ? findings.filter((finding) => !finding.affectedTaskIds?.length || finding.affectedTaskIds.includes(taskId))
    : findings;
  if (relevant.length === 0) return '';
  const notes = relevant
    .map((finding, index) => {
      const summary = finding.summary.trim();
      const evidence = finding.evidence?.trim();
      const body = evidence && evidence !== summary
        ? `${summary}\nEvidence:\n${clipCheckOutput(evidence, MAX_EVIDENCE_CHARS)}`
        : summary;
      return `${index + 1}. [${finding.severity}] ${body}`;
    })
    .join('\n\n');
  return `${notes}\n\n${REMEDIATION_PRECEDENCE}`;
}
