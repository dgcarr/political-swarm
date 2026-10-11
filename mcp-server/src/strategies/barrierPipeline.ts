import { ownershipFromGraph } from '../engine/ownership.js';
import type {
  DeliveryPacket,
  IntegrationResult,
  OwnershipEntry,
  OwnershipMap,
  VerificationResult,
} from '../engine/packets.js';
import type { EngineContext } from '../engine/SwarmStrategy.js';
import type { TaskGraph } from '../engine/types.js';
import {
  integrationSchemaDescription,
  renderCheckSummary,
  toEngineFindings,
  diffBudget, truncateDiff,
  validateIntegrationReport,
  validateVerificationReport,
  verificationSchemaDescription,
  type WireIntegrationReport,
  type WireVerificationReport,
} from './barriers.js';

export interface OwnershipBarrierOptions {
  interfacesFor: (entry: OwnershipEntry, graph: TaskGraph) => string[];
  overlapRationale: string;
}

export async function runOwnershipDeclaration(
  ctx: EngineContext,
  graph: TaskGraph,
  opts: OwnershipBarrierOptions,
): Promise<OwnershipMap> {
  const map = ownershipFromGraph(graph, ctx.checks.testPathGlobs);

  const byPath = new Map<string, string[]>();
  for (const entry of Object.values(map.entries)) {
    entry.interfaces = opts.interfacesFor(entry, graph);
    for (const path of entry.paths) {
      byPath.set(path, [...(byPath.get(path) ?? []), entry.taskId]);
    }
  }
  for (const [path, taskIds] of byPath) {
    if (taskIds.length > 1) {
      map.declaredOverlaps.push({
        taskIds,
        path,
        rationale: opts.overlapRationale,
      });
    }
  }
  return map;
}

export interface IntegrationBarrierOptions {
  integratorId: string;
  systemPrompt: string;
  buildUserPrompt: (
    goal: string,
    acceptanceCriteria: string[],
    titles: string[],
    truncatedDiff: string,
  ) => string;
}

export async function runIntegrationBarrier(
  ctx: EngineContext,
  approvedTaskIds: string[],
  diffText: string,
  opts: IntegrationBarrierOptions,
): Promise<IntegrationResult> {
  const graph = ctx.runState.graph;
  const titles = approvedTaskIds.map((id) => graph?.nodes[id]?.title ?? id);

  const result = await ctx.dispatcher.dispatch<WireIntegrationReport>({
    role: 'integrator',
    personaId: opts.integratorId,
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.buildUserPrompt(
      ctx.runState.task.goal,
      ctx.runState.task.acceptanceCriteria,
      titles,
      truncateDiff(diffText, diffBudget(ctx)),
    ),
    schemaDescription: integrationSchemaDescription,
    validate: validateIntegrationReport,
    temperature: 0.2,
  });

  return {
    integratorId: opts.integratorId,
    integrated: result.value.integrated,
    postIntegrationChecks: [],
    findings: toEngineFindings(result.value.findings, opts.integratorId),
    rationale: result.value.rationale,
  };
}

export interface VerificationBarrierOptions {
  verifierId: string;
  systemPrompt: string;
  buildUserPrompt: (
    goal: string,
    acceptanceCriteria: string[],
    requirementMatrix: DeliveryPacket['requirementMatrix'],
    checkSummary: string,
    truncatedDiff: string,
  ) => string;
}

export async function runVerificationBarrier(
  ctx: EngineContext,
  draft: DeliveryPacket,
  opts: VerificationBarrierOptions,
): Promise<VerificationResult> {
  const checkSummary = renderCheckSummary(draft.finalChecks, ctx.checks);
  const userPrompt = opts.buildUserPrompt(
    draft.goal,
    draft.acceptanceCriteria,
    draft.requirementMatrix,
    checkSummary,
    truncateDiff(draft.diffText, diffBudget(ctx)),
  );
  const ask = (prompt: string) => ctx.dispatcher.dispatch<WireVerificationReport>({
    role: 'verifier',
    personaId: opts.verifierId,
    systemPrompt: opts.systemPrompt,
    userPrompt: prompt,
    schemaDescription: verificationSchemaDescription,
    validate: validateVerificationReport,
    temperature: 0.2,
  });

  const result = await ask(userPrompt);
  const report = result.value;
  let criteriaTraced = canonicalCriteria(report.criteriaTraced, draft.acceptanceCriteria);
  let findings = report.findings;

  // A verifier that passes the delivery but leaves a criterion out of its list has not said it
  // could not trace it, yet every gate reads the omission as exactly that. On 2026-10-07 a
  // democratic arm passing 10/12 oracle checks ended after 16 minutes because the verifier, having
  // answered verified=true, listed 8 of 9 criteria. Ask once about the omitted ones alone; whatever
  // it still cannot trace stays untraced, so the gates hold the same line.
  const omitted = draft.acceptanceCriteria.filter((criterion) => !criteriaTraced.includes(criterion));
  if (report.verified && omitted.length > 0) {
    const followUp = await ask(
      `${userPrompt}\n\nYour report verified this delivery but did not list these acceptance criteria ` +
        'in criteriaTraced. Consider only these. List in criteriaTraced, verbatim, each one you can ' +
        'trace to implementing code AND evidence above, and leave out any you cannot; raise a finding ' +
        `for any that is not met:\n${omitted.map((criterion) => `- ${criterion}`).join('\n')}`,
    );
    const recovered = canonicalCriteria(followUp.value.criteriaTraced, omitted);
    criteriaTraced = draft.acceptanceCriteria.filter(
      (criterion) => criteriaTraced.includes(criterion) || recovered.includes(criterion),
    );
    findings = [...findings, ...followUp.value.findings];
    ctx.ledger.record('verification_follow_up', {
      verifierId: opts.verifierId,
      omitted: omitted.length,
      recovered: recovered.length,
    });
  }

  return {
    verifierId: opts.verifierId,
    verified: report.verified,
    criteriaTraced,
    findings: toEngineFindings(findings, opts.verifierId),
    rationale: report.rationale,
  };
}

/**
 * The acceptance criteria a verifier echoed, in their exact wording.
 *
 * Gates compare criteriaTraced with the criteria verbatim, so an echo differing only in case or
 * spacing counted as untraced. Anything that matches no criterion is dropped.
 */
function canonicalCriteria(echoed: readonly string[], criteria: readonly string[]): string[] {
  const key = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
  const echoedKeys = new Set(echoed.map(key));
  return criteria.filter((criterion) => echoedKeys.has(key(criterion)));
}
