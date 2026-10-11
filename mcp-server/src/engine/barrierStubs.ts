// Deterministic, always-passing implementations of the acceptance barriers.
//
// These are scaffolding, not governance: they make no OpenRouter calls and inspect nothing, so the
// engine's full barrier sequence can be exercised without an API key. NoopStrategy uses them, and
// so do the engine's unit tests, whose subject is the sequencing rather than any doctrine's
// judgment. No real strategy may use them — every doctrine performs these barriers through its own
// institutions, which is why SwarmStrategy declares them required rather than optional.

import type { EngineContext } from './SwarmStrategy.js';
import type {
  DeliveryPacket,
  DoctrineAcceptance,
  Finding,
  IntegrationResult,
  OwnershipMap,
  RemediationPacket,
  VerificationResult,
} from './packets.js';
import type { TaskGraph } from './types.js';
import { ownershipFromGraph } from './ownership.js';
import { emptyGraph } from './TaskGraph.js';

export async function stubDeclareOwnership(ctx: EngineContext, graph: TaskGraph): Promise<OwnershipMap> {
  return ownershipFromGraph(graph, ctx.checks.testPathGlobs);
}

export async function stubIntegrate(
  _ctx: EngineContext,
  approvedTaskIds: string[],
  _diffText: string,
): Promise<IntegrationResult> {
  return {
    integratorId: 'stub-integrator',
    integrated: true,
    postIntegrationChecks: [],
    findings: [],
    rationale: `Stub integration of ${approvedTaskIds.length} task(s); nothing was inspected.`,
  };
}

export async function stubVerifyDelivery(_ctx: EngineContext, draft: DeliveryPacket): Promise<VerificationResult> {
  return {
    // Deliberately distinct from stubIntegrate's id: the engine rejects a manifest whose verifier
    // is the agent that performed integration, and the stubs must not be a way around that.
    verifierId: 'stub-verifier',
    verified: true,
    criteriaTraced: draft.acceptanceCriteria,
    findings: [],
    rationale: 'Stub verification; nothing was verified.',
  };
}

export async function stubDisposeFindings(_ctx: EngineContext, open: Finding[]): Promise<Finding[]> {
  return open.map((f) => ({
    ...f,
    disposition: 'accepted' as const,
    dispositionRationale: 'Stub disposition; the finding was not examined.',
  }));
}

export async function stubAccept(_ctx: EngineContext, _draft: DeliveryPacket): Promise<DoctrineAcceptance> {
  return {
    accepted: true,
    procedure: 'stub-acceptance',
    rationale: 'Stub acceptance; no gate was applied.',
    decidedAt: new Date().toISOString(),
  };
}

export async function stubRemediate(ctx: EngineContext, packet: RemediationPacket): Promise<TaskGraph> {
  const graph = ctx.runState.graph ?? emptyGraph();
  for (const id of graph.order) {
    graph.nodes[id].phase = 'queued';
    graph.nodes[id].remediationOf = packet.findings.map((f) => f.summary).join('; ');
  }
  return graph;
}
