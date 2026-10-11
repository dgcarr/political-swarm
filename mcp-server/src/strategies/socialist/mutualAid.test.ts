import { describe, expect, it } from 'vitest';
import { aidAsCommonsEntry, aidIsDue, aidTags, renderAid, validateAidPacket, type AidPacket } from './mutualAid.js';
import type { NeedsAssessment } from './allocation.js';
import type { SocialistConfig } from './types.js';

const cfg = {
  guilds: ['backend'],
  initialCapabilityScore: 0.5,
  recall: { consecutivePlannerFailuresBeforeSwap: 3 },
  escalateToHuman: { securityPathGlobs: [] },
} as unknown as SocialistConfig;

const needs = (aidEligible: boolean): NeedsAssessment => ({
  taskId: 't1',
  difficulty: aidEligible ? 0.8 : 0.1,
  riskClass: aidEligible ? 'high' : 'low',
  lessonBudget: 5,
  aidEligible,
  rationale: 'r',
});

const packet: AidPacket = {
  context: 'The test runner needs NODE_ENV=test.',
  fixture: 'NODE_ENV=test npm test -- profile',
  priorAttempts: 'Running npm test bare, which picks up the dev config.',
};

describe('who gets help', () => {
  it('helps a worker on hard work that keeps failing', () => {
    expect(aidIsDue({ needs: needs(true), rejections: 1, wasReturned: false }, cfg)).toBe(true);
  });

  it('waits for an actual block', () => {
    expect(aidIsDue({ needs: needs(true), rejections: 0, wasReturned: false }, cfg)).toBe(false);
  });

  // Simple low-risk work that fails points at the plan, and section 11 routes that to diagnosis.
  // Aiding every failure regardless would be the endless rescue section 14 warns about.
  it('does not rescue simple work whose failure points at the plan', () => {
    expect(aidIsDue({ needs: needs(false), rejections: 3, wasReturned: false }, cfg)).toBe(false);
  });

  // A worker saying plainly it cannot take the work has demonstrated need in the most direct form
  // available, whatever the difficulty score says.
  it('always helps a worker who handed the assignment back', () => {
    expect(aidIsDue({ needs: needs(false), rejections: 0, wasReturned: true }, cfg)).toBe(true);
    expect(aidIsDue({ needs: undefined, rejections: 0, wasReturned: true }, cfg)).toBe(true);
  });

  it('reads the work and never the worker', () => {
    // The trigger has no field that could carry a capability score or a persona id.
    const trigger = { needs: needs(true), rejections: 1, wasReturned: false };
    expect(Object.keys(trigger)).toEqual(['needs', 'rejections', 'wasReturned']);
  });

  it('can be switched off, or made to arrive later', () => {
    expect(aidIsDue({ needs: needs(true), rejections: 5, wasReturned: false }, { ...cfg, mutualAid: { ...cfg.mutualAid, enabled: false } })).toBe(false);
    const patient = { ...cfg, mutualAid: { ...cfg.mutualAid, rejectionsBeforeAid: 3 } };
    expect(aidIsDue({ needs: needs(true), rejections: 2, wasReturned: false }, patient)).toBe(false);
    expect(aidIsDue({ needs: needs(true), rejections: 3, wasReturned: false }, patient)).toBe(true);
  });

  it('treats a zero threshold as off rather than as always', () => {
    expect(aidIsDue({ needs: needs(true), rejections: 9, wasReturned: false }, { ...cfg, mutualAid: { ...cfg.mutualAid, rejectionsBeforeAid: 0 } })).toBe(false);
  });
});

describe('aid belongs to the commons, not to the worker who asked', () => {
  it('is filed as reusable infrastructure under the tags of the work', () => {
    const entry = aidAsCommonsEntry(packet, { taskId: 't1', nodeTitle: 'Add profile', tags: ['backend', 'mutual-aid'], runId: 'run-a' });
    expect(entry.kind).toBe('fixture');
    expect(entry.tags).toEqual(['backend', 'mutual-aid']);
    expect(entry.content).toContain('NODE_ENV=test npm test -- profile');
    expect(entry.sourceTaskId).toBe('t1');
  });

  it('is tagged so the next worker meeting the same wall finds it', () => {
    expect(aidTags(['backend', 'testing'], 'medium', ['profile'])).toEqual([
      'backend',
      'testing',
      'medium',
      'profile',
      'mutual-aid',
    ]);
  });

  it('reaches the next attempt with what was already tried', () => {
    const rendered = renderAid(packet);
    expect(rendered).toContain('NODE_ENV=test');
    expect(rendered).toContain('do not repeat it');
  });
});

describe('the aid packet a model returns', () => {
  it('accepts a complete packet', () => {
    expect(() => validateAidPacket(packet)).not.toThrow();
  });

  it('refuses advice with no fixture in it', () => {
    expect(() => validateAidPacket({ ...packet, fixture: '' })).toThrow(/fixture/);
    expect(() => validateAidPacket({ ...packet, context: '   ' })).toThrow(/context/);
    expect(() => validateAidPacket({ context: 'x', fixture: 'y' })).toThrow(/priorAttempts/);
    expect(() => validateAidPacket(null)).toThrow(/JSON object/);
  });
});
