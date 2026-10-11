import { describe, expect, it } from 'vitest';
import { buildCommonsReport, toDeliveryNotes, type CommonsReportInput } from './commons.js';
import type { Finding } from '../../engine/packets.js';

function finding(over: Partial<Finding>): Finding {
  return {
    id: 'f1',
    source: 'reviewer',
    summary: 'A summary.',
    evidenceRefs: [],
    disposition: 'unresolved',
    dispositionRationale: 'Because.',
    ...over,
  } as Finding;
}

const input = (over: Partial<CommonsReportInput> = {}): CommonsReportInput => ({
  findings: [],
  finalChecks: [],
  contributions: [],
  failedTaskIds: [],
  publishedTaskIds: [],
  planningDefects: [],
  productiveDuty: { convener: 'backend-1', met: true, contributed: ['implementation'] },
  unrotatedReviewers: [],
  delegateConcentration: [],
  ...over,
});

describe('the run accounting for itself', () => {
  it('names what is going out unfinished', () => {
    const report = buildCommonsReport(
      input({ findings: [finding({ summary: 'The retry path is untested.' }), finding({ id: 'f2', disposition: 'accepted' })] }),
    );
    expect(report.unresolved).toEqual(['The retry path is untested.']);
  });

  it('marks an unresolved item that was also a minority report', () => {
    const report = buildCommonsReport({ ...input(), findings: [finding({ minority: true })] });
    expect(report.unresolved[0]).toContain('minority report');
  });

  it('leaves deferred work as a lesson for whoever comes next, with its owner', () => {
    const report = buildCommonsReport(
      input({ findings: [finding({ disposition: 'deferred', owner: 'security-council', summary: 'Rotate the secret.' })] }),
    );
    expect(report.lessons).toEqual(['Rotate the secret. (owned by security-council)']);
  });

  // Section 9: skipped or inapplicable checks are disclosed with reasons, never silently counted
  // as passes.
  it('names every check that did not run, and says so when no reason was given', () => {
    const report = buildCommonsReport(
      input({
        finalChecks: [
          { categoryId: 'types', command: 'tsc', args: [], ran: false, passed: false, skippedReason: 'no tsconfig' },
          { categoryId: 'lint', command: 'x', args: [], ran: false, passed: false },
          { categoryId: 'unit', command: 'npm', args: ['test'], ran: true, passed: true },
        ],
      }),
    );
    expect(report.skippedChecks).toEqual(['types: no tsconfig', 'lint: no reason recorded, which is itself a gap in the record']);
  });

  // Articles 2 and 7: a failure nobody wrote down is a discovery held privately by whichever agent
  // hit it.
  it('discloses a failure whose lesson never reached the shared store', () => {
    const report = buildCommonsReport(input({ failedTaskIds: ['t1', 't2'], publishedTaskIds: ['t1'] }));
    expect(report.limitations.join(' ')).toContain('t2');
    expect(report.limitations.join(' ')).toContain('not available to the next council');
  });

  it('is silent when every failure was written back', () => {
    expect(buildCommonsReport(input({ failedTaskIds: ['t1'], publishedTaskIds: ['t1'] })).limitations).toEqual([]);
  });

  it('records a node the whole council refused as a defect in the plan', () => {
    expect(buildCommonsReport(input({ planningDefects: ['t1'] })).limitations[0]).toContain('defect in the plan rather than in any worker');
  });

  // Section 6: coordinators do inspectable work "when feasible" — so this is disclosed, not blocking.
  it('discloses a convener who coordinated and produced nothing', () => {
    const report = buildCommonsReport(input({ productiveDuty: { convener: 'backend-1', met: false, contributed: [] } }));
    expect(report.limitations[0]).toContain('without taking any implementation or verification work');
  });

  it('says nothing about a convener that does not exist', () => {
    expect(buildCommonsReport(input({ productiveDuty: { convener: '', met: false, contributed: [] } })).limitations).toEqual([]);
  });

  // Section 9: "independence for a change must never create a permanent QA caste."
  it('names a reviewer who never implemented, without treating one run as proof', () => {
    const report = buildCommonsReport(input({ unrotatedReviewers: ['frontend-2'] }));
    expect(report.limitations[0]).toContain('frontend-2');
    expect(report.limitations[0]).toContain('that may simply be its shape');
  });
});

describe('a delegate holding a majority of the seats', () => {
  // Two units in one discipline draw their delegates from the same small membership, so on a short
  // plan this is arithmetic as often as it is capture. Article 10's remedies are rotation and
  // recall, neither of which is refusing the work.
  it('is disclosed rather than blocking the delivery', () => {
    const report = buildCommonsReport(
      input({
        delegateConcentration: [
          { personaId: 'backend-1', holdings: ['delegate:council-a', 'delegate:council-b'], remedy: 'Article 10: backend-1 speaks for 2 of 3 councils. Redraw the seats next term.' },
        ],
      }),
    );
    expect(report.limitations.join(' ')).toContain('speaks for 2 of 3 councils');
    expect(report.unresolved).toEqual([]);
  });
});

describe('the report as delivery notes', () => {
  it('carries unresolved matters to residual risks and skipped checks to limitations', () => {
    const notes = toDeliveryNotes({
      published: ['lesson:backend'],
      unresolved: ['The retry path is untested.'],
      lessons: [],
      skippedChecks: ['types: no tsconfig'],
      limitations: ['A planning defect.'],
    });
    expect(notes.residualRisks).toEqual(['[councils] The retry path is untested.']);
    expect(notes.limitations).toEqual(['A planning defect.', 'Check not run — types: no tsconfig']);
    expect(notes.rollbackNotes[0]).toContain('stays there and is not reverted');
  });

  it('adds no rollback note when the run returned nothing to the commons', () => {
    const notes = toDeliveryNotes({ published: [], unresolved: [], lessons: [], skippedChecks: [], limitations: [] });
    expect(notes.rollbackNotes).toEqual([]);
  });
});
