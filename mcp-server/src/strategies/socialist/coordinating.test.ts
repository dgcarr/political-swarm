import { describe, expect, it } from 'vitest';
import {
  checkMandate,
  formCoordinatingCouncil,
  productiveDutyMet,
  rotateCoordinatingCouncil,
  termExpired,
  withoutSelfAllocation,
} from './coordinating.js';
import type { WorkerCouncil } from './councils.js';
import type { SocialistConfig } from './types.js';

const cfg = {
  guilds: ['frontend', 'backend', 'testing', 'security', 'docs', 'architecture'],
  initialCapabilityScore: 0.5,
  recall: { consecutivePlannerFailuresBeforeSwap: 3 },
  escalateToHuman: { securityPathGlobs: [] },
} as unknown as SocialistConfig;

const council = (id: string, delegate: string): WorkerCouncil => ({
  id,
  taskId: id.replace('council-', ''),
  guilds: ['backend'],
  members: [delegate, 'backend-9'],
  delegate,
  termId: 1,
});

const three = [council('council-t1', 'backend-1'), council('council-t2', 'frontend-1'), council('council-t3', 'docs-1')];

describe('seating the coordinating council', () => {
  it('is composed of the delegates the worker councils chose, and nobody else', () => {
    const seated = formCoordinatingCouncil({ councils: three, termId: 1, seed: 'run-a', seatedAt: 0 });
    expect(seated.delegates).toEqual({ 'council-t1': 'backend-1', 'council-t2': 'frontend-1', 'council-t3': 'docs-1' });
    expect(Object.values(seated.delegates)).toContain(seated.convener);
  });

  it('seats reproducibly from the same run id', () => {
    const a = formCoordinatingCouncil({ councils: three, termId: 1, seed: 'run-a', seatedAt: 0 });
    const b = formCoordinatingCouncil({ councils: three, termId: 1, seed: 'run-a', seatedAt: 0 });
    expect(b).toEqual(a);
  });

  // Rotation that can return the same chair by chance is not rotation.
  it('never returns the outgoing convener while anyone else is free', () => {
    for (const outgoing of ['backend-1', 'frontend-1', 'docs-1']) {
      const seated = formCoordinatingCouncil({ councils: three, termId: 2, seed: 'run-a', seatedAt: 3, previousConvener: outgoing });
      expect(seated.convener).not.toBe(outgoing);
    }
  });

  it('lets a sole delegate convene rather than leaving the chair empty', () => {
    const solo = formCoordinatingCouncil({
      councils: [council('council-t1', 'backend-1')],
      termId: 2,
      seed: 'run-a',
      seatedAt: 0,
      previousConvener: 'backend-1',
    });
    expect(solo.convener).toBe('backend-1');
  });
});

describe('the mandate expires', () => {
  const seated = formCoordinatingCouncil({ councils: three, termId: 1, seed: 'run-a', seatedAt: 2 });

  it('runs for the configured number of work units', () => {
    expect(termExpired(7, seated, cfg)).toBe(false);
    expect(termExpired(8, seated, cfg)).toBe(true);
  });

  it('can be switched off, but is not permanent by default', () => {
    expect(termExpired(999, seated, { ...cfg, coordinating: { ...cfg.coordinating, termLengthInTasks: 0 } })).toBe(false);
    expect(termExpired(999, seated, cfg)).toBe(true);
  });

  it('reforms with a new term and a new chair', () => {
    const next = rotateCoordinatingCouncil(seated, three, 'run-a', 8);
    expect(next.termId).toBe(seated.termId + 1);
    expect(next.seatedAt).toBe(8);
    expect(next.convener).not.toBe(seated.convener);
  });
});

describe('what the coordinating council may decide', () => {
  const decision = { taskId: 't1', subject: 'ordering', councilsAffected: 2, decidedBy: 'coordinating-council' };

  it('permits ordering across councils', () => {
    expect(checkMandate(decision, cfg)).toBeNull();
  });

  it('refuses technical truth and names the article', () => {
    expect(checkMandate({ ...decision, subject: 'which-algorithm' }, cfg)?.article).toBe('article-5');
  });

  it('refuses federal action a single council could take alone', () => {
    expect(checkMandate({ ...decision, councilsAffected: 1 }, cfg)?.article).toBe('article-6');
  });

  it('lets a swarm narrow its own mandate', () => {
    const narrowed = { ...cfg, coordinating: { ...cfg.coordinating, mandate: ['ordering'] } } as SocialistConfig;
    expect(checkMandate(decision, narrowed)).toBeNull();
    expect(checkMandate({ ...decision, subject: 'scarce-resource' }, narrowed)?.remedy).toContain('covers ordering');
  });

  // Article 6 is not a tunable: a config that added a subject would be a doctrine editing its own
  // constitution, so the default check still runs underneath.
  it('does not let a swarm widen its mandate past the constitution', () => {
    const widened = { ...cfg, coordinating: { ...cfg.coordinating, mandate: ['ordering', 'which-algorithm'] } } as unknown as SocialistConfig;
    expect(checkMandate({ ...decision, subject: 'which-algorithm' }, widened)?.article).toBe('article-5');
  });
});

describe('a coordinator may not approve its own consequential decision', () => {
  it('leaves an ordinary allocation alone', () => {
    expect(withoutSelfAllocation('backend-1', 'frontend-2', 'frontend-1')).toEqual({
      assigneeId: 'frontend-2',
      overrodeSelfAllocation: false,
    });
  });

  it('falls back to the council\'s own ordering when the convener names itself', () => {
    expect(withoutSelfAllocation('backend-1', 'backend-1', 'frontend-1')).toEqual({
      assigneeId: 'frontend-1',
      overrodeSelfAllocation: true,
    });
  });

  // Overriding into an empty or identical preference would be worse than the breach it fixes.
  it('does not override into nobody', () => {
    expect(withoutSelfAllocation('backend-1', 'backend-1', '').assigneeId).toBe('backend-1');
    expect(withoutSelfAllocation('backend-1', 'backend-1', 'backend-1').overrodeSelfAllocation).toBe(false);
  });
});

describe('coordinators do inspectable work too', () => {
  it('is met by implementing', () => {
    expect(productiveDutyMet('backend-1', ['backend-1'], ['frontend-2'], cfg)).toMatchObject({
      met: true,
      contributed: ['implementation'],
    });
  });

  it('is met by verifying', () => {
    expect(productiveDutyMet('backend-1', ['frontend-1'], ['backend-1'], cfg).contributed).toEqual(['verification']);
  });

  it('is unmet by a convener that only coordinated', () => {
    expect(productiveDutyMet('backend-1', ['frontend-1'], ['frontend-2'], cfg)).toMatchObject({ met: false, contributed: [] });
  });

  it('can be switched off, and is vacuously met with no convener', () => {
    expect(productiveDutyMet('backend-1', [], [], { ...cfg, coordinating: { ...cfg.coordinating, requireProductiveDuty: false } }).met).toBe(true);
    expect(productiveDutyMet('', [], [], cfg).met).toBe(true);
  });
});
