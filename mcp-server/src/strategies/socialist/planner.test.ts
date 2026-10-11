import { describe, it, expect } from 'vitest';
import { normalizePlannerResponse, validatePlannerResponse } from './types.js';

const node = {
  id: 'add-isEven',
  title: 'Add isEven',
  description: 'Add an isEven helper in src/isEven.ts',
  targetGlobs: ['src/isEven.ts'],
  dependsOn: [],
};

describe('normalizePlannerResponse', () => {
  it('unwraps the documented { nodes: [...] } object form', () => {
    expect(normalizePlannerResponse({ nodes: [node] })).toEqual([node]);
  });

  it('still accepts a bare top-level array', () => {
    expect(normalizePlannerResponse([node])).toEqual([node]);
  });

  it('returns empty for shapes that carry no nodes', () => {
    expect(normalizePlannerResponse({})).toEqual([]);
    expect(normalizePlannerResponse({ nodes: 'nope' })).toEqual([]);
    expect(normalizePlannerResponse(null)).toEqual([]);
    expect(normalizePlannerResponse('text')).toEqual([]);
  });
});

describe('validatePlannerResponse', () => {
  it('accepts the object form — the only shape valid under response_format json_object', () => {
    expect(() => validatePlannerResponse({ nodes: [node] })).not.toThrow();
  });

  it('accepts the bare array form', () => {
    expect(() => validatePlannerResponse([node])).not.toThrow();
  });

  it('rejects an empty plan', () => {
    expect(() => validatePlannerResponse({ nodes: [] })).toThrow(/non-empty nodes array/);
    expect(() => validatePlannerResponse([])).toThrow(/non-empty nodes array/);
  });

  it('rejects duplicate node ids', () => {
    expect(() => validatePlannerResponse({ nodes: [node, node] })).toThrow(/not unique/);
  });

  it('rejects a node missing required string fields', () => {
    expect(() => validatePlannerResponse({ nodes: [{ ...node, title: '' }] })).toThrow(/title/);
    expect(() => validatePlannerResponse({ nodes: [{ ...node, description: '  ' }] })).toThrow(/description/);
  });

  it('rejects malformed array fields', () => {
    expect(() => validatePlannerResponse({ nodes: [{ ...node, targetGlobs: 'src/a.ts' }] })).toThrow(/targetGlobs/);
    expect(() => validatePlannerResponse({ nodes: [{ ...node, dependsOn: [1] }] })).toThrow(/dependsOn/);
    expect(() => validatePlannerResponse({ nodes: [{ ...node, acceptanceCriteria: [{}] }] })).toThrow(/acceptanceCriteria/);
  });

  it('allows optional fields to be absent', () => {
    const minimal = { id: 'x', title: 'X', description: 'does x', targetGlobs: ['x.ts'] };
    expect(() => validatePlannerResponse({ nodes: [minimal] })).not.toThrow();
  });

  it('rejects universal ownership in a multi-node plan', () => {
    const synthesisNode = {
      ...node,
      id: 'synthesis-summary',
      title: 'Synthesis summary',
      targetGlobs: ['**/*'],
    };

    expect(() => validatePlannerResponse({ nodes: [node, synthesisNode] })).toThrow(/non-universal targetGlobs/);
  });

  it('allows universal ownership for a genuinely single-node plan', () => {
    expect(() => validatePlannerResponse({ nodes: [{ ...node, targetGlobs: ['**/*'] }] })).not.toThrow();
  });
});
