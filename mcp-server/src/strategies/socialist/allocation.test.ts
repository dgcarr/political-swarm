import { describe, expect, it } from 'vitest';
import {
  assessNeeds,
  nextAssignee,
  readAssignmentReturn,
  requestedEnvelopeUsd,
  returnsBeforeReplan,
  routeBySubsidiarity,
} from './allocation.js';
import type { SocialistConfig } from './types.js';
import type { TaskNode } from '../../engine/types.js';

const cfg = {
  guilds: ['frontend', 'backend'],
  initialCapabilityScore: 0.5,
  recall: { consecutivePlannerFailuresBeforeSwap: 3 },
  escalateToHuman: { securityPathGlobs: [] },
} as unknown as SocialistConfig;

const node = (over: Partial<TaskNode> = {}): Pick<TaskNode, 'id' | 'riskClass' | 'targetGlobs' | 'dependsOn'> => ({
  id: 't1',
  riskClass: 'low',
  targetGlobs: ['src/a.ts'],
  dependsOn: [],
  ...over,
});

describe('what the work needs (article 4)', () => {
  it('reads risk, breadth, dependencies and prior failure', () => {
    const easy = assessNeeds(node(), 0, cfg);
    const hard = assessNeeds(node({ riskClass: 'high', targetGlobs: ['a', 'b', 'c', 'd', 'e', 'f'], dependsOn: ['x', 'y', 'z'] }), 2, cfg);
    expect(hard.difficulty).toBeGreaterThan(easy.difficulty);
    expect(hard.difficulty).toBeLessThanOrEqual(1);
    expect(easy.difficulty).toBeGreaterThanOrEqual(0);
  });

  it('allocates a larger actual reservation request to harder work without reading worker rank', () => {
    const easy = assessNeeds(node(), 0, cfg);
    const hard = assessNeeds(node({ riskClass: 'high', dependsOn: ['x', 'y'] }), 2, cfg);
    expect(requestedEnvelopeUsd(hard, 0.3)).toBeGreaterThan(requestedEnvelopeUsd(easy, 0.3));
  });

  // Article 4's two halves pull in opposite directions on purpose: work follows capability,
  // resources follow need. The assessment is not given the worker at all.
  it('takes no argument that could tell it who holds the work', () => {
    expect(assessNeeds.length).toBe(3);
    expect(assessNeeds(node(), 0, cfg)).toEqual(assessNeeds(node(), 0, cfg));
  });

  it('scales the commons a node may draw on between the configured bounds', () => {
    expect(assessNeeds(node(), 0, cfg).lessonBudget).toBe(3);
    expect(assessNeeds(node({ riskClass: 'high', targetGlobs: Array(6).fill('a'), dependsOn: ['x', 'y', 'z'] }), 2, cfg).lessonBudget).toBe(8);
    const narrow = { ...cfg, allocation: { ...cfg.allocation, lessonBudget: { min: 1, max: 2 } } };
    expect(assessNeeds(node(), 0, narrow).lessonBudget).toBe(1);
  });

  // Section 11 lists supplying aid first among the remedies for repeated failure.
  it('counts a node that keeps coming back as demonstrated need', () => {
    expect(assessNeeds(node(), 0, cfg).difficulty).toBeLessThan(assessNeeds(node(), 2, cfg).difficulty);
    expect(assessNeeds(node(), 2, cfg).aidEligible).toBe(true);
  });

  it('holds simple low-risk work below the aid floor, where a failure points at the plan', () => {
    expect(assessNeeds(node(), 0, cfg).aidEligible).toBe(false);
    expect(assessNeeds(node({ riskClass: 'medium' }), 0, cfg).aidEligible).toBe(true);
  });

  it('survives a config that zeroes every weight rather than dividing by nothing', () => {
    const flat = { ...cfg, allocation: { ...cfg.allocation, needsWeighting: { riskClass: 0, breadth: 0, dependencies: 0, priorRejections: 0 } } };
    const assessed = assessNeeds(node({ riskClass: 'high' }), 5, flat);
    expect(Number.isFinite(assessed.difficulty)).toBe(true);
    expect(assessed.difficulty).toBe(0);
  });

  it('survives a config whose lesson bounds are inverted', () => {
    const inverted = { ...cfg, allocation: { ...cfg.allocation, lessonBudget: { min: 9, max: 2 } } };
    const assessed = assessNeeds(node({ riskClass: 'high' }), 2, inverted);
    expect(assessed.lessonBudget).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(assessed.lessonBudget)).toBe(true);
  });

  it('says what drove the number, so the resourcing is inspectable', () => {
    expect(assessNeeds(node({ riskClass: 'high' }), 0, cfg).rationale).toContain('risk');
    expect(assessNeeds(node({ targetGlobs: [] }), 0, cfg).rationale).toContain('above the floor');
  });
});

describe('who decides (article 6)', () => {
  it('leaves a single council to settle its own work', () => {
    const routed = routeBySubsidiarity('t1', ['council-t1']);
    expect(routed).toMatchObject({ decidedBy: 'council', escalated: false });
    expect(routed.rationale).toContain('was not required');
  });

  it('escalates only a genuine dependency between councils', () => {
    expect(routeBySubsidiarity('t1', ['council-t1', 'council-t2'])).toMatchObject({
      decidedBy: 'coordinating-council',
      escalated: true,
    });
  });

  it('does not mistake two guilds within one production council for two authorities', () => {
    expect(routeBySubsidiarity('t1', ['council-t1']).escalated).toBe(false);
  });

  it('treats work belonging to nobody as local rather than federal', () => {
    expect(routeBySubsidiarity('t1', []).escalated).toBe(false);
  });
});

describe('the right to return an assignment (section 6)', () => {
  it('reads a declared return', () => {
    expect(readAssignmentReturn({ assignmentReturn: { returned: true, reason: 'No acceptance criteria.' } })).toEqual({
      returned: true,
      reason: 'No acceptance criteria.',
    });
  });

  it('treats ordinary work as ordinary work', () => {
    expect(readAssignmentReturn({ fileOps: [], assignmentReturn: { returned: false, reason: 'n/a' } })).toBeNull();
    expect(readAssignmentReturn({ fileOps: [] })).toBeNull();
  });

  // This runs inside execute(), on the task loop, over whatever a model chose to emit. A thrown
  // TypeError here is not a rejected node, it is a crashed run.
  it('cannot be made to throw by hostile or malformed output', () => {
    const hostile: unknown[] = [
      null,
      undefined,
      'a string',
      42,
      [],
      { assignmentReturn: null },
      { assignmentReturn: 'yes' },
      { assignmentReturn: [] },
      { assignmentReturn: { returned: 'true' } },
      { assignmentReturn: { returned: true } },
      { assignmentReturn: { returned: true, reason: 42 } },
      { assignmentReturn: { returned: true, reason: '   ' } },
    ];
    for (const value of hostile) {
      expect(() => readAssignmentReturn(value)).not.toThrow();
    }
    expect(readAssignmentReturn({ assignmentReturn: { returned: true } })).toEqual({
      returned: true,
      reason: 'No reason given.',
    });
  });

  it('offers the work to the next member the council would have chosen', () => {
    expect(nextAssignee(['backend-1', 'backend-2'], ['backend-1'], { 'backend-1': 0.9, 'backend-2': 0.4 })).toBe('backend-2');
    expect(nextAssignee(['backend-1', 'backend-2'], [], { 'backend-1': 0.2, 'backend-2': 0.8 })).toBe('backend-2');
  });

  it('reports that the council has nobody left rather than re-offering to someone who declined', () => {
    expect(nextAssignee(['backend-1'], ['backend-1'])).toBeNull();
    expect(nextAssignee([], [])).toBeNull();
  });

  it('bounds how many times a node may go round the room', () => {
    expect(returnsBeforeReplan(cfg)).toBe(2);
    expect(returnsBeforeReplan({ ...cfg, allocation: { ...cfg.allocation, returnsBeforeReplan: 0 } })).toBe(0);
    expect(returnsBeforeReplan({ ...cfg, allocation: { ...cfg.allocation, returnsBeforeReplan: -1 } })).toBe(2);
  });
});
