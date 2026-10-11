import { describe, expect, it } from 'vitest';
import {
  coupling,
  formFirm,
  integrableListings,
  mergeSubcontractedOps,
  shouldIntegrate,
  subcontractorsOf,
} from './firms.js';
import { buildListing } from './exchange.js';
import type { TaskGraph, TaskNode } from '../../engine/types.js';

const SPECIALISATIONS: Record<string, string[]> = {
  'bidder-1': ['backend', 'implementation'],
  'bidder-2': ['testing', 'implementation'],
  'bidder-3': ['security', 'implementation'],
  'bidder-4': ['documentation', 'implementation'],
};

function node(over: Partial<TaskNode> = {}): TaskNode {
  return {
    id: 't1',
    title: 'Add an endpoint',
    description: 'Add a backend API route',
    acceptanceCriteria: ['it responds'],
    dependsOn: [],
    targetGlobs: ['src/api/**'],
    riskTags: [],
    riskClass: 'low',
    phase: 'queued',
    attempts: [],
    ...over,
  } as TaskNode;
}

function graph(nodes: TaskNode[]): TaskGraph {
  return { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), order: nodes.map((n) => n.id) };
}

function firm(over: Partial<Parameters<typeof formFirm>[0]> = {}) {
  return formFirm({
    leadId: 'bidder-1',
    listing: buildListing(node({ title: 'Add an endpoint with tests', description: 'backend route plus unit tests' })),
    pool: ['bidder-2', 'bidder-3', 'bidder-4'],
    seed: 'run-1',
    maxSubcontractors: 2,
    specialisations: SPECIALISATIONS,
    ...over,
  });
}

describe('forming a firm', () => {
  it('always names a lead who bears the liability', () => {
    const f = firm();
    expect(f.leadId).toBe('bidder-1');
    expect(f.liableId).toBe('bidder-1');
    expect(f.members[0]).toMatchObject({ personaId: 'bidder-1', role: 'lead' });
  });

  it('engages a specialist for a capability the listing needs and the lead lacks', () => {
    const f = firm();
    expect(subcontractorsOf(f).map((m) => m.role)).toContain('test');
  });

  // Coase at the level of a single contract: paying an outside specialist for something you already
  // do well is transaction cost with nothing bought.
  it('does not subcontract a capability the lead already holds', () => {
    const f = firm({ leadId: 'bidder-2' }); // bidder-2 is the testing specialist
    expect(subcontractorsOf(f).map((m) => m.capability)).not.toContain('testing');
  });

  it('delivers alone when the listing needs no speciality the lead lacks', () => {
    const f = firm({ listing: buildListing(node({ title: 'Tidy a helper', description: 'rename a backend function' })) });
    expect(subcontractorsOf(f)).toEqual([]);
  });

  // The buyer chose that bid partly on who it said would do the work. Quietly substituting somebody
  // else would make the declaration worthless — and section 6 makes a bid's statements binding.
  it('honours a subcontractor the winning bid actually named', () => {
    const f = firm({ declaredSubcontractors: ['bidder-2'] });
    expect(subcontractorsOf(f).map((m) => m.personaId)).toContain('bidder-2');
  });

  it('ignores a declared subcontractor who cannot do the work', () => {
    const f = firm({ declaredSubcontractors: ['bidder-4'] }); // documentation, not testing
    const testers = subcontractorsOf(f).filter((m) => m.role === 'test');
    expect(testers.every((m) => m.personaId !== 'bidder-4')).toBe(true);
  });

  it('respects the cap on how many specialists one contract may engage', () => {
    const listing = buildListing(
      node({ title: 'Auth route with tests and docs', description: 'security backend route, unit tests, README' }),
    );
    const f = firm({ listing, maxSubcontractors: 1 });
    expect(subcontractorsOf(f)).toHaveLength(1);
  });

  it('draws the same firm twice from the same seed, so composition is re-derivable', () => {
    expect(firm()).toEqual(firm());
  });

  it('never engages the lead as its own subcontractor', () => {
    const f = firm();
    expect(subcontractorsOf(f).every((m) => m.personaId !== f.leadId)).toBe(true);
  });

  it('proceeds alone rather than failing when nobody in the pool can do the work', () => {
    const f = firm({ pool: [] });
    expect(f.members).toHaveLength(1);
    expect(f.liableId).toBe('bidder-1');
  });
});

describe('coupling, and where the market stops being the cheaper coordinator', () => {
  it('scores two unrelated listings at zero', () => {
    const g = graph([node({ id: 'a', targetGlobs: ['src/a/**'] }), node({ id: 'b', targetGlobs: ['src/b/**'] })]);
    expect(coupling(g, 'a', 'b').score).toBe(0);
  });

  // Two contracts writing the same paths are not two contracts. They are one change with a seam
  // down the middle, and the seam is where the integration defect will be.
  it('scores listings that claim the same paths as tightly coupled', () => {
    const g = graph([node({ id: 'a', targetGlobs: ['src/api/**'] }), node({ id: 'b', targetGlobs: ['src/api/**'] })]);
    const c = coupling(g, 'a', 'b');
    expect(c.score).toBeGreaterThanOrEqual(0.5);
    expect(c.reasons.join(' ')).toContain('src/api/**');
  });

  it('counts a direct dependency between them', () => {
    const g = graph([
      node({ id: 'a', targetGlobs: ['src/a/**'] }),
      node({ id: 'b', targetGlobs: ['src/b/**'], dependsOn: ['a'] }),
    ]);
    expect(coupling(g, 'a', 'b').reasons).toContain('one depends directly on the other');
  });

  it('counts a shared upstream dependency, but more weakly than a shared path', () => {
    const g = graph([
      node({ id: 'base' }),
      node({ id: 'a', targetGlobs: ['src/a/**'], dependsOn: ['base'] }),
      node({ id: 'b', targetGlobs: ['src/b/**'], dependsOn: ['base'] }),
    ]);
    const shared = coupling(g, 'a', 'b').score;
    const samePath = coupling(
      graph([node({ id: 'a', targetGlobs: ['src/x/**'] }), node({ id: 'b', targetGlobs: ['src/x/**'] })]),
      'a',
      'b',
    ).score;
    expect(shared).toBeGreaterThan(0);
    expect(shared).toBeLessThan(samePath);
  });

  it('never exceeds 1, however many ways two listings interlock', () => {
    const g = graph([
      node({ id: 'base' }),
      node({ id: 'a', targetGlobs: ['src/x/**'], dependsOn: ['base'] }),
      node({ id: 'b', targetGlobs: ['src/x/**'], dependsOn: ['base', 'a'] }),
    ]);
    expect(coupling(g, 'a', 'b').score).toBeLessThanOrEqual(1);
  });

  it('is not coupled to itself, and shrugs at an unknown listing', () => {
    const g = graph([node({ id: 'a' })]);
    expect(coupling(g, 'a', 'a').score).toBe(0);
    expect(coupling(g, 'a', 'missing').score).toBe(0);
  });

  // The doctrine wants the market to be the default. The threshold sits high so integration is the
  // exception it argues for, not a way of avoiding auctions.
  it('leaves loosely coupled work to the market', () => {
    expect(shouldIntegrate(0.2, 0.6)).toBe(false);
    expect(shouldIntegrate(0.7, 0.6)).toBe(true);
  });

  it('can be turned off entirely, sending everything to tender', () => {
    expect(shouldIntegrate(1, 0)).toBe(false);
  });

  it('picks out the listings a firm should absorb with the one it just won', () => {
    const g = graph([
      node({ id: 'a', targetGlobs: ['src/api/**'] }),
      node({ id: 'b', targetGlobs: ['src/api/**'] }),
      node({ id: 'c', targetGlobs: ['docs/**'] }),
    ]);
    const absorbed = integrableListings(g, 'a', ['b', 'c'], 0.5);
    expect(absorbed.map((x) => x.taskId)).toEqual(['b']);
  });
});

describe('merging what the firm delivered', () => {
  const leadOps = [
    { op: 'write', path: 'src/api/route.js' },
    { op: 'write', path: 'src/api/index.js' },
  ];

  it('keeps a subcontractor’s work on paths the lead did not claim', () => {
    const { kept, dropped } = mergeSubcontractedOps(leadOps, [{ op: 'write', path: 'test/route.test.js' }]);
    expect(kept.map((o) => o.path)).toEqual(['test/route.test.js']);
    expect(dropped).toEqual([]);
  });

  // Under last-write-wins the test author's idea of the module would silently replace the actual
  // module, and the contract would still report as delivered.
  it('refuses to let a subcontractor overwrite the lead’s implementation', () => {
    const { kept, dropped } = mergeSubcontractedOps(leadOps, [
      { op: 'write', path: 'src/api/route.js' },
      { op: 'write', path: 'test/route.test.js' },
    ]);
    expect(kept.map((o) => o.path)).toEqual(['test/route.test.js']);
    expect(dropped.map((o) => o.path)).toEqual(['src/api/route.js']);
  });

  // The lead is liable for the delivery, so it has to be told a member of its firm tried this.
  it('returns what it dropped rather than discarding it silently', () => {
    const { dropped } = mergeSubcontractedOps(leadOps, [{ op: 'write', path: 'src/api/index.js' }]);
    expect(dropped).toHaveLength(1);
  });

  it('stops two subcontractors from overwriting each other', () => {
    const { kept, dropped } = mergeSubcontractedOps(leadOps, [
      { op: 'write', path: 'test/a.test.js' },
      { op: 'write', path: 'test/a.test.js' },
    ]);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(1);
  });
});
