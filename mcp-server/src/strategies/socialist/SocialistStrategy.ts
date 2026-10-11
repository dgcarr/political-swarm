import {
  evidenceMandateUserPrompt,
  evidenceSchemaDescription,
  toEvidenceItems,
  evidenceMandateValidator,
  type WireEvidenceMandate,
} from '../evidenceMandate.js';
import type { SwarmStrategy, EngineContext, RecoveryRequest } from '../../engine/SwarmStrategy.js';
import { emptyGraph, addNode, readyNodes } from '../../engine/TaskGraph.js';
import { classifyRiskByPaths } from '../../engine/risk.js';
import { BudgetExceededError } from '../../engine/BudgetGuard.js';
import { remediationNote } from '../../engine/remediationNote.js';
import { rejectionRequiredChanges } from '../../engine/rejectionDirective.js';
import { renderRepairBrief } from '../../engine/repairBrief.js';
import { clipCheckOutput } from '../../util/checkOutput.js';
import { awaitAllOrThrow } from '../../util/awaitAll.js';
import { lotSeed } from '../../util/lots.js';
import { DECISION_VOTE_FLOOR, decideChoice, decideQuestions, summariseAnswer } from '../decisions.js';
import { deliveryGovernanceDigest, digestArtifact, GovernanceHaltError, grantGovernanceMandate, recordGovernanceDecision, requireGovernanceMandate, revokeGovernanceMandate } from '../../engine/governance.js';
import type {
  Assignment,
  Decision,
  FileOp,
  ReviewResult,
  TaskGraph,
  TaskNode,
  TaskSpec,
  TestResult,
  WorkProduct,
} from '../../engine/types.js';
import {
  DIAGNOSIS_SCHEMA_DESCRIPTION,
  diagnosisSystemPrompt,
  diagnosisUserPrompt,
  MUTUAL_AID_SCHEMA_DESCRIPTION,
  mutualAidSystemPrompt,
  mutualAidUserPrompt,
  RECONNAISSANCE_PROPOSED_TESTS_REQUIRED,
  RECONNAISSANCE_SCHEMA_DESCRIPTION,
  reconnaissanceSystemPrompt,
  reconnaissanceUserPrompt,
  validateReconnaissance,
  buildCoordinatorPrompt,
  buildImplementerPrompt,
  buildPlannerPrompt,
  buildReviewerPrompt,
  COORDINATOR_SCHEMA_DESCRIPTION,
  COORDINATOR_SYSTEM_PROMPT,
  IMPLEMENTER_SCHEMA_DESCRIPTION,
  IMPLEMENTER_SYSTEM_PROMPT,
  PLANNER_SCHEMA_DESCRIPTION,
  PLANNER_SYSTEM_PROMPT,
  REVIEWER_SCHEMA_DESCRIPTION,
  REVIEWER_SYSTEM_PROMPT,
  testMandateSystemPrompt,
  integrationCouncilSystemPrompt,
  integrationCouncilUserPrompt,
  ledgerDispositionSystemPrompt,
  ledgerDispositionUserPrompt,
  peerVerifierSystemPrompt,
  peerVerifierUserPrompt,
} from './prompts.js';
import {
  applyDispositions,
  dispositionSchemaDescription,
  diffBudget, truncateDiff,
  validateDispositionReport,
  type WireDispositionReport,
} from '../barriers.js';
import { runIntegrationBarrier, runOwnershipDeclaration, runVerificationBarrier } from '../barrierPipeline.js';
import type {
  DeliveryPacket,
  DoctrineAcceptance,
  DraftFinding,
  Finding,
  IntegrationResult,
  OwnershipMap,
  RemediationPacket,
  VerificationResult,
} from '../../engine/packets.js';
import {
  guildMembers,
  guildRoster,
  inferGuilds,
  nominatingGuild,
  primaryGuilds,
  titleKeywords,
  unrotatedReviewers,
} from './guilds.js';
import {
  blameWithoutDiagnosis,
  delegateConcentration,
  markNonWaivableFindings,
  monopolyBreaches,
  selfApprovalBreaches,
} from './constitution.js';
import {
  constituteCouncils,
  misallocationRecallDue,
  recallDelegate,
  seedBasis,
  tallyCouncilAcceptance,
  tallyCouncilPlanBallots,
  tallyCouncilRecallBallots,
  type CouncilPlanBallot,
  type RecallGround,
  type WorkerCouncil,
} from './councils.js';
import { buildCommonsReport, toDeliveryNotes } from './commons.js';
import { minorityReportsFrom, retainMinorityReports } from './dissent.js';
import {
  appealGround,
  classifyCause,
  convenePanel,
  diagnosisDue,
  hearAppeal,
  retryLimitReached,
  validateDiagnosis,
  type CauseFinding,
  type Diagnosis,
  type FailureSignals,
} from './recovery.js';
import {
  aidAsCommonsEntry,
  aidIsDue,
  aidTags,
  renderAid,
  validateAidPacket,
  type AidPacket,
} from './mutualAid.js';
import {
  assessNeeds,
  nextAssignee,
  readAssignmentReturn,
  requestedEnvelopeUsd,
  returnsBeforeReplan,
  routeBySubsidiarity,
  type NeedsAssessment,
} from './allocation.js';
import {
  councilsToSend,
  delegatePersonaFor,
  planTextOf,
  renderPublishedFindings,
  surveyRepository,
  unaddressedRisks,
  type CouncilFindings,
} from './reconnaissance.js';
import {
  checkMandate,
  formCoordinatingCouncil,
  productiveDutyMet,
  rotateCoordinatingCouncil,
  termExpired,
  withoutSelfAllocation,
} from './coordinating.js';
// Re-exported because the routing rules moved to guilds.ts without changing: anything that
// imported them from the strategy still resolves to the same functions.
export { inferGuilds, primaryGuilds } from './guilds.js';
import { blockingFailures } from '../../engine/checks.js';
import type {
  CoordinatorResponse,
  ImplementerResponse,
  PlannerNode,
  PlannerResponse,
  PlannerSynthesis,
  ReviewerResponse,
  SocialistConfig,
  SocialistState,
} from './types.js';
import {
  makeValidateCoordinatorResponse,
  normalizePlannerResponse,
  readPlannerSynthesis,
  validateImplementerResponse,
  validatePlannerResponse,
  validateReviewerResponse,
} from './types.js';
import { IMPLEMENTER_TEMPERATURE } from '../implementerReminders.js';
import { isSafeRelativePath } from '../validation.js';
import { SOCIALIST_DEFAULTS } from '../../constitution/schema.js';

/** The constitution's own citation for the delivery safety floor, quoted in findings and the ledger. */
const SAFETY_FLOOR_ARTICLE = 'section 10';
/**
 * Rounds of plan ratification before a run ends unratified. A council raising a new objection in a
 * later round gets another revision: in a real run the package-scaffold council's first objection
 * (test files) was met, and its second, different one (__main__.py required cli.py, owned by a
 * later mandate) ended the run because round two was the last.
 */
const MAX_RATIFICATION_ROUNDS = 4;

/** Whether two objections ask for the same change: most of their substantive words are shared. */
export function sameObjection(previous: string, current: string): boolean {
  const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9_./-]{4,}/g) ?? []);
  const a = words(previous);
  const b = words(current);
  if (a.size === 0 || b.size === 0) return a.size === b.size;
  const shared = [...a].filter((word) => b.has(word)).length;
  return shared / (a.size + b.size - shared) >= 0.5;
}

const OTHER_MANDATES_NOTE = 'The rest of the plan is listed under otherMandates and other councils own it: judge this mandate for its own scope only, and never ask it to take over files another mandate owns.';

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * The council's directive for a rework: whose objections stand and which checks must turn green.
 * A flag is listed too — it did not block, but over failing tests it is still the reviewer's
 * recorded concern with the work being redone. Check output is not pasted: the engine's repair
 * brief carries it, clipped once, to every implementer (engine/repairBrief.ts).
 */
function reworkRequirements(review: ReviewResult, test: TestResult): string[] {
  const reviewerChanges = review.findings
    .filter((finding) => finding.verdict === 'reject' || finding.verdict === 'flag')
    .map((finding) => finding.verdict === 'reject'
      ? `Address ${finding.reviewerId}'s objection: ${finding.rationale}`
      : `Weigh ${finding.reviewerId}'s flagged concern: ${finding.rationale}`);

  if (review.findings.length === 0) {
    reviewerChanges.push('Obtain an independent peer review; no reviewer finding was recorded for this attempt.');
  }

  if (!test.passed) {
    const failingChecks = rejectionRequiredChanges('', test);
    reviewerChanges.push(...(failingChecks.length > 0
      ? failingChecks
      : [`Make the failing check${test.command ? ` (${test.command})` : ''} pass.`]));
  }

  return reviewerChanges;
}

/**
 * Federated specialist guilds with peer review and recallable leadership.
 *
 * - plan(): a rotating 'planner' persona proposes the TaskGraph (usually one node).
 * - assign(): single-guild nodes are finalized by the guild itself (highest demonstratedCapability
 *   member, no model call — "local guilds decide"). Cross-guild nodes get one 'coordinator'
 *   arbitration call ("coordinator only resolves cross-module conflicts").
 * - execute(): the assigned guild member implements via structured FileOps + mandatory
 *   transparent-accounting (filesChanged + unresolvedUncertainty).
 * - review(): a DIFFERENT persona than the implementer reviews, informed by prior knowledge-store
 *   lessons tagged to the same guild/risk/topic ("mutual aid").
 * - decide(): approves only on (non-self reviewer approves AND tests pass); rejections are logged
 *   as lessons for future mutual aid. High-risk work and stuck (repeatedly-rejected) nodes escalate
 *   to a human via openApproval — a deliberate addition beyond the source doc, since it has no
 *   equivalent human gate and we don't want unsupervised high-risk work or infinite reject loops.
 * - recordOutcome(): bumps the assignee's guild capability score and tracks consecutive
 *   planner-attributed failures, recalling (swapping) the planner persona once a threshold is hit.
 */
export class SocialistStrategy implements SwarmStrategy {
  readonly id = 'socialist' as const;

  private state(ctx: EngineContext): SocialistState {
    const s = ctx.strategyState as Partial<SocialistState>;
    s.currentPlannerPersonaId ??= 'planner-1';
    s.capability ??= {};
    s.rejectionCounts ??= {};
    s.plannerFailureCount ??= 0;
    s.nodeGuilds ??= {};
    s.assignments ??= {};
    s.needs ??= {};
    s.returnedBy ??= {};
    s.planningDefects ??= [];
    s.aid ??= {};
    s.reworkDrafts ??= {};
    s.agreedScope ??= {};
    s.touchedPaths ??= {};
    s.appealsHeard ??= [];
    s.approvals ??= [];
    s.contributions ??= [];
    s.failedTaskIds ??= [];
    s.publishedTaskIds ??= [];
    s.councils ??= {};
    s.councilMandateIds ??= {};
    s.completedTasks ??= 0;
    s.mandateBreaches ??= [];
    s.delegateMisallocations ??= {};
    s.reassignments ??= [];
    return s as SocialistState;
  }

  private cfg(ctx: EngineContext): SocialistConfig {
    return ctx.config as unknown as SocialistConfig;
  }

  private ensureCapabilityInitialized(ctx: EngineContext, guild: string): void {
    const state = this.state(ctx);
    const cfg = this.cfg(ctx);
    state.capability[guild] ??= {};
    for (const m of guildMembers(guild)) {
      state.capability[guild][m] ??= cfg.initialCapabilityScore ?? SOCIALIST_DEFAULTS.initialCapabilityScore;
    }
  }

  private pickTopCapability(ctx: EngineContext, guild: string): string {
    this.ensureCapabilityInitialized(ctx, guild);
    const state = this.state(ctx);
    const members = guildMembers(guild);
    let best = members[0];
    for (const m of members) {
      if (state.capability[guild][m] > state.capability[guild][best]) best = m;
    }
    return best;
  }


  /**
   * Section 9's test mandate, produced before implementation: every acceptance criterion mapped to
   * the check that would demonstrate it and the result that check must show. The body chooses the
   * check; it never reports whether the criterion holds — that is resolved later from the check
   * that actually ran, which is what keeps this evidence rather than assertion.
   *
   * A failure here is not fatal to the run. The matrix is then simply empty, every criterion is
   * recorded as unevidenced, and the acceptance barrier refuses on exactly that ground.
   */
  private async recordTestMandate(ctx: EngineContext, task: TaskSpec): Promise<void> {
    const categories = ctx.checks.categories;
    try {
      const result = await ctx.dispatcher.dispatch<WireEvidenceMandate>({
        role: 'reviewer',
        personaId: 'council-test-mandate',
        phase: 'institutional',
        repositoryTools: false,
        reasoningEffort: 'low',
        institutionalReplayKey: `test-mandate:${digestArtifact({ goal: task.goal,
          criteria: task.acceptanceCriteria, checks: categories.map((category) => category.id) })}`,
        systemPrompt: testMandateSystemPrompt(),
        userPrompt: evidenceMandateUserPrompt(task.goal, task.acceptanceCriteria, ctx.checks),
        schemaDescription: evidenceSchemaDescription(categories.map((c) => c.id)),
        validate: evidenceMandateValidator(ctx.checks),
        temperature: 0.1,
      });
      ctx.runState.evidence = toEvidenceItems(result.value, task.acceptanceCriteria, categories);
    } catch (err) {
      ctx.runState.evidence = task.acceptanceCriteria.map((criterion) => ({
        criterion,
        command: '(none)',
        expectedResult: '(none recorded)',
        status: 'unavailable' as const,
        note: `The test mandate could not be produced: ${String(err)}`,
      }));
    }
    ctx.ledger.record('test_mandate_recorded', {
      criteria: ctx.runState.evidence.length,
      mapped: ctx.runState.evidence.filter((e) => e.note?.startsWith('check:')).length,
      manual: ctx.runState.evidence.filter((e) => e.status === 'manual').length,
    });
  }

  private async gatherReconnaissance(ctx: EngineContext, task: TaskSpec): Promise<CouncilFindings[]> {
    const cfg = this.cfg(ctx);
    const councils = councilsToSend(task, cfg);
    if (councils.length === 0) return [];

    const survey = surveyRepository(ctx.worktree, ctx.runState.baseline ?? []);
    const requireProposedTests = cfg.reconnaissance?.requireProposedTests ??
      SOCIALIST_DEFAULTS.reconnaissance.requireProposedTests;

    // Section 7, stage 2 asks for the councils to inspect "in parallel" before anyone writes a
    // plan. They previously dispatched one at a time regardless — a council's inspection never
    // depends on another council's, so nothing about running them concurrently changes who
    // inspects what or what they report; it only stops one council's dispatch from waiting on the
    // last one's round trip. Promise.all keeps them in this same councils[] order regardless of
    // which dispatch actually returns first, so the published list and the log read exactly as
    // they did before, just sooner.
    const outcomes = await Promise.all(
      councils.map(async (council) => {
        const personaId = delegatePersonaFor(council);
        try {
          const result = await ctx.dispatcher.dispatch<CouncilFindings>({
            role: 'planner',
            personaId,
            systemPrompt: reconnaissanceSystemPrompt(council),
            userPrompt: reconnaissanceUserPrompt(task, council, survey),
            schemaDescription: RECONNAISSANCE_SCHEMA_DESCRIPTION +
              (requireProposedTests ? RECONNAISSANCE_PROPOSED_TESTS_REQUIRED : ''),
            validate: (value: unknown) => validateReconnaissance(value, requireProposedTests),
            temperature: 0.2,
          });

          const findings: CouncilFindings = {
            council,
            personaId,
            scopes: result.value.scopes,
            risks: result.value.risks,
            dependencies: result.value.dependencies,
            proposedCriteria: result.value.proposedCriteria,
          };

          ctx.ledger.record('reconnaissance_published', {
            council,
            personaId,
            scopes: findings.scopes,
            risks: findings.risks,
            dependencies: findings.dependencies,
            proposedCriteria: findings.proposedCriteria,
            model: result.model,
          });
          return findings;
        } catch (err) {
          ctx.ledger.record('reconnaissance_published', {
            council,
            personaId,
            scopes: [],
            risks: [],
            dependencies: [],
            proposedCriteria: [],
            model: `(unavailable: ${String(err)})`,
          });
          return null;
        }
      }),
    );
    return outcomes.filter((findings): findings is CouncilFindings => findings !== null);
  }

  async plan(ctx: EngineContext, task: TaskSpec): Promise<TaskGraph> {
    const state = this.state(ctx);
    const cfg = this.cfg(ctx);

    // Acceptance tests are common infrastructure, co-designed before or alongside the work.
    await this.recordTestMandate(ctx, task);

    // The councils go out first. A plan written before they report would be the private invention
    // section 7 rules out, however good it happened to be.
    const published = await this.gatherReconnaissance(ctx, task);
    const plannerDigest = digestArtifact({ goal: task.goal, acceptanceCriteria: task.acceptanceCriteria });
    const plannerMandateId = `planner-${state.currentPlannerPersonaId}-${plannerDigest.slice(0, 12)}`;
    grantGovernanceMandate(ctx.runState, ctx.ledger, {
      id: plannerMandateId,
      grantor: 'run-charter',
      holder: state.currentPlannerPersonaId,
      scope: ['propose-task-graph'],
      artifactDigest: plannerDigest,
    });
    state.plannerMandateId = plannerMandateId;
    requireGovernanceMandate(ctx.runState, plannerMandateId, state.currentPlannerPersonaId, plannerDigest);

    const result = await ctx.dispatcher.dispatch<PlannerNode[] | PlannerResponse>({
      role: 'planner',
      personaId: state.currentPlannerPersonaId,
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      userPrompt: buildPlannerPrompt(task, renderPublishedFindings(published)),
      schemaDescription: PLANNER_SCHEMA_DESCRIPTION,
      validate: validatePlannerResponse,
      temperature: 0.3,
    });

    const rawNodes = normalizePlannerResponse(result.value);
    const ids = new Set(rawNodes.map((n) => n.id));
    const graph = emptyGraph();

    for (const raw of rawNodes) {
      const targetGlobs = raw.targetGlobs.length > 0 ? raw.targetGlobs : ['**/*'];
      const guilds = inferGuilds({ title: raw.title, description: raw.description, targetGlobs });
      const riskClass = classifyRiskByPaths(targetGlobs, { securityPathGlobs: cfg.escalateToHuman?.securityPathGlobs ?? SOCIALIST_DEFAULTS.escalateToHuman.securityPathGlobs });
      state.nodeGuilds[raw.id] = guilds;
      // Section 8: paths are declared before editing, so the comparison at convergence has
      // something to compare against.
      state.agreedScope[raw.id] = targetGlobs;

      addNode(graph, {
        id: raw.id,
        title: raw.title,
        description: raw.description,
        acceptanceCriteria: raw.acceptanceCriteria && raw.acceptanceCriteria.length > 0 ? raw.acceptanceCriteria : task.acceptanceCriteria,
        dependsOn: (raw.dependsOn ?? []).filter((d) => d !== raw.id && ids.has(d)),
        targetGlobs,
        riskTags: guilds,
        riskClass,
        phase: 'queued',
        attempts: [],
      });

      // Domain routing is deterministic (no model call), so without this the audit trail shows
      // only which persona ran — never which guild's domain the work was judged to fall in.
      ctx.ledger.record('guilds_inferred', {
        taskId: raw.id,
        guilds,
        primaryGuilds: primaryGuilds(guilds),
        riskClass,
        targetGlobs,
      });
    }

    ctx.ledger.record('plan_source', {
      nodeCount: rawNodes.length,
      plannerPersonaId: state.currentPlannerPersonaId,
      model: result.model,
      costUsd: result.costUsd,
    });

    this.challengeUnaddressedRisks(ctx, published, rawNodes, readPlannerSynthesis(result.value));
    this.constituteFederation(ctx, graph);
    await this.ratifyPlan(ctx, graph);
    return graph;
  }

  private planDigest(graph: TaskGraph): string {
    return digestArtifact(graph.order.map((id) => {
      const node = graph.nodes[id];
      return {
        id: node.id, title: node.title, description: node.description,
        acceptanceCriteria: node.acceptanceCriteria, dependsOn: node.dependsOn,
        targetGlobs: node.targetGlobs,
      };
    }));
  }

  private async ratifyPlan(ctx: EngineContext, graph: TaskGraph, eligibleTaskIds?: ReadonlySet<string>): Promise<void> {
    const cfg = this.cfg(ctx);
    if (!cfg.councils?.requirePlanRatification) return;
    const state = this.state(ctx);
    let councils = graph.order.filter((id) => !eligibleTaskIds || eligibleTaskIds.has(id))
      .map((id) => state.councils[id]);
    // What each council objected to last round: a council repeating it to a plan already revised
    // for it is a standing objection, and only that (or the round cap) ends the run.
    let previousObjections = new Map<string, string>();
    for (let round = 1; round <= MAX_RATIFICATION_ROUNDS; round += 1) {
      const digest = this.planDigest(graph);
      const ballots = await awaitAllOrThrow(councils.map(async (council) => {
        const node = graph.nodes[council.taskId];
        // A council saw only its own mandate, so a narrow one ("plotting.py only") read as the whole
        // application left undone, and its demand to absorb every sibling's files could never be met.
        const otherMandates = graph.order.filter((id) => id !== node.id)
          .map((id) => ({ id, title: graph.nodes[id].title, targetGlobs: graph.nodes[id].targetGlobs }));
        if (cfg.councils?.memberBallots) {
          const recorded = ctx.ledger.readAll().find((entry) => entry.type === 'council_member_ballots' &&
            entry.data.taskId === node.id && entry.data.council === council.id &&
            entry.data.planDigest === digest);
          if (recorded) {
            if (!Array.isArray(recorded.data.ballots)) throw new Error('Recorded council ballots are malformed.');
            const priorBallots = recorded.data.ballots as CouncilPlanBallot[];
            const result = tallyCouncilPlanBallots(council, priorBallots);
            return { council, ...result, positions: priorBallots.map((ballot) =>
              ({ actor: ballot.member, choice: ballot.choice })) };
          }
          const memberBallots = await awaitAllOrThrow(council.members.map(async (member): Promise<CouncilPlanBallot> => {
            const response = await ctx.dispatcher.dispatch<Omit<CouncilPlanBallot, 'member'>>({
              role: 'reviewer', phase: 'institutional', repositoryTools: false,
              personaId: member, taskId: node.id,
              institutionalReplayKey: `plan-ballot:${digest}:${council.id}:${member}`,
              reasoningEffort: 'low',
              systemPrompt: `You are an equal member of ${council.id}. Inspect the proposed work mandate. ` +
                'Vote approve when the mandate permits a testable implementation; leave routine design choices to the worker. ' +
                'Vote amend for one material, actionable correction or reject for a fundamental conflict. ' +
                `${OTHER_MANDATES_NOTE} ` +
                'State one concise correction of at most 500 characters for amend or reject; avoid exhaustive redesign. ' +
                'If the delegate concealed evidence or lost your confidence, you may initiate a separate recall motion with a concrete reason. ' +
                'Omit recallGround and recallReason entirely unless you are making that motion; do not send empty strings.',
              userPrompt: JSON.stringify({ planDigest: digest, task: {
                id: node.id, title: node.title, description: node.description,
                acceptanceCriteria: node.acceptanceCriteria, targetGlobs: node.targetGlobs,
                dependsOn: node.dependsOn,
              }, otherMandates }),
              schemaDescription: '{"choice":"approve|amend|reject|abstain","amendment":"one correction, at most 500 characters if amend or reject",' +
                '"recallGround"?:"concealed-evidence|lost-confidence","recallReason"?:"concrete reason"}',
              validate: (value) => {
                if (!value || typeof value !== 'object' ||
                  !['approve', 'amend', 'reject', 'abstain'].includes(String((value as { choice?: string }).choice)) ||
                  (['amend', 'reject'].includes(String((value as { choice?: string }).choice)) &&
                    (!String((value as { amendment?: string }).amendment ?? '').trim() ||
                      String((value as { amendment?: string }).amendment).length > 500)) ||
                  !this.validRecallMotion(value)) {
                  throw new Error('Council member must cast a valid ballot with a concrete objection.');
                }
              },
              temperature: 0.2,
            });
            return { member, ...response.value };
          }));
          await this.considerMemberRecall(ctx, council, memberBallots, digest);
          const result = tallyCouncilPlanBallots(council, memberBallots);
          ctx.ledger.record('council_member_ballots', {
            taskId: node.id, council: council.id, planDigest: digest,
            ballots: memberBallots, result: result.choice,
          });
          return { council, ...result, positions: memberBallots.map((ballot) =>
            ({ actor: ballot.member, choice: ballot.choice })) };
        }
        const result = await ctx.dispatcher.dispatch<{ choice: 'approve' | 'amend' | 'reject'; amendment?: string }>({
          role: 'reviewer',
          phase: 'institutional',
          repositoryTools: false,
          personaId: council.delegate,
          taskId: node.id,
          institutionalReplayKey: `plan-ballot:${digest}:${council.id}:${council.delegate}`,
          reasoningEffort: 'low',
          systemPrompt: `You carry ${council.id}'s instruction on its work unit. Approve the mandate, ` +
            'request one concrete amendment, or reject it for a material scope or safety objection. ' +
            `An objection is binding until this version is revised and approved. ${OTHER_MANDATES_NOTE}`,
          userPrompt: `Plan version ${digest}. Your council's task: ${JSON.stringify({
            id: node.id, title: node.title, description: node.description,
            acceptanceCriteria: node.acceptanceCriteria, targetGlobs: node.targetGlobs,
            dependsOn: node.dependsOn,
          })}. The other councils' mandates: ${JSON.stringify(otherMandates)}. Return {"choice":"approve"}, {"choice":"amend","amendment":"concrete requirement"}, ` +
            'or {"choice":"reject","amendment":"reason"}.',
          schemaDescription: '{"choice": "approve" | "amend" | "reject", "amendment"?: string}',
          validate: (value: unknown) => {
            if (typeof value !== 'object' || value === null || !('choice' in value) ||
              !['approve', 'amend', 'reject'].includes(String(value.choice)) ||
              (value.choice !== 'approve' && (!('amendment' in value) || typeof value.amendment !== 'string' || !value.amendment.trim()))) {
              throw new Error('A council must approve or state its concrete amendment or objection.');
            }
          },
          temperature: 0.2,
        });
        return { council, ...result.value, positions: [{ actor: council.delegate, choice: result.value.choice }] };
      }));
      for (const ballot of ballots) {
        recordGovernanceDecision(ctx.runState, ctx.ledger, {
          id: `plan-${ballot.council.id}-${digest.slice(0, 12)}`,
          body: ballot.council.id,
          subject: ballot.council.taskId,
          artifactDigest: digest,
          rule: cfg.councils?.memberBallots ? 'member-council-ratification-v1' : 'delegated-council-ratification-v1',
          eligible: cfg.councils?.memberBallots ? [...ballot.council.members] : [ballot.council.delegate],
          positions: ballot.positions,
          evidenceRefs: [`plan:${digest}`],
          result: ballot.choice,
          nextAction: ballot.choice === 'approve' ? 'grant-work-mandate' : 'revise-or-stop',
        });
      }
      const objections = ballots.filter((ballot) => ballot.choice !== 'approve');
      if (objections.length === 0) {
        state.ratifiedPlanDigest = digest;
        for (const council of councils) {
          const id = `work-${council.id}-${digest.slice(0, 12)}`;
          grantGovernanceMandate(ctx.runState, ctx.ledger, {
            id, grantor: council.id, holder: council.delegate, scope: [council.taskId], artifactDigest: digest,
          });
          state.councilMandateIds![council.taskId] = id;
        }
        return;
      }
      const standing = objections.filter((ballot) => previousObjections.has(ballot.council.id) &&
        sameObjection(previousObjections.get(ballot.council.id)!, ballot.amendment ?? ''));
      if (standing.length > 0 || round === MAX_RATIFICATION_ROUNDS) {
        throw new GovernanceHaltError(`Council ratification withheld: ${(standing.length ? standing : objections).map((ballot) =>
          `${ballot.council.id}: ${ballot.amendment}`).join('; ')}`);
      }
      previousObjections = new Map(objections.map((ballot) => [ballot.council.id, ballot.amendment ?? '']));
      try {
        await this.revisePlanForCouncils(ctx, graph, objections);
      } catch (error) {
        throw new GovernanceHaltError(`Council ratification withheld: ${String(error)}`);
      }
      councils = graph.order.filter((id) => !eligibleTaskIds || eligibleTaskIds.has(id))
        .map((id) => state.councils[id]);
    }
  }

  private async revisePlanForCouncils(
    ctx: EngineContext,
    graph: TaskGraph,
    objections: readonly { council: WorkerCouncil; amendment?: string }[],
  ): Promise<void> {
    const beforeDigest = this.planDigest(graph);
    const proposed = await ctx.dispatcher.dispatch<PlannerNode[] | PlannerResponse>({
      role: 'planner', personaId: this.state(ctx).currentPlannerPersonaId,
      phase: 'institutional', repositoryTools: false,
      reasoningEffort: 'low',
      systemPrompt: PLANNER_SYSTEM_PROMPT + ' The councils have withheld this graph version. Make the change each ' +
        "objection asks for in the objecting council's own task: revise its targetGlobs and dependencies for a scope " +
        'or ordering objection, and rewrite or remove its acceptanceCriteria when the objection is about a criterion ' +
        '(for example two criteria that contradict each other, or one that is not testable). Criteria the goal itself ' +
        'requires must stay; criteria this plan added may change. Preserve every required deliverable and keep the ' +
        'same task ids. A new sentence in a description is not a scope or ordering repair.',
      userPrompt: JSON.stringify({
        goal: ctx.runState.task.goal,
        currentNodes: graph.order.map((id) => {
          const node = graph.nodes[id];
          return { id, title: node.title, description: node.description, targetGlobs: node.targetGlobs,
            dependsOn: node.dependsOn, acceptanceCriteria: node.acceptanceCriteria };
        }),
        objections: objections.map((ballot) => ({ taskId: ballot.council.taskId,
          council: ballot.council.id, requiredChange: ballot.amendment })),
      }),
      schemaDescription: PLANNER_SCHEMA_DESCRIPTION,
      validate: (value) => {
        validatePlannerResponse(value);
        const nodes = normalizePlannerResponse(value);
        this.validatePlanRevision(graph, nodes);
        // An unchanged objecting task can only be withheld again, which ends the run.
        const unchanged = objections.filter((ballot) => {
          const before = graph.nodes[ballot.council.taskId];
          const after = nodes.find((node) => node.id === ballot.council.taskId);
          return after !== undefined && JSON.stringify([before.title, before.description, before.targetGlobs, before.dependsOn,
            before.acceptanceCriteria]) === JSON.stringify([after.title, after.description, after.targetGlobs,
            after.dependsOn, after.acceptanceCriteria?.length ? after.acceptanceCriteria : before.acceptanceCriteria]);
        });
        if (unchanged.length > 0) {
          throw new Error(`These tasks are unchanged, but their councils required a change: ${unchanged.map((ballot) =>
            `${ballot.council.taskId} (${ballot.amendment})`).join('; ')}. Make the change in each named task.`);
        }
      },
      temperature: 0.2,
    });
    const revised = new Map(normalizePlannerResponse(proposed.value).map((node) => [node.id, node]));
    const state = this.state(ctx);
    const hasCompletedWork = graph.order.some((id) =>
      graph.nodes[id].phase === 'settled' || graph.nodes[id].phase === 'abandoned');
    if (hasCompletedWork && graph.order.some((id) => {
      const raw = revised.get(id)!;
      const guilds = inferGuilds({ title: raw.title, description: raw.description, targetGlobs: raw.targetGlobs });
      return JSON.stringify(guilds) !== JSON.stringify(state.nodeGuilds[id]);
    })) {
      throw new Error('A legacy plan revision cannot replace council membership after completed work.');
    }
    let membershipChanged = false;
    for (const id of graph.order) {
      const raw = revised.get(id)!;
      const node = graph.nodes[id];
      const guilds = inferGuilds({ title: raw.title, description: raw.description, targetGlobs: raw.targetGlobs });
      if (JSON.stringify(guilds) !== JSON.stringify(state.nodeGuilds[id])) membershipChanged = true;
      node.title = raw.title;
      node.description = raw.description;
      node.targetGlobs = [...raw.targetGlobs];
      node.dependsOn = [...raw.dependsOn];
      node.acceptanceCriteria = raw.acceptanceCriteria?.length ? [...raw.acceptanceCriteria] : [...node.acceptanceCriteria];
      node.riskClass = classifyRiskByPaths(node.targetGlobs, {
        securityPathGlobs: this.cfg(ctx).escalateToHuman?.securityPathGlobs ?? [],
      });
      node.riskTags = guilds;
      state.nodeGuilds[id] = guilds;
      state.agreedScope[id] = [...node.targetGlobs];
    }
    // The amendment binds through the next ballot: the council votes on the revised task and
    // withholds it again if the change is not there. It used to be appended to the task as a
    // "Council amendment: ..." criterion too, which left the contradiction it asked to remove in
    // place beside it, and gave other councils an untestable criterion to object to in turn.
    for (const objection of objections) {
      ctx.ledger.record('plan_amended_by_council', {
        taskId: objection.council.taskId, council: objection.council.id,
        requirement: objection.amendment?.trim() ?? '', previousDigest: beforeDigest,
      });
    }
    if (membershipChanged) this.constituteFederation(ctx, graph);
    ctx.ledger.record('plan_revision_proposed', {
      previousDigest: beforeDigest, revisedDigest: this.planDigest(graph),
      objectingCouncils: objections.map((ballot) => ballot.council.id), model: proposed.model,
    });
  }

  private validatePlanRevision(graph: TaskGraph, nodes: readonly PlannerNode[]): void {
    const expected = new Set(graph.order);
    const proposed = new Map(nodes.map((node) => [node.id, node]));
    if (proposed.size !== expected.size || [...expected].some((id) => !proposed.has(id))) {
      throw new Error('Council plan revision must preserve every existing task id.');
    }
    const owner = new Map<string, string>();
    for (const node of nodes) {
      const existing = graph.nodes[node.id];
      const revisedCriteria = node.acceptanceCriteria?.length ? node.acceptanceCriteria : existing.acceptanceCriteria;
      if ((existing.phase === 'settled' || existing.phase === 'abandoned') && (
        existing.title !== node.title || existing.description !== node.description ||
        JSON.stringify(existing.targetGlobs) !== JSON.stringify(node.targetGlobs) ||
        JSON.stringify(existing.dependsOn) !== JSON.stringify(node.dependsOn) ||
        JSON.stringify(existing.acceptanceCriteria) !== JSON.stringify(revisedCriteria)
      )) {
        throw new Error(`Revised plan cannot change completed task ${node.id}.`);
      }
      for (const target of node.targetGlobs) {
        if (!isSafeRelativePath(target)) throw new Error(`Unsafe target path in revised plan: ${target}`);
        if (!/[?*\[\]]/.test(target)) {
          const prior = owner.get(target);
          if (prior && prior !== node.id) throw new Error(`Revised plan assigns ${target} to both ${prior} and ${node.id}.`);
          owner.set(target, node.id);
        }
      }
      for (const dependency of node.dependsOn) {
        if (!expected.has(dependency) || dependency === node.id) {
          throw new Error(`Revised task ${node.id} has an invalid dependency ${dependency}.`);
        }
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`Revised plan has a dependency cycle at ${id}.`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of proposed.get(id)!.dependsOn) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of expected) visit(id);
    const unchanged = graph.order.every((id) => {
      const old = graph.nodes[id];
      const node = proposed.get(id)!;
      return old.title === node.title && old.description === node.description &&
        JSON.stringify(old.targetGlobs) === JSON.stringify(node.targetGlobs) &&
        JSON.stringify(old.dependsOn) === JSON.stringify(node.dependsOn) &&
        JSON.stringify(old.acceptanceCriteria) === JSON.stringify(
          node.acceptanceCriteria?.length ? node.acceptanceCriteria : old.acceptanceCriteria);
    });
    if (unchanged) {
      throw new Error('Council plan revision did not change the proposed graph.');
    }
  }

  private validRecallMotion(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const motion = value as { recallGround?: unknown; recallReason?: unknown };
    const noGround = motion.recallGround === undefined ||
      (typeof motion.recallGround === 'string' && !motion.recallGround.trim());
    const noReason = motion.recallReason === undefined ||
      (typeof motion.recallReason === 'string' && !motion.recallReason.trim());
    if (noGround && noReason) return true;
    return (motion.recallGround === 'concealed-evidence' || motion.recallGround === 'lost-confidence') &&
      typeof motion.recallReason === 'string' && Boolean(motion.recallReason.trim());
  }

  private async considerMemberRecall(
    ctx: EngineContext,
    council: WorkerCouncil,
    motions: readonly { member: string; recallGround?: 'concealed-evidence' | 'lost-confidence'; recallReason?: string }[],
    artifactDigest: string,
  ): Promise<void> {
    const motion = motions.find((ballot) => ballot.recallGround && ballot.recallReason?.trim());
    if (!motion?.recallGround || !motion.recallReason) return;
    const outgoing = council.delegate;
    if (!council.members.some((member) => member !== outgoing)) {
      ctx.ledger.record('delegate_recall_unavailable', {
        council: council.id, mover: motion.member, reason: 'no eligible replacement',
      });
      return;
    }
    const ballots = await awaitAllOrThrow(council.members.map(async (member) => {
      const replayKey = `delegate-recall:${artifactDigest}:${council.id}:${outgoing}:${motion.recallGround}:${member}`;
      const systemPrompt = `You are an equal member of ${council.id}. Vote independently on the motion to recall ` +
        `${outgoing}. A recall changes who carries this council's mandate; it does not waive any evidence gate.`;
      const ballotState = { artifactDigest, delegate: outgoing, mover: motion.member,
        ground: motion.recallGround, reason: motion.recallReason };
      const decided = await decideChoice<'recall' | 'retain' | 'abstain'>(ctx, {
        personaId: member, taskId: council.taskId, institutionalReplayKey: replayKey,
        instructions: systemPrompt, state: ballotState, floor: DECISION_VOTE_FLOOR,
        options: {
          recall: `The stated ground shows ${outgoing} no longer carries the council's mandate faithfully.`,
          retain: `The ground does not justify removing ${outgoing}.`,
          abstain: 'The motion does not give enough to judge either way.',
        },
      });
      if (decided) return { member, choice: decided.choice };
      const response = await ctx.dispatcher.dispatch<{ choice: 'recall' | 'retain' | 'abstain' }>({
        role: 'reviewer', phase: 'institutional', repositoryTools: false,
        personaId: member, taskId: council.taskId,
        institutionalReplayKey: replayKey,
        reasoningEffort: 'low',
        systemPrompt,
        userPrompt: JSON.stringify(ballotState),
        schemaDescription: '{"choice":"recall|retain|abstain"}',
        validate: (value: unknown) => {
          if (!value || typeof value !== 'object' ||
            !['recall', 'retain', 'abstain'].includes(String((value as { choice?: string }).choice))) {
            throw new Error('Council recall requires an explicit ballot.');
          }
        },
        temperature: 0.1,
      });
      return { member, choice: response.value.choice };
    }));
    const carried = tallyCouncilRecallBallots(council, ballots);
    recordGovernanceDecision(ctx.runState, ctx.ledger, {
      id: `recall-${council.id}-${artifactDigest.slice(0, 12)}-${motion.recallGround}`,
      body: council.id, subject: outgoing, artifactDigest,
      rule: 'member-initiated-absolute-majority-recall-v1', eligible: [...council.members],
      positions: ballots.map((ballot) => ({ actor: ballot.member, choice: ballot.choice })),
      evidenceRefs: [`motion:${motion.member}`, `reason:${motion.recallReason}`],
      result: carried ? 'recalled' : 'retained', nextAction: carried ? 'replace-delegate' : 'retain-delegate',
    });
    if (!carried) return;
    const state = this.state(ctx);
    const recall = recallDelegate(council, motion.recallGround, seedBasis(lotSeed(ctx), this.cfg(ctx)));
    if (!recall) {
      ctx.ledger.record('delegate_recall_unfilled', { council: council.id, outgoing, ground: motion.recallGround });
      return;
    }
    if (state.coordinating) {
      state.coordinating.delegates[council.id] = recall.incoming;
      if (state.coordinating.convener === outgoing) state.coordinating.convener = recall.incoming;
    }
    const oldMandateId = state.councilMandateIds?.[council.taskId];
    if (oldMandateId && state.ratifiedPlanDigest) {
      revokeGovernanceMandate(ctx.runState, ctx.ledger, oldMandateId);
      const id = `${oldMandateId}-member-recall-${artifactDigest.slice(0, 12)}`;
      grantGovernanceMandate(ctx.runState, ctx.ledger, {
        id, grantor: council.id, holder: recall.incoming, scope: [council.taskId],
        artifactDigest: state.ratifiedPlanDigest,
      });
      state.councilMandateIds![council.taskId] = id;
    }
    state.delegateMisallocations[outgoing] = 0;
    ctx.ledger.record('delegate_recalled', { ...recall, mover: motion.member, reason: motion.recallReason });
  }

  /**
   * Article 9: councils "may challenge plans, evidence and coordinators without retaliation".
   *
   * This is where reconnaissance stops being decoration. A planner can be told to synthesise and
   * simply not, so the check is on the plan rather than on the planner's word for it: any risk a
   * council published that the plan says nothing about becomes a challenge, and the risk itself is
   * carried into the delivery as a deferred finding owned by that council. Nothing blocks — a
   * council may be wrong, and section 8 keeps ordering with the coordinating council — but the
   * disagreement survives into the record instead of being settled by silence.
   *
   * A risk the planner explicitly set aside with a reason is not a challenge. It was heard and
   * answered, which is all article 9 asks; the reason travels with the finding so a reader can
   * judge it.
   */
  private challengeUnaddressedRisks(
    ctx: EngineContext,
    published: readonly CouncilFindings[],
    nodes: readonly PlannerNode[],
    synthesis: PlannerSynthesis | undefined,
  ): void {
    if (published.length === 0) return;

    const answered = new Map<string, string>();
    for (const entry of synthesis?.setAside ?? []) answered.set(entry.finding.trim().toLowerCase(), entry.reason);

    const planText = planTextOf(
      nodes.map((n) => ({ title: n.title, description: n.description, targetGlobs: n.targetGlobs ?? [] })),
    );

    for (const challenge of unaddressedRisks(published, planText)) {
      const reason = answered.get(challenge.challenge.trim().toLowerCase());
      const carriedForward = reason === undefined;

      ctx.ledger.record('plan_challenged', {
        council: challenge.council,
        challenge: challenge.challenge,
        riskOmitted: carriedForward,
        carriedForward,
      });

      if (!carriedForward) continue;
      ctx.addFinding({
        source: `${challenge.council}-council`,
        summary: `The ${challenge.council} council's reconnaissance named a risk the plan does not address: ${challenge.challenge}`,
        evidenceRefs: [`reconnaissance:${challenge.council}`],
        disposition: 'deferred',
        owner: `${challenge.council}-council`,
        returnCondition: 'Revisit if this area is amended, or if the risk materialises during implementation.',
        dispositionRationale:
          'Raised by a council under article 9 and not taken up by the synthesised plan. Disclosed rather than blocking: ' +
          'ordering belongs to the coordinating council, but a challenge may not be answered with silence.',
      });
    }
  }

  /**
   * Section 6: a worker council forms around each unit of production, and the coordinating council
   * is composed of the delegates those councils send. Neither body exists before there is a plan to
   * organise around, so both are seated here, once the work units are known.
   *
   * Entirely deterministic and reproducible from the run id, so the register can be read back out
   * of the ledger rather than being an accident of when the run happened.
   */
  private constituteFederation(ctx: EngineContext, graph: TaskGraph): void {
    const state = this.state(ctx);
    const cfg = this.cfg(ctx);
    const seed = seedBasis(lotSeed(ctx), cfg);
    const termId = (state.coordinating?.termId ?? 0) + 1;

    const units = graph.order.map((id) => ({ taskId: id, guilds: state.nodeGuilds[id] ?? [] }));
    state.councils = constituteCouncils(units, cfg, seed, termId);
    const councils = Object.values(state.councils);
    state.coordinating = formCoordinatingCouncil({
      councils,
      termId,
      seed,
      seatedAt: state.completedTasks,
      previousConvener: state.coordinating?.convener,
    });

    ctx.ledger.record('councils_constituted', {
      termId,
      councils: councils.map((c) => `${c.id} (${c.guilds.join('+')})`),
      delegates: councils.map((c) => `${c.id}: ${c.delegate}`),
      convener: state.coordinating.convener,
      method: 'lot',
    });
  }

  async assign(ctx: EngineContext, graph: TaskGraph): Promise<Assignment[]> {
    const cfg = this.cfg(ctx);
    const state = this.state(ctx);
    if (cfg.councils?.requirePlanRatification) {
      if (state.ratifiedPlanDigest === undefined) {
        const unfinished = new Set(graph.order.filter((id) =>
          graph.nodes[id].phase !== 'settled' && graph.nodes[id].phase !== 'abandoned'));
        for (const id of graph.order) state.nodeGuilds[id] ??= inferGuilds(graph.nodes[id]);
        if (!state.coordinating || graph.order.some((id) => !state.councils[id])) {
          this.constituteFederation(ctx, graph);
        }
        await this.ratifyPlan(ctx, graph, unfinished);
        ctx.ledger.record('legacy_plan_ratified', { taskIds: [...unfinished], planDigest: state.ratifiedPlanDigest });
      }
      const digest = this.planDigest(graph);
      if (state.ratifiedPlanDigest !== digest) throw new Error('The current plan version lacks council ratification.');
      for (const nodeId of readyNodes(graph).map((node) => node.id)) {
        const council = state.councils[nodeId];
        requireGovernanceMandate(ctx.runState, state.councilMandateIds?.[nodeId] ?? '', council.delegate, digest);
      }
    }
    const ready = readyNodes(graph);
    const assignments: Assignment[] = [];
    const planVersion = this.planDigest(graph);

    for (const node of ready) {
      const preparedRecovery = state.assignments[node.id]?.recoveryReason
        ? state.assignments[node.id]
        : undefined;
      const allGuilds = state.nodeGuilds[node.id] ?? inferGuilds(node);
      state.nodeGuilds[node.id] = allGuilds;
      const primary = primaryGuilds(allGuilds);

      // Article 4: what the work needs, read from the work. Recorded before the assignment so a
      // reader can see the resourcing decision was not made to fit whoever won the node.
      const needs = assessNeeds(node, state.rejectionCounts[node.id] ?? 0, cfg);
      state.needs[node.id] = needs;
      if (cfg.allocation?.resourceEnvelopes) {
        const requested = requestedEnvelopeUsd(needs, ctx.budget.defaultTaskEnvelopeUsd());
        const existing = ctx.runState.resourceReservations?.[node.id];
        const toppedUp = existing && existing.spentUsd >= existing.limitUsd
          ? ctx.budget.topUpTask(ctx.runState, node.id, requested)
          : 0;
        const granted = existing ? existing.limitUsd : ctx.budget.reserveTask(ctx.runState, node.id, requested);
        ctx.ledger.record('resource_envelope_reserved', {
          taskId: node.id, difficulty: needs.difficulty, requestedUsd: requested, grantedUsd: granted,
          toppedUpUsd: toppedUp,
        });
        if (granted <= 0 || (existing && existing.spentUsd >= existing.limitUsd)) {
          throw new BudgetExceededError(`No uncommitted run budget remains for council-${node.id}.`, 'per_run');
        }
      }
      ctx.ledger.record('needs_assessed', {
        taskId: needs.taskId,
        difficulty: Number(needs.difficulty.toFixed(2)),
        riskClass: needs.riskClass,
        lessonBudget: needs.lessonBudget,
        aidEligible: needs.aidEligible,
        rationale: needs.rationale,
      });

      // Article 6: the smallest affected council decides, unless the dependency is genuinely federal.
      const affectedCouncils = [state.councils[node.id]?.id ?? `council-${node.id}`,
        ...node.dependsOn.filter((id) => graph.nodes[id]).map((id) => state.councils[id]?.id ?? `council-${id}`)];
      const routing = routeBySubsidiarity(node.id, [...new Set(affectedCouncils)]);
      ctx.ledger.record('subsidiarity_applied', {
        taskId: routing.taskId,
        decidedBy: routing.decidedBy,
        councils: routing.councils,
        escalated: routing.escalated,
        rationale: routing.rationale,
      });

      let leadGuild: string;
      let assigneeId: string;
      let coordinated = false;
      // Which guild leads is a property of the node under this plan version, not of the attempt:
      // a retry used to pay for the same arbitration again. The member is re-chosen from the
      // council's capability ordering, as an unescalated node's is, and never the convener.
      const arbitrated = state.coordinatedLeads?.[node.id]?.planDigest === planVersion
        ? state.coordinatedLeads[node.id].leadGuild
        : undefined;

      if (preparedRecovery) {
        leadGuild = preparedRecovery.leadGuild;
        assigneeId = preparedRecovery.assigneeId;
        coordinated = preparedRecovery.coordinated;
      } else if (!routing.escalated) {
        leadGuild = primary[0] ?? cfg.guilds[0] ?? 'backend';
        assigneeId = this.pickTopCapability(ctx, leadGuild);
      } else if (arbitrated) {
        coordinated = true;
        leadGuild = arbitrated;
        this.ensureCapabilityInitialized(ctx, leadGuild);
        assigneeId = nextAssignee(
          guildMembers(leadGuild, cfg.councils?.membersPerGuild),
          [state.coordinating?.convener ?? ''],
          state.capability[leadGuild],
        ) ?? this.pickTopCapability(ctx, leadGuild);
      } else {
        coordinated = true;
        const decided = await this.dispatchCoordinator(ctx, node, primary);
        leadGuild = decided.leadGuild;
        assigneeId = decided.assigneeId;
        state.coordinatedLeads = { ...state.coordinatedLeads, [node.id]: { leadGuild, planDigest: planVersion } };
      }

      state.assignments[node.id] = {
        assigneeId,
        leadGuild,
        allGuilds,
        coordinated,
        ...(preparedRecovery ? { recoveryReason: preparedRecovery.recoveryReason } : {}),
      };
      assignments.push({
        taskId: node.id,
        assigneeId,
        role: 'implementer',
        meta: {
          guilds: allGuilds,
          leadGuild,
          coordinated,
          ...(cfg.councils?.requirePlanRatification ? {
            authority: {
              mandateId: state.councilMandateIds?.[node.id],
              holder: state.councils[node.id].delegate,
              artifactDigest: state.ratifiedPlanDigest,
            },
          } : {}),
          ...(preparedRecovery ? { recoveryReason: preparedRecovery.recoveryReason } : {}),
        },
      });

      // "Contribution according to capability": record the scores the choice was made from, so a
      // reader can verify the assignment followed capability rather than persona identity, and can
      // see whether the guild self-finalized (federated) or needed coordinator arbitration.
      ctx.ledger.record('guild_assigned', {
        taskId: node.id,
        leadGuild,
        assigneeId,
        coordinated,
        ...(coordinated && arbitrated && !preparedRecovery ? { reusedArbitration: true } : {}),
        contendingGuilds: primary,
        capability: { ...(state.capability[leadGuild] ?? {}) },
        ...(preparedRecovery ? { recoveryReason: preparedRecovery.recoveryReason } : {}),
      });
    }
    return assignments;
  }

  private async dispatchCoordinator(
    ctx: EngineContext,
    node: TaskNode,
    primary: string[],
  ): Promise<{ leadGuild: string; assigneeId: string }> {
    for (const g of primary) this.ensureCapabilityInitialized(ctx, g);
    const state = this.state(ctx);
    const cfg = this.cfg(ctx);

    const guildInfo = primary.map((guild) => ({
      guild,
      members: guildMembers(guild).map((personaId) => ({ personaId, capability: state.capability[guild][personaId] })),
    }));

    const result = await this.coordinatorDecision(ctx, node, primary, guildInfo) ?? await ctx.dispatcher.dispatch<CoordinatorResponse>({
      role: 'generalist',
      personaId: 'coordinator',
      phase: 'institutional',
      repositoryTools: false,
      systemPrompt: COORDINATOR_SYSTEM_PROMPT,
      userPrompt: buildCoordinatorPrompt(node, guildInfo),
      schemaDescription: COORDINATOR_SCHEMA_DESCRIPTION,
      validate: makeValidateCoordinatorResponse(primary),
      temperature: 0.1,
      reasoningEffort: 'low',
    });

    const { leadGuild, assigneeId } = result.value;
    const members = guildMembers(leadGuild, cfg.councils?.membersPerGuild);
    const councilPreference = this.pickTopCapability(ctx, leadGuild);
    let finalAssignee = members.includes(assigneeId) ? assigneeId : councilPreference;

    // Article 6, checked against what the coordinator says it decided. A delegated body that
    // settles which approach is correct has taken the council's own discretion, and section 8 draws
    // the line in as many words: it "owns ordering, not technical truth". The matter goes straight
    // back to the council, which here means the deterministic capability ordering the node would
    // have used had it never been escalated.
    const convener = state.coordinating?.convener ?? 'coordinating-council';
    const breach = checkMandate(
      { taskId: node.id, subject: result.value.subject.trim().toLowerCase(), councilsAffected: primary.length, decidedBy: convener },
      cfg,
    );
    if (breach) {
      state.mandateBreaches.push(breach);
      state.delegateMisallocations[convener] = (state.delegateMisallocations[convener] ?? 0) + 1;
      finalAssignee = councilPreference;
      ctx.ledger.record('mandate_breach', {
        body: breach.body,
        taskId: breach.taskId,
        decision: breach.decision,
        article: breach.article,
        remedy: breach.remedy,
      });
    }

    // Section 6: coordinators "cannot approve their own consequential decisions". A convener that
    // arbitrates a collision and hands itself the work has done exactly that.
    const withoutSelf = withoutSelfAllocation(convener, finalAssignee, councilPreference);
    if (withoutSelf.overrodeSelfAllocation) {
      state.delegateMisallocations[convener] = (state.delegateMisallocations[convener] ?? 0) + 1;
    }
    finalAssignee = withoutSelf.assigneeId;

    ctx.ledger.record('coordinator_arbitration', {
      taskId: node.id,
      contendingGuilds: primary,
      leadGuild,
      assigneeId: finalAssignee,
      // Surfaced because the coordinator holds only delegated authority: a reader must be able to
      // see when its named assignee was overridden by the guild's own capability ordering.
      overrodeCoordinatorAssignee: finalAssignee !== assigneeId,
      rationale: result.value.rationale,
      model: result.model,
    });

    return { leadGuild, assigneeId: finalAssignee };
  }

  /**
   * The coordinator's arbitration as three decisions over the same state: which guild leads, which
   * member implements, and what the arbitration actually settles. Taken only when all three are
   * decisive; the assignee and mandate checks in dispatchCoordinator apply to it unchanged.
   */
  private async coordinatorDecision(
    ctx: EngineContext,
    node: TaskNode,
    primary: string[],
    guildInfo: { guild: string; members: { personaId: string; capability: number }[] }[],
  ): Promise<{ value: CoordinatorResponse; model: string } | undefined> {
    const answers = await decideQuestions(ctx, {
      personaId: 'coordinator',
      taskId: node.id,
      state: { task: { title: node.title, description: node.description, targetPaths: node.targetGlobs }, guilds: guildInfo },
      confidenceFloor: DECISION_VOTE_FLOOR,
      questions: {
        leadGuild: {
          type: 'choice',
          instructions: `${COORDINATOR_SYSTEM_PROMPT} Which guild should lead this task?`,
          criteria: Object.fromEntries(primary.map((guild) => [guild, `The ${guild} guild's domain carries most of this task.`])),
        },
        assigneeId: {
          type: 'choice',
          instructions: 'Which member should be the primary implementer? Prefer higher demonstratedCapability when members are otherwise comparable.',
          criteria: Object.fromEntries(guildInfo.flatMap((g) => g.members.map((m) => [m.personaId,
            `${m.personaId} of the ${g.guild} guild (demonstratedCapability ${m.capability.toFixed(2)}).`]))),
        },
        subject: {
          type: 'choice',
          instructions: 'What does this arbitration actually settle?',
          criteria: {
            ordering: 'Which guild goes first or leads.',
            interface: 'A shared interface between the guilds.',
            'scarce-resource': 'Allocation of a scarce resource.',
            'technical-approach': 'Which approach or algorithm is correct, which belongs to the council, not the coordinator.',
          },
        },
      },
    });
    if (answers?.leadGuild?.type !== 'choice' || answers.assigneeId?.type !== 'choice' || answers.subject?.type !== 'choice') {
      return undefined;
    }
    return {
      value: {
        leadGuild: answers.leadGuild.choice,
        assigneeId: answers.assigneeId.choice,
        subject: answers.subject.choice,
        rationale: `Decided by decision model: lead ${summariseAnswer(answers.leadGuild)}; subject ${summariseAnswer(answers.subject)}.`,
      },
      model: 'decision-model',
    };
  }

  async execute(ctx: EngineContext, assignment: Assignment): Promise<WorkProduct> {
    const node = ctx.runState.graph!.nodes[assignment.taskId];
    const state = this.state(ctx);
    const guilds = state.assignments[assignment.taskId]?.allGuilds ?? state.nodeGuilds[assignment.taskId] ?? [];
    // Model tier is looked up purely by node.riskClass (via classifyRiskByPaths at plan() time),
    // identical regardless of which persona won the assignment — "resources according to need,
    // not status". config/models.yaml only defines one 'implementer' tier today, so in practice
    // this means: never branch which role/model we dispatch to based on the assignee's identity.
    const riskClass = node.riskClass;

    // Section 6: a worker may hand back work it cannot take safely, and the council offers it to
    // the next member rather than pressing the same one. Bounded by allocation.returnsBeforeReplan,
    // because a node the whole council declines is not a worker problem — it is a planning one, and
    // re-offering it round the room forever would be the "endless rescue of an unsuitable
    // assignment" section 14 warns about.
    const cfg = this.cfg(ctx);
    const members = guildMembers(
      state.assignments[assignment.taskId]?.leadGuild ?? guilds[0] ?? 'backend',
      cfg.councils?.membersPerGuild,
    );
    const maxReturns = returnsBeforeReplan(cfg);

    // Whatever the mutual-aid worker published for this node on an earlier attempt. Aid that never
    // reaches the next worker is a report filed about a blockage, not help with it.
    const aid = state.aid[assignment.taskId] ? renderAid(state.aid[assignment.taskId]) : '';
    const recoveryReason = typeof assignment.meta?.recoveryReason === 'string'
      ? `The council handed this work to you after diagnosing the prior failure: ${assignment.meta.recoveryReason}`
      : '';
    // The attempt just rejected — its code, failing checks and review findings — reaches the worker
    // through the engine's repair brief, so a current draft adds nothing here. A draft rejected
    // under an earlier plan version, or before remediation reopened the node (which clears the
    // brief), no longer describes the work: the worker is told so, and what that rejection required
    // goes with it, since it may still be unresolved and is otherwise lost.
    const prior = state.reworkDrafts?.[assignment.taskId];
    const priorDraft = !prior || (prior.planDigest === this.planDigest(ctx.runState.graph!) && !prior.superseded)
      ? ''
      : `An earlier attempt at this node was rejected before ${prior.superseded
        ? 'remediation reopened it' : 'the plan was revised'}. Its file operations no longer apply and ` +
        `the current worktree is authoritative, but what that rejection required may still be ` +
        `unresolved: ${prior.requiredChanges.join('; ')}`;
    const recoverySupport = [recoveryReason, aid, priorDraft].filter(Boolean).join('\n\n');

    let assigneeId = assignment.assigneeId;
    let result = await this.dispatchImplementer(ctx, node, guilds, assigneeId, riskClass, recoverySupport);

    for (let handedBack = 0; handedBack < maxReturns; handedBack += 1) {
      const returned = readAssignmentReturn(result.value);
      if (!returned) break;

      const declined = [...(state.returnedBy[assignment.taskId] ?? []), assigneeId];
      state.returnedBy[assignment.taskId] = declined;

      const leadGuild = state.assignments[assignment.taskId]?.leadGuild ?? guilds[0] ?? 'backend';
      this.ensureCapabilityInitialized(ctx, leadGuild);
      const next = nextAssignee(members, declined, state.capability[leadGuild] ?? {});

      ctx.ledger.record('assignment_returned', {
        taskId: assignment.taskId,
        workerId: assigneeId,
        reason: returned.reason,
        reallocatedTo: next ?? '(nobody — the council has no one left to offer it to)',
      });

      if (!next) break;
      assigneeId = next;
      if (state.assignments[assignment.taskId]) state.assignments[assignment.taskId].assigneeId = next;
      result = await this.dispatchImplementer(ctx, node, guilds, assigneeId, riskClass, recoverySupport);
    }

    const stillReturned = readAssignmentReturn(result.value);
    if (stillReturned) {
      // Every worker offered it declined. Article 11: the cause is diagnosed, not charged to
      // whoever happened to be holding it last — so this node is marked a planning defect and its
      // final assignee's capability score is left alone in recordOutcome().
      if (!state.planningDefects.includes(assignment.taskId)) state.planningDefects.push(assignment.taskId);
      ctx.ledger.record('assignment_returned', {
        taskId: assignment.taskId,
        workerId: assigneeId,
        reason: stillReturned.reason,
        reallocatedTo: '(returned to the councils as a planning defect)',
      });
    }

    // What the work actually wrote, as distinct from what it said it wrote. The file operations are
    // what reach the worktree, so they are what section 8's convergence comparison reads.
    state.touchedPaths[assignment.taskId] = (result.value.fileOps as FileOp[]).map((op) => op.path);

    // "Transparent accounting": every task records inputs, files changed and unresolved uncertainty.
    ctx.ledger.record('work_executed', {
      taskId: assignment.taskId,
      assigneeId,
      guilds,
      riskClass,
      filesChanged: result.value.filesChanged,
      fileOpCount: result.value.fileOps.length,
      unresolvedUncertainty: result.value.unresolvedUncertainty,
      model: result.model,
    });

    return {
      taskId: assignment.taskId,
      assignment: { ...assignment, assigneeId },
      fileOps: result.value.fileOps as FileOp[],
      rationale: result.value.rationale,
      unresolvedUncertainty: stillReturned
        ? `The council returned this work rather than attempting it: ${stillReturned.reason}`
        : result.value.unresolvedUncertainty,
      meta: { filesChanged: result.value.filesChanged, model: result.model, guilds, returned: Boolean(stillReturned) },
    };
  }

  private dispatchImplementer(
    ctx: EngineContext,
    node: TaskNode,
    guilds: string[],
    assigneeId: string,
    riskClass: TaskNode['riskClass'],
    aid = '',
  ) {
    return ctx.dispatcher.dispatch<ImplementerResponse>({
      role: 'implementer',
      taskId: node.id,
      personaId: assigneeId,
      systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
      userPrompt: buildImplementerPrompt(ctx.runState.task, node, guilds, assigneeId, riskClass, aid),
      schemaDescription: IMPLEMENTER_SCHEMA_DESCRIPTION,
      validate: validateImplementerResponse,
      temperature: IMPLEMENTER_TEMPERATURE,
    });
  }

  /**
   * A peer from outside the authorship chain.
   *
   * `nominated` is the guild section 6 lets speak first on high-risk work, and it has to outrank the
   * lead guild or the nomination decides nothing: the work's own guild would always answer for it,
   * which is exactly the arrangement a nomination exists to override.
   */
  private pickReviewer(
    cfg: SocialistConfig,
    nodeGuilds: string[],
    leadGuild: string,
    assigneeId: string,
    nominated: string | null = null,
    allocatedBy?: string,
  ): { personaId: string; guild: string } {
    const preferred = nominated ? [nominated] : [];
    const ordered = [
      ...preferred,
      leadGuild,
      ...nodeGuilds.filter((g) => g !== leadGuild),
      ...cfg.guilds.filter((g) => !nodeGuilds.includes(g)),
    ].filter((g, i, all) => all.indexOf(g) === i);
    for (const guild of ordered) {
      // Neither the author nor the coordinator who allocated the node: section 6 forbids the
      // latter approving its own decision, and with two members a guild otherwise always handed
      // the review straight back to the convener (a breach in every socialist arm on 2026-10-04).
      const other = guildMembers(guild).find((m) => m !== assigneeId && m !== allocatedBy);
      if (other) return { personaId: other, guild };
    }
    // Unreachable in practice (every guild has 2 distinct members), but keep review() total.
    return { personaId: `${leadGuild}-2`, guild: leadGuild };
  }

  async review(ctx: EngineContext, product: WorkProduct, test: TestResult): Promise<ReviewResult> {
    const cfg = this.cfg(ctx);
    const state = this.state(ctx);
    const node = ctx.runState.graph!.nodes[product.taskId];
    const assignInfo = state.assignments[product.taskId];
    const guilds = assignInfo?.allGuilds ?? state.nodeGuilds[product.taskId] ?? [];
    const leadGuild = assignInfo?.leadGuild ?? guilds[0] ?? cfg.guilds[0] ?? 'backend';
    const assigneeId = assignInfo?.assigneeId ?? product.assignment.assigneeId;

    // Structurally exclude the implementer's own persona from the reviewer pool. On high-risk work
    // the guild whose discipline carries the risk nominates first (section 6), so a security-
    // sensitive change is not reviewed by whoever merely happened to be free.
    const nominated = nominatingGuild(node, guilds);
    const allocatedBy = assignInfo?.coordinated ? state.coordinating?.convener : undefined;
    const reviewer = this.pickReviewer(cfg, guilds, leadGuild, assigneeId, nominated, allocatedBy);

    // Article 4: how much of the commons this review draws is set by what the work needs, not by
    // who holds it. A hard or repeatedly-failed node gets more history to work from.
    const needs = state.needs[product.taskId];
    const tags = [...new Set([...guilds, node.riskClass, ...titleKeywords(node.title)])];
    const lessons = ctx.knowledge.queryByTags(tags, needs?.lessonBudget ?? 5);

    const reviewPrompt = buildReviewerPrompt(node, product, test, lessons, reviewer,
      state.reworkDrafts?.[product.taskId]?.requiredChanges);
    const result = await ctx.dispatcher.dispatch<ReviewerResponse>({
      role: 'reviewer',
      taskId: product.taskId,
      personaId: reviewer.personaId,
      systemPrompt: REVIEWER_SYSTEM_PROMPT,
      userPrompt: reviewPrompt,
      schemaDescription: REVIEWER_SCHEMA_DESCRIPTION,
      validate: validateReviewerResponse,
      temperature: 0.2,
    });

    // Article 8 is checked at acceptance against what actually happened, so the chain is recorded
    // here rather than asserted later.
    state.approvals.push({
      taskId: product.taskId,
      implementerId: assigneeId,
      reviewerId: reviewer.personaId,
      allocatedBy,
    });

    // "Collective verification": records that the reviewer is a different persona from the
    // implementer, plus which shared-knowledge lessons ("mutual aid") informed the review.
    ctx.ledger.record('peer_review', {
      taskId: product.taskId,
      reviewerId: reviewer.personaId,
      reviewerGuild: reviewer.guild,
      implementerId: assigneeId,
      verdict: result.value.verdict,
      rationale: result.value.rationale,
      lessonsConsidered: lessons.map((l) => l.id),
      test: { ran: test.ran, passed: test.passed },
      model: result.model,
    });

    return {
      taskId: product.taskId,
      findings: [
        {
          reviewerId: reviewer.personaId,
          verdict: result.value.verdict,
          rationale: result.value.rationale,
          evidenceRefs: result.value.evidenceRefs,
        },
      ],
      testResult: test,
      meta: { reviewerGuild: reviewer.guild, lessonsConsidered: lessons.map((l) => l.id) },
    };
  }

  async decide(ctx: EngineContext, product: WorkProduct, review: ReviewResult): Promise<Decision> {
    const cfg = this.cfg(ctx);
    const state = this.state(ctx);
    const node = ctx.runState.graph!.nodes[product.taskId];
    const blockingFinding = review.findings.find((reviewFinding) => reviewFinding.verdict === 'reject');
    const finding = blockingFinding ?? review.findings[0];
    const testsPassed = review.testResult?.passed ?? false;

    // Section 7 stage 7 and section 10: "Reviewers distinguish blocking correctness problems from
    // optional improvements, preserve minority objections and approve only the state they actually
    // inspected." The reviewer schema has offered three verdicts from the start while the decision
    // treated two of them identically, which collapsed that distinction and made a preserved
    // objection impossible — a dissent either stopped the work or never existed.
    //
    // A reject blocks. A flag does not: the council proceeds and the objection is recorded against
    // the decision (article 9). Tests are not subject to the same distinction — section 9's rule 10
    // is that "a failed material test reopens the work", so a flag over failing tests still blocks.
    const blocked = Boolean(blockingFinding) || finding === undefined;
    const dissented = finding?.verdict === 'flag';
    const baseApproved = !blocked && testsPassed;

    if (!baseApproved) {
      const count = (state.rejectionCounts[product.taskId] ?? 0) + 1;
      state.rejectionCounts[product.taskId] = count;
      if (!state.failedTaskIds.includes(product.taskId)) state.failedTaskIds.push(product.taskId);
    } else {
      state.rejectionCounts[product.taskId] = 0;
      delete state.reworkDrafts?.[product.taskId];
      // Aid answered the block that just cleared; a later reopening is a different block. It stays
      // in the commons for whoever meets the same wall.
      delete state.aid[product.taskId];
    }

    const rejectionCount = state.rejectionCounts[product.taskId] ?? 0;

    // Section 11: escalation reaches Claude, and through it the human, only "for ambiguity in user
    // intent, unacceptable safety risk or a decision outside the swarm's authority". High-risk
    // (security-sensitive) work is the safety case, so it is never auto-applied even when review and
    // tests are green. Repeated rejection is not: section 10 answers it with diagnosis, mutual aid
    // and reassignment inside the councils, which recover() carries out, and the engine's shared
    // attempt ceiling ends a task that still cannot be delivered as a recorded terminal failure.
    const escalate = node.riskClass === 'high';

    let rationale = baseApproved
      ? dissented
        ? `Tests passed and reviewer ${finding?.reviewerId} flagged rather than blocked; the council proceeds and the objection is recorded as a minority report.`
        : `Reviewer ${finding?.reviewerId} approved and tests passed.`
      : `Reviewer ${blockingFinding?.reviewerId ?? finding?.reviewerId ?? 'unknown'} ` +
        `verdict=${blockingFinding?.verdict ?? finding?.verdict ?? 'none'} (testsPassed=${testsPassed}); rejection #${rejectionCount}. ` +
        `Reviewer rationale: ${blockingFinding?.rationale ?? finding?.rationale ?? 'No rationale was recorded.'}`;

    if (escalate) {
      rationale += ' Escalated to human: task touches a high-risk (security-sensitive) path.';
      ctx.openApproval({
        kind: 'final_diff',
        taskId: product.taskId,
        description: `Task "${node.title}" needs human sign-off: ${rationale}`,
      });

      if (!baseApproved && !state.publishedTaskIds.includes(product.taskId)) {
        this.publishFailureLesson(ctx, product, review);
      }
    }

    // Article 9. An objection the council decided against is the one a summary would smooth away,
    // so it is entered as a finding here and travels to the delivery packet as a minority report.
    // `baseApproved` and nothing else. A high-risk node escalates to a human even when the reviewer
    // rejected it, and calling that "the council proceeded over the objection" would misdescribe a
    // reviewer whose objection is precisely why a human is being asked.
    if (baseApproved) {
      for (const report of minorityReportsFrom({
        taskId: product.taskId,
        nodeTitle: node.title,
        approved: true,
        review,
        implementerId: product.assignment.assigneeId,
      })) {
        ctx.addFinding(report);
      }
    }

    const decisionBase = {
      taskId: product.taskId,
      rationale,
      evidenceRefs: blockingFinding?.evidenceRefs ?? finding?.evidenceRefs ?? [],
      meta: { baseApproved, reviewerId: blockingFinding?.reviewerId ?? finding?.reviewerId, rejectionCount },
    };

    if (escalate) return { ...decisionBase, outcome: 'needs_human' };
    if (baseApproved) return { ...decisionBase, outcome: 'approved' };

    return {
      ...decisionBase,
      outcome: 'rework',
      rework: { requiredChanges: reworkRequirements(review, review.testResult ?? { ran: false, passed: false }) },
    };
  }

  async recover(ctx: EngineContext, request: RecoveryRequest): Promise<void> {
    const state = this.state(ctx);
    state.reworkDrafts![request.product.taskId] = {
      planDigest: this.planDigest(ctx.runState.graph!),
      requiredChanges: [...request.decision.rework.requiredChanges],
    };
    const deterministic = classifyCause(this.failureSignals(ctx, request));
    // Here a diagnosis is read for one thing: whether to hand the work to someone else. With no
    // one left in the guild to take it, its answer could change nothing, so it is not paid for.
    // Neither it nor aid reads the other's result, so they run side by side.
    const successor = this.reassignmentCandidate(ctx, request.product);
    const [diagnosis] = await Promise.all([
      successor ? this.resolveRecoveryDiagnosis(ctx, { request, deterministic }) : deterministic,
      this.supplyMutualAid(ctx, request),
    ]);

    // A reassignment's diagnosis explains the failure before it, and assign() copies it forward on
    // every pass: replaced when this failure warrants another handover, dropped otherwise, so it is
    // never presented as current after the new worker failed too.
    if (successor && diagnosis.confident && (diagnosis.cause === 'implementation' || diagnosis.cause === 'allocation')) {
      this.prepareReassignment(ctx, request.product, successor, diagnosis);
    } else if (state.assignments[request.product.taskId]) {
      delete state.assignments[request.product.taskId].recoveryReason;
    }

    if (!request.repeated) {
      this.publishFailureLesson(ctx, request.product, request.review);
    }
  }

  private failureSignals(ctx: EngineContext, request: RecoveryRequest): FailureSignals {
    const state = this.state(ctx);
    const taskId = request.product.taskId;
    const node = ctx.runState.graph!.nodes[taskId];
    const returned = state.returnedBy[taskId] ?? [];
    const reviewChecksRan = request.review.testResult?.ran ?? request.test.ran;

    return {
      taskId,
      checksRan: request.test.ran && reviewChecksRan,
      hasCriteria: node.acceptanceCriteria.length > 0,
      wasReturned: returned.length > 0 || request.product.meta?.returned === true,
      returnedByAll: state.planningDefects.includes(taskId),
      survivedReassignment: state.reassignments.some(
        (reassignment) => reassignment.taskId === taskId && reassignment.to === request.product.assignment.assigneeId,
      ),
      atBarrier: false,
    };
  }

  private async resolveRecoveryDiagnosis(
    ctx: EngineContext,
    input: { request: RecoveryRequest; deterministic: CauseFinding },
  ): Promise<CauseFinding> {
    const { request, deterministic } = input;
    if (!diagnosisDue(request.attemptNumber, deterministic, this.cfg(ctx))) return deterministic;

    const reviewerRecord = request.review.findings.length > 0
      ? request.review.findings
          .map((finding) => `${finding.reviewerId} ${finding.verdict}: ${finding.rationale}`)
          .join('; ')
      : 'No independent reviewer finding was recorded.';
    const checkRecord = request.test.ran
      ? `Checks ${request.test.passed ? 'passed' : 'failed'}: ${request.test.output || 'no output recorded'}`
      : 'The checks did not run.';

    // The council's required changes are not repeated here: they restate these findings and name
    // these checks, so the diagnostician would read each one twice.
    return this.commissionIndependentDiagnosis(ctx, {
      taskId: request.product.taskId,
      attempts: request.attemptNumber,
      deterministic,
      history: [
        reviewerRecord,
        checkRecord,
        request.repeated ? 'The engine found this attempt materially identical to the previous one.' : 'The failure differs materially from the previous attempt.',
      ],
    });
  }

  /** The guild member who has neither held nor returned this node, if one remains. */
  private reassignmentCandidate(ctx: EngineContext, product: WorkProduct): string | null {
    const state = this.state(ctx);
    const assignment = state.assignments[product.taskId];
    if (!assignment) return null;

    const members = guildMembers(assignment.leadGuild, this.cfg(ctx).councils?.membersPerGuild);
    const excluded = [
      product.assignment.assigneeId,
      ...(state.returnedBy[product.taskId] ?? []),
      ...state.reassignments
        .filter((reassignment) => reassignment.taskId === product.taskId)
        .flatMap((reassignment) => [reassignment.from, reassignment.to]),
    ];
    return nextAssignee(members, excluded, state.capability[assignment.leadGuild] ?? {});
  }

  private prepareReassignment(ctx: EngineContext, product: WorkProduct, next: string, diagnosis: CauseFinding): void {
    const state = this.state(ctx);
    const assignment = state.assignments[product.taskId];
    const recoveryReason = `${diagnosis.cause}: ${diagnosis.rationale}`;
    state.assignments[product.taskId] = {
      ...assignment,
      assigneeId: next,
      recoveryReason,
    };
    state.reassignments.push({
      taskId: product.taskId,
      from: product.assignment.assigneeId,
      to: next,
      cause: recoveryReason,
    });
  }

  private publishFailureLesson(ctx: EngineContext, product: WorkProduct, review: ReviewResult): void {
    const state = this.state(ctx);
    const node = ctx.runState.graph!.nodes[product.taskId];
    const finding = review.findings.find((reviewFinding) => reviewFinding.verdict === 'reject') ?? review.findings[0];
    const testsPassed = review.testResult?.passed ?? false;
    const guilds = state.assignments[product.taskId]?.allGuilds ?? state.nodeGuilds[product.taskId] ?? [];
    const tags = [...new Set([...guilds, node.riskClass, 'rejection'])];

    ctx.knowledge.add(
      {
        kind: 'lesson',
        tags,
        sourceRunId: ctx.runId,
        sourceTaskId: product.taskId,
        content:
          `Task "${node.title}" was not approved (reviewer verdict=${finding?.verdict ?? 'none'}, testsPassed=${testsPassed}). ` +
          `Reviewer rationale: ${finding?.rationale ?? 'n/a'}. Implementer's unresolved uncertainty: ${product.unresolvedUncertainty ?? 'none'}.`,
      },
      `${ctx.runId}-${product.taskId}-${Date.now()}`,
      new Date().toISOString(),
    );
    if (!state.publishedTaskIds.includes(product.taskId)) state.publishedTaskIds.push(product.taskId);
    state.contributions.push(`lesson:${tags.join('+')}`);
    ctx.ledger.record('commons_contribution', {
      kind: 'lesson',
      tags,
      contributorId: product.assignment.assigneeId,
      taskId: product.taskId,
    });
  }

  /**
   * Section 6's mutual-aid function, summoned when a worker is actually blocked.
   *
   * One dispatch, and only on a block, so a clean run pays nothing for it. What comes back is
   * published to the commons rather than handed privately to the worker who asked — articles 2 and
   * 7 — and is passed into the next attempt at the node, because aid that never reaches the next
   * worker is a report about a blockage rather than help with it.
   *
   * A failed aid dispatch is not fatal. The node simply proceeds without help, which is where it
   * already was.
   */
  private async supplyMutualAid(ctx: EngineContext, request: RecoveryRequest): Promise<void> {
    const cfg = this.cfg(ctx);
    const state = this.state(ctx);
    const { product, review } = request;
    const node = ctx.runState.graph!.nodes[product.taskId];

    const wasReturned = (state.returnedBy[product.taskId] ?? []).length > 0;
    const rejectionCount = state.rejectionCounts[product.taskId] ?? 0;
    const due = aidIsDue(
      { needs: state.needs[product.taskId], rejections: rejectionCount, wasReturned },
      cfg,
    );
    const aidThreshold = cfg.mutualAid?.rejectionsBeforeAid ?? SOCIALIST_DEFAULTS.mutualAid.rejectionsBeforeAid;
    const crossedAidThreshold = aidThreshold > 0 && request.attemptNumber === aidThreshold;
    const repeatsExistingAid = Boolean(state.aid[product.taskId]) && request.repeated && !crossedAidThreshold;
    if (!due || repeatsExistingAid) return;

    const guilds = state.assignments[product.taskId]?.allGuilds ?? state.nodeGuilds[product.taskId] ?? [];
    const tags = aidTags(guilds, node.riskClass, titleKeywords(node.title));
    const finding = review.findings[0];
    // The aid must name a fixture or command, which it cannot do from "tests failed" alone: it gets
    // the same evidence the next implementer will, from the engine's brief when there is one.
    const evidence = request.brief
      ? renderRepairBrief(request.brief).trim()
      : request.test.output ? `Check output:\n${clipCheckOutput(request.test.output, 1_800)}` : '';
    const whatHappened =
      `Reviewer verdict: ${finding?.verdict ?? 'none'} — ${finding?.rationale ?? 'no rationale recorded'}. ` +
      `Tests ${request.test.ran ? (request.test.passed ? 'passed' : 'failed') : 'did not run'}. ` +
      `The worker's own unresolved uncertainty: ${product.unresolvedUncertainty || 'none stated'}.` +
      (evidence ? `\n\n${evidence}` : '');

    try {
      const result = await ctx.dispatcher.dispatch<AidPacket>({
        role: 'generalist',
        personaId: 'mutual-aid',
        phase: 'institutional',
        repositoryTools: false,
        systemPrompt: mutualAidSystemPrompt(),
        userPrompt: mutualAidUserPrompt(node, product.assignment.assigneeId, whatHappened, ctx.knowledge.queryByTags(tags, 3)),
        schemaDescription: MUTUAL_AID_SCHEMA_DESCRIPTION,
        validate: validateAidPacket,
        temperature: 0.2,
        reasoningEffort: 'low',
        timeoutMs: 60_000,
      });

      const packet: AidPacket = {
        context: result.value.context,
        fixture: result.value.fixture,
        priorAttempts: result.value.priorAttempts,
      };
      state.aid[product.taskId] = packet;

      const entry = aidAsCommonsEntry(packet, {
        taskId: product.taskId,
        nodeTitle: node.title,
        tags,
        runId: ctx.runId,
      });
      ctx.knowledge.add(entry, `${ctx.runId}-aid-${product.taskId}-${Date.now()}`, new Date().toISOString());
      state.contributions.push(`fixture:${tags.join('+')}`);

      ctx.ledger.record('mutual_aid_supplied', {
        taskId: product.taskId,
        requesterId: product.assignment.assigneeId,
        aiderId: 'mutual-aid',
        kind: wasReturned ? 'returned-assignment' : 'repeated-rejection',
        fixtures: [packet.fixture],
        model: result.model,
      });
      ctx.ledger.record('commons_contribution', {
        kind: entry.kind,
        tags: entry.tags,
        contributorId: 'mutual-aid',
        taskId: product.taskId,
      });
    } catch {
      // The node proceeds without help, which is where it already was — but not with aid written
      // for an earlier failure presented as the answer to this one.
      delete state.aid[product.taskId];
    }
  }

  async recordOutcome(ctx: EngineContext, decision: Decision, _test: TestResult): Promise<void> {
    const state = this.state(ctx);
    if (this.cfg(ctx).allocation?.resourceEnvelopes) ctx.budget.releaseTask(ctx.runState, decision.taskId);
    const assignInfo = state.assignments[decision.taskId];
    state.completedTasks += 1;

    // Article 11: "blame may not substitute for diagnosis and repair." A node every eligible worker
    // handed back is a defect in the plan, and moving its final holder's score would charge the
    // planning failure to whoever was unlucky enough to be offered it last.
    const planningDefect = state.planningDefects.includes(decision.taskId);

    if (assignInfo && !planningDefect) {
      const { assigneeId, leadGuild } = assignInfo;
      this.ensureCapabilityInitialized(ctx, leadGuild);
      const current = state.capability[leadGuild][assigneeId];
      const delta = decision.outcome === 'approved'
        ? 0.05
        : decision.outcome === 'rejected' || decision.outcome === 'rework'
          ? -0.05
          : 0;
      const updated = clamp(current + delta, 0, 1);
      state.capability[leadGuild][assigneeId] = updated;

      ctx.ledger.record('capability_updated', {
        taskId: decision.taskId,
        assigneeId,
        guild: leadGuild,
        outcome: decision.outcome,
        before: current,
        after: updated,
        delta,
      });
    }

    // A failed check establishes a defect, not its author. Planner attribution waits for the
    // diagnosis in remediate(); only a verified success resets the consecutive pattern.
    if (decision.outcome === 'approved') state.plannerFailureCount = 0;

    this.recallMisallocatingDelegates(ctx);
    this.rotateIfTermExpired(ctx);
  }

  /**
   * Section 11: a council may recall its delegate for "repeatedly misallocating work".
   *
   * Counted only in allocations that had to be taken back — a mandate breach or a self-allocation —
   * so a delegate is never recalled for work it routed correctly and someone else then failed at.
   * The count resets with the seat, because the ground attaches to the delegate's conduct, not to
   * the council's history.
   */
  private recallMisallocatingDelegates(ctx: EngineContext): void {
    const cfg = this.cfg(ctx);
    const state = this.state(ctx);
    const seed = seedBasis(lotSeed(ctx), cfg);

    for (const [persona, count] of Object.entries(state.delegateMisallocations)) {
      if (!misallocationRecallDue(count, cfg)) continue;
      const council = Object.values(state.councils).find((c: WorkerCouncil) => c.delegate === persona);
      if (!council) continue;

      const ground: RecallGround = 'misallocated-work';
      const recall = recallDelegate(council, ground, seed);
      state.delegateMisallocations[persona] = 0;
      if (!recall) continue;

      if (state.coordinating) {
        state.coordinating.delegates[council.id] = recall.incoming;
        // The convener holds no separate seat: it chairs as one of the delegates, so recalling it
        // as a delegate ends its chairmanship too rather than leaving a recalled agent in the chair.
        if (state.coordinating.convener === recall.outgoing) state.coordinating.convener = recall.incoming;
      }
      const oldMandateId = state.councilMandateIds?.[council.taskId];
      if (oldMandateId && state.ratifiedPlanDigest) {
        revokeGovernanceMandate(ctx.runState, ctx.ledger, oldMandateId);
        const id = `${oldMandateId}-recall-${state.completedTasks}`;
        grantGovernanceMandate(ctx.runState, ctx.ledger, {
          id, grantor: council.id, holder: recall.incoming, scope: [council.taskId],
          artifactDigest: state.ratifiedPlanDigest,
        });
        state.councilMandateIds![council.taskId] = id;
      }
      ctx.ledger.record('delegate_recalled', {
        council: recall.council,
        outgoing: recall.outgoing,
        incoming: recall.incoming,
        ground: recall.ground,
      });
    }
  }

  /** Article 5: the mandate is temporary. When the term is up the delegates reform and the chair moves. */
  private rotateIfTermExpired(ctx: EngineContext): void {
    const cfg = this.cfg(ctx);
    const state = this.state(ctx);
    if (!state.coordinating || !termExpired(state.completedTasks, state.coordinating, cfg)) return;

    const councils = Object.values(state.councils);
    if (councils.length === 0) return;

    const previous = state.coordinating;
    state.coordinating = rotateCoordinatingCouncil(previous, councils, seedBasis(lotSeed(ctx), cfg), state.completedTasks);
    ctx.ledger.record('rotation_recorded', {
      termId: state.coordinating.termId,
      rotated: [previous.convener],
      into: state.coordinating.convener,
      method: 'lot',
    });
  }

  requiresHumanApproval(_ctx: EngineContext, decision: Decision): boolean {
    return decision.outcome === 'needs_human';
  }

  // ---------- acceptance barriers ----------

  /**
   * The public dependency and stewardship map of section 8. Stewardship follows the guilds a node
   * touches, so the map records which guilds answer for which paths and which paths more than one
   * work unit intends to edit — declared in advance rather than discovered as a collision.
   */
  async declareOwnership(ctx: EngineContext, graph: TaskGraph): Promise<OwnershipMap> {
    const state = this.state(ctx);
    return runOwnershipDeclaration(ctx, graph, {
      interfacesFor: (entry) => (state.nodeGuilds?.[entry.taskId] ?? []).map((g) => `guild:${g}`),
      overlapRationale: 'Declared common stewardship: several work units in the shared plan name this path.',
    });
  }

  /** Section 10: "an integration council reviews the aggregate tree… Isolated successes do not
   * satisfy the shared plan when their combination is broken." */
  async integrate(ctx: EngineContext, approvedTaskIds: string[], diffText: string): Promise<IntegrationResult> {
    const result = await runIntegrationBarrier(ctx, approvedTaskIds, diffText, {
      integratorId: 'integration-council',
      systemPrompt: integrationCouncilSystemPrompt(),
      buildUserPrompt: integrationCouncilUserPrompt,
    });
    return { ...result, findings: this.underSafetyFloor(ctx, result.findings, result.integratorId) };
  }

  /**
   * Section 10: "Delivery remains blocked wherever an unresolved item violates an acceptance
   * criterion, safety floor, or other non-waivable obligation", and section 11: urgency "cannot
   * waive non-negotiable safety checks". What the councils find on the combined product on such a
   * ground is marked so no disposition can defer it; accept() then refuses delivery while it is open.
   */
  private underSafetyFloor<T extends DraftFinding>(ctx: EngineContext, findings: T[], raisedBy: string): T[] {
    const marked = markNonWaivableFindings(findings, SAFETY_FLOOR_ARTICLE);
    if (marked.grounds.length > 0) {
      ctx.ledger.record('safety_floor_applied', { raisedBy, article: SAFETY_FLOOR_ARTICLE, grounds: marked.grounds });
    }
    return marked.findings;
  }

  /** An independent peer from outside the authorship chain. Section 9: "Reviewer assignments rotate
   * back into implementation: independence for a change must never create a permanent QA caste." */
  async verifyDelivery(ctx: EngineContext, draft: DeliveryPacket): Promise<VerificationResult> {
    const verified = await runVerificationBarrier(ctx, draft, {
      verifierId: 'peer-verifier',
      systemPrompt: peerVerifierSystemPrompt(),
      buildUserPrompt: peerVerifierUserPrompt,
    });
    const result = { ...verified, findings: this.underSafetyFloor(ctx, verified.findings, verified.verifierId) };
    // disposeFindings does not receive the draft packet, and section 9 requires the commons report
    // to name every skipped check with its reason. Stashed here, where they are first available.
    this.state(ctx).finalChecks = draft.finalChecks;
    return result;
  }

  async disposeFindings(ctx: EngineContext, open: Finding[]): Promise<Finding[]> {
    if (open.length === 0) return [];
    const { diffText } = await ctx.worktree.diff();

    const result = await ctx.dispatcher.dispatch<WireDispositionReport>({
      role: 'reviewer',
      personaId: 'common-ledger',
      phase: 'institutional',
      systemPrompt: ledgerDispositionSystemPrompt(),
      userPrompt: ledgerDispositionUserPrompt(
        open.map((f) => ({ id: f.id, source: f.source, summary: f.summary, evidenceRefs: f.evidenceRefs })),
        truncateDiff(diffText, diffBudget(ctx)),
      ),
      schemaDescription: dispositionSchemaDescription,
      validate: validateDispositionReport,
      temperature: 0.2,
    });

    const disposed = applyDispositions(open, result.value.dispositions);

    // Article 9, applied to the step where dissent is most easily lost.
    const retention = retainMinorityReports(open, disposed);
    if (retention.retained.length > 0) {
      ctx.ledger.record('minority_report_preserved', {
        findingIds: retention.retained,
        preservedBy: 'common-ledger',
        article: 'article-9',
      });
    }
    this.fileCommonsReport(ctx, retention.findings);
    return retention.findings;
  }

  /**
   * Articles 2 and 7: the run accounts for itself to the commons.
   *
   * Filed here rather than in accept() because assembleDelivery reads these notes before accept()
   * runs — a report written there would be built into nothing, and the run would look like it had
   * accounted for itself while disclosing none of this.
   */
  private fileCommonsReport(ctx: EngineContext, findings: readonly Finding[]): void {
    const cfg = this.cfg(ctx);
    const state = this.state(ctx);

    const implementers = [...new Set(state.approvals.map((a) => a.implementerId))];
    const reviewers = [...new Set(state.approvals.map((a) => a.reviewerId))];

    const report = buildCommonsReport({
      findings,
      finalChecks: state.finalChecks ?? [],
      contributions: state.contributions,
      failedTaskIds: state.failedTaskIds,
      publishedTaskIds: state.publishedTaskIds,
      planningDefects: state.planningDefects,
      productiveDuty: productiveDutyMet(state.coordinating?.convener ?? '', implementers, reviewers, cfg),
      unrotatedReviewers: unrotatedReviewers(implementers, reviewers),
      delegateConcentration: delegateConcentration(state.coordinating?.delegates ?? {}),
    });

    ctx.ledger.record('commons_report', {
      published: report.published,
      unresolved: report.unresolved,
      lessons: report.lessons,
      skippedChecks: report.skippedChecks,
      limitations: report.limitations,
    });

    // Replaced, never appended to. A remediation cycle files a fresh account of the run as it now
    // stands; accumulating them would repeat every limitation in the manifest, so a run that went
    // round the loop three times would read as three times as compromised as it is.
    state.deliveryNotes = toDeliveryNotes(report);
  }

  /**
   * The councils' recorded acceptance decision. Deterministic by design: section 9 states that
   * "correctness is a common obligation and cannot be voted into existence", and that evidence
   * "overrides rank, majority preference, eloquence and schedule pressure".
   */
  async accept(ctx: EngineContext, draft: DeliveryPacket): Promise<DoctrineAcceptance> {
    const blockers: string[] = [];

    if (!draft.integrationEvidence.integrated) {
      blockers.push(`the integration council did not accept the common tree (${draft.integrationEvidence.rationale})`);
    }
    if (!draft.independentVerification.verified) {
      blockers.push(`independent peer verification failed (${draft.independentVerification.rationale})`);
    }
    const untraced = draft.acceptanceCriteria.filter(
      (c) => !draft.independentVerification.criteriaTraced.some((t) => t.trim() === c.trim()),
    );
    if (untraced.length > 0) {
      blockers.push(`${untraced.length} acceptance criterion/criteria could not be traced to evidence`);
    }
    const failing = blockingFailures(draft.finalChecks, ctx.checks);
    if (failing.length > 0) {
      blockers.push(`required check(s) still failing: ${failing.map((f) => f.categoryId).join(', ')}`);
    }
    const nonWaivableOpen = draft.findings.filter(
      (f) => f.nonWaivable && f.disposition !== 'accepted' && f.disposition !== 'rejected',
    );
    if (nonWaivableOpen.length > 0) {
      blockers.push(`${nonWaivableOpen.length} finding(s) on non-waivable ground remain open`);
    }

    // The assembly of producers ratifies, and the constitution is checked against what actually
    // happened rather than against anyone's account of it. These are the three articles that can be
    // read straight off the run's own record.
    const state = this.state(ctx);
    const breaches = [
      ...selfApprovalBreaches(
        state.approvals,
        draft.integrationEvidence?.integratorId,
        draft.independentVerification?.verifierId,
      ).map((b) => `${b.roles.join(' + ')} held by ${b.personaId} on ${b.taskId}: ${b.remedy}`),
      ...monopolyBreaches({
        convener: state.coordinating?.convener ?? '',
        delegates: state.coordinating?.delegates ?? {},
        integratorId: draft.integrationEvidence?.integratorId,
        verifierId: draft.independentVerification?.verifierId,
      }).map((b) => `${b.personaId} holds ${b.holdings.join(' + ')}: ${b.remedy}`),
      ...blameWithoutDiagnosis(state.reassignments).map(
        (taskId) => `"${taskId}" was taken off its worker with no diagnosed cause (article 11).`,
      ),
    ];
    if (breaches.length > 0) {
      blockers.push(`${breaches.length} constitutional breach(es): ${breaches.join('; ')}`);
    }
    ctx.ledger.record('constitutional_gate', {
      accepted: breaches.length === 0,
      breaches,
      articles: ['article-8', 'article-10', 'article-11'],
    });

    let authorityProof: DoctrineAcceptance['authorityProof'];
    if (blockers.length === 0 && this.cfg(ctx).councils?.requirePlanRatification) {
      const artifactDigest = deliveryGovernanceDigest(draft);
      const councils = Object.values(state.councils);
      const votes = await awaitAllOrThrow(councils.map(async (council) => {
        const voters = this.cfg(ctx).councils?.memberBallots ? council.members : [council.delegate];
        const positions = await awaitAllOrThrow(voters.map(async (member) => {
          const result = await ctx.dispatcher.dispatch<{
            choice: 'approve' | 'reject' | 'abstain'; reason: string;
            recallGround?: 'concealed-evidence' | 'lost-confidence'; recallReason?: string;
          }>({
            role: 'reviewer', phase: 'institutional', repositoryTools: false,
            personaId: member, taskId: council.taskId,
            institutionalReplayKey: `delivery-ballot:${artifactDigest}:${council.id}:${council.termId}:${member}`,
            reasoningEffort: 'low',
            systemPrompt: `You are a ${this.cfg(ctx).councils?.memberBallots ? 'member' : 'delegate'} of ${council.id}. ` +
              'Decide whether to accept the final delivery on recorded evidence. Do not waive failed checks or unresolved risks. ' +
              'If the delegate concealed evidence or lost your confidence, you may initiate a separate recall motion with a concrete reason. ' +
              'Omit recallGround and recallReason entirely unless you are making that motion; do not send empty strings.',
            userPrompt: `Final artifact ${artifactDigest}. Integration: ${draft.integrationEvidence.rationale}. ` +
              `Independent verification: ${draft.independentVerification.rationale}. ` +
              `Checks: ${JSON.stringify(draft.finalChecks)}. Open findings: ${JSON.stringify(draft.findings)}. ` +
              `Your work: ${council.taskId}. Return {"choice":"approve"|"reject"|"abstain","reason":"evidence-based explanation"}.`,
            schemaDescription: '{"choice":"approve" | "reject" | "abstain", "reason": string,' +
              '"recallGround"?:"concealed-evidence|lost-confidence","recallReason"?:"concrete reason"}',
            validate: (value: unknown) => {
              if (typeof value !== 'object' || value === null || !('choice' in value) ||
                !['approve', 'reject', 'abstain'].includes(String(value.choice)) ||
                !('reason' in value) || typeof value.reason !== 'string' || !value.reason.trim() ||
                !this.validRecallMotion(value)) {
                throw new Error('Council acceptance requires a position and evidence-based reason.');
              }
            },
            temperature: 0.1,
          });
          return { member, ...result.value };
        }));
        if (this.cfg(ctx).councils?.memberBallots) {
          await this.considerMemberRecall(ctx, council, positions, artifactDigest);
        }
        const result = this.cfg(ctx).councils?.memberBallots
          ? tallyCouncilAcceptance(council, positions)
          : positions[0];
        return { council, ...result, positions: positions.map((position) =>
          ({ actor: position.member, choice: position.choice })) };
      }));
      const decisionIds: string[] = [];
      for (const vote of votes) {
        const decisionId = `delivery-${vote.council.id}-${artifactDigest.slice(0, 12)}`;
        recordGovernanceDecision(ctx.runState, ctx.ledger, {
          id: decisionId,
          body: vote.council.id,
          subject: vote.council.taskId,
          artifactDigest,
          rule: this.cfg(ctx).councils?.memberBallots
            ? 'member-council-majority-acceptance-v1' : 'delegated-council-unanimous-acceptance-v1',
          eligible: this.cfg(ctx).councils?.memberBallots ? [...vote.council.members] : [vote.council.delegate],
          positions: vote.positions,
          evidenceRefs: ['integration-evidence', 'independent-verification', 'final-checks'],
          result: vote.choice,
          nextAction: vote.choice === 'approve' ? 'accept-delivery' : 'return-delivery',
        });
        decisionIds.push(decisionId);
        if (vote.choice !== 'approve') blockers.push(`${vote.council.id} ${vote.choice}: ${vote.reason}`);
      }
      authorityProof = { artifactDigest, decisionIds, action: 'accept-delivery' };
    }

    const accepted = blockers.length === 0;
    ctx.ledger.record('council_acceptance', { accepted, blockers });
    return {
      accepted,
      procedure: "councils' collective acceptance decision on reproducible evidence",
      rationale: accepted
        ? 'The councils accept: the common tree integrated, an independent peer verified every acceptance criterion against evidence, and required checks pass.'
        : `The councils report the work incomplete rather than accepting it: ${blockers.join('; ')}.`,
      decidedAt: new Date().toISOString(),
      ...(authorityProof ? { authorityProof } : {}),
    };
  }

  /**
   * Section 11: failed work "returns to the responsible council with evidence… Repeated failure
   * triggers fresh ownership or coordinator recall rather than concealment or endless retries."
   * So a second remediation cycle on the same work reassigns it rather than asking the same
   * worker to try again.
   */
  async remediate(ctx: EngineContext, packet: RemediationPacket): Promise<TaskGraph> {
    const graph = ctx.runState.graph!;
    const state = this.state(ctx);
    const cfg = this.cfg(ctx);
    const named = new Set(packet.findings.flatMap((f) => f.affectedTaskIds ?? []));
    const targets = named.size > 0 ? [...named].filter((id) => graph.nodes[id]) : graph.order;
    const summary = remediationNote(packet.findings);
    const reassigned: string[] = [];

    // Section 11's order: the cause is established before the remedy is chosen. Article 11 makes
    // that binding — "blame may not substitute for diagnosis and repair" — so a reassignment,
    // which is the swarm asserting the worker was the problem, may not happen without one. Each
    // node's diagnosis reads only that node's record, so they are commissioned together.
    const notes = targets.map((id) => remediationNote(packet.findings, id));
    const causes = await Promise.all(targets.map((id, index) => this.diagnose(ctx, id, packet.cycle, notes[index])));

    for (const [index, id] of targets.entries()) {
      graph.nodes[id].phase = 'queued';
      // Whatever draft the node kept from an earlier attempt was rejected before this evidence
      // existed, so execute() may no longer present it as the attempt just rejected. The same goes
      // for aid written for that attempt, and for the arbitration that routed it.
      const draft = state.reworkDrafts?.[id];
      if (draft) draft.superseded = true;
      delete state.aid[id];
      delete state.coordinatedLeads?.[id];

      const cause = causes[index];
      if (cause.cause === 'specification' && cause.confident) {
        state.plannerFailureCount += 1;
      } else if (cause.cause !== 'specification' && cause.confident) {
        state.plannerFailureCount = 0;
      }
      this.hearAppeal(ctx, id, graph.nodes[id]);

      // The directive is what the reopened worker reads: this task's findings with their evidence,
      // the cause when one was actually established (the residual guess is not a finding), and the
      // diagnosis recover() prepared, which the reallocation below would otherwise discard (on the
      // first cycle the kept assignment still carries it to execute()).
      const preparedReason = packet.cycle > 1 ? state.assignments?.[id]?.recoveryReason : undefined;
      graph.nodes[id].remediationOf = [
        notes[index],
        cause.confident ? `Diagnosed cause (${cause.cause}): ${cause.rationale}` : '',
        preparedReason ? `Diagnosis of the prior failure: ${preparedReason}` : '',
      ].filter(Boolean).join('\n\n');

      if (packet.cycle > 1 && state.assignments?.[id]) {
        const from = state.assignments[id].assigneeId;
        reassigned.push(id);
        state.reassignments.push({ taskId: id, from, to: '(reallocated by the council)', cause: cause.cause });
        delete state.assignments[id];
        state.rejectionCounts[id] = 0;
      }

      // Section 14's retry limit. Beyond it the work is re-scoped rather than attempted again, and
      // the failure is disclosed as one rather than buried under another round.
      if (retryLimitReached(packet.cycle, cfg)) {
        ctx.addFinding({
          source: 'coordinating-council',
          taskId: id,
          summary: `"${graph.nodes[id].title}" reached the councils' retry limit after ${packet.cycle} cycles. Diagnosed cause: ${cause.cause}.`,
          evidenceRefs: [`diagnosis:${id}`],
          disposition: 'unresolved',
          dispositionRationale:
            `${cause.rationale} Section 14 sets a retry limit so mutual support does not become endless rescue of an ` +
            'unsuitable plan; the work is disclosed as unfinished rather than attempted again.',
        });
      }
    }

    ctx.ledger.record('work_returned_to_councils', {
      cycle: packet.cycle,
      taskIds: targets,
      reassigned,
      findings: packet.findings.map((f) => f.summary),
    });
    const recallThreshold = cfg.recall?.consecutivePlannerFailuresBeforeSwap ?? SOCIALIST_DEFAULTS.recall.consecutivePlannerFailuresBeforeSwap;
    if (recallThreshold > 0 && state.plannerFailureCount >= recallThreshold) {
      await this.recallPlannerAndReplan(ctx, graph, summary, targets);
      state.plannerFailureCount = 0;
    }
    return graph;
  }

  private async recallPlannerAndReplan(
    ctx: EngineContext,
    graph: TaskGraph,
    findings: string,
    targets: readonly string[],
  ): Promise<void> {
    const state = this.state(ctx);
    const from = state.currentPlannerPersonaId;
    const to = from === 'planner-1' ? 'planner-2' : 'planner-1';
    if (state.plannerMandateId) revokeGovernanceMandate(ctx.runState, ctx.ledger, state.plannerMandateId);
    const task = {
      ...ctx.runState.task,
      repoPath: ctx.runState.repoPath,
      baseBranch: ctx.runState.baseBranch,
    };
    const taskDigest = digestArtifact({ goal: task.goal, acceptanceCriteria: task.acceptanceCriteria });
    const mandateId = `planner-${to}-${taskDigest.slice(0, 12)}-recall-${state.completedTasks}`;
    grantGovernanceMandate(ctx.runState, ctx.ledger, {
      id: mandateId, grantor: 'coordinating-council', holder: to,
      scope: ['revise-unfinished-work'], artifactDigest: taskDigest,
    });
    state.plannerMandateId = mandateId;
    state.currentPlannerPersonaId = to;
    const unfinished = targets.filter((id) => graph.nodes[id]?.phase === 'queued');
    const previous = unfinished.map((id) => ({
      id, description: graph.nodes[id].description,
      acceptanceCriteria: graph.nodes[id].acceptanceCriteria,
      targetGlobs: graph.nodes[id].targetGlobs,
    }));
    const sameScope = (left: readonly string[], right: readonly string[]) =>
      JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
    const response = await ctx.dispatcher.dispatch<PlannerNode[] | PlannerResponse>({
      role: 'planner',
      personaId: to,
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      userPrompt: `${buildPlannerPrompt(task, findings)}\nRevise only these unfinished node IDs within their existing path scope: ` +
        `${JSON.stringify(previous)}. Preserve their IDs and exact declared target path sets. ` +
        'Do not add generated check outputs, stray artifacts, or .gitignore to any task scope. ' +
        'Diagnosed specification defects require clearer descriptions or acceptance criteria.',
      schemaDescription: PLANNER_SCHEMA_DESCRIPTION,
      validate: (value: unknown) => {
        validatePlannerResponse(value);
        const candidate = new Map(normalizePlannerResponse(value as PlannerNode[] | PlannerResponse)
          .map((node) => [node.id, node]));
        for (const id of unfinished) {
          const revision = candidate.get(id);
          if (!revision) throw new Error(`Replacement planner omitted unfinished task ${id}.`);
          if (!sameScope(revision.targetGlobs, graph.nodes[id].targetGlobs)) {
            throw new Error(`Replacement planner changed ${id}'s agreed path scope. ` +
              `Keep exactly ${JSON.stringify(graph.nodes[id].targetGlobs)}; generated outputs and stray ` +
              'artifacts are check side effects, not task targets.');
          }
        }
      },
      temperature: 0.2,
    });
    const revisions = new Map(normalizePlannerResponse(response.value).map((node) => [node.id, node]));
    if (unfinished.some((id) => !revisions.has(id))) {
      throw new Error('The replacement planner omitted unfinished work from its revision.');
    }
    for (const id of unfinished) {
      const revision = revisions.get(id)!;
      if (!sameScope(revision.targetGlobs, graph.nodes[id].targetGlobs)) {
        throw new Error(`Replacement planner changed ${id}'s agreed path scope.`);
      }
      graph.nodes[id].description = revision.description;
      graph.nodes[id].acceptanceCriteria = revision.acceptanceCriteria?.length
        ? revision.acceptanceCriteria : graph.nodes[id].acceptanceCriteria;
    }
    ctx.ledger.record('planner_recall', {
      from, to, taskIds: unfinished, reason: 'diagnosed-specification-failures',
      oldPlanDigest: digestArtifact(previous), newPlanDigest: this.planDigest(graph),
    });
    for (const id of Object.values(state.councilMandateIds ?? {})) {
      revokeGovernanceMandate(ctx.runState, ctx.ledger, id);
    }
    state.councilMandateIds = {};
    state.ratifiedPlanDigest = undefined;
    await this.ratifyPlan(ctx, graph);
  }

  /**
   * Establishes why a node keeps failing, before anything is done about it.
   *
   * The deterministic pass answers most cases from the record, for nothing. It is also willing to
   * return "implementation" marked unconfident — the residual answer — and that, plus repeated
   * failure, is the one case worth a dispatch. Blaming the worker is the cheapest conclusion
   * available and the easiest to be wrong about, so it is the one the swarm pays to check.
   */
  private async diagnose(ctx: EngineContext, taskId: string, cycle: number, findings: string): Promise<CauseFinding> {
    const cfg = this.cfg(ctx);
    const state = this.state(ctx);
    const node = ctx.runState.graph!.nodes[taskId];

    const returned = state.returnedBy[taskId] ?? [];
    const deterministic = classifyCause({
      taskId,
      checksRan: (ctx.runState.baseline ?? []).some((b) => b.ran),
      hasCriteria: (node.acceptanceCriteria ?? []).length > 0,
      wasReturned: returned.length > 0,
      returnedByAll: state.planningDefects.includes(taskId),
      survivedReassignment: state.reassignments.some((r) => r.taskId === taskId),
      atBarrier: false,
    });

    if (!diagnosisDue(cycle, deterministic, cfg)) return deterministic;

    const history = [
      `${cycle} remediation cycles.`,
      `${state.rejectionCounts[taskId] ?? 0} consecutive rejections.`,
      returned.length > 0 ? `Handed back by: ${returned.join(', ')}.` : 'No worker handed it back.',
      state.aid[taskId] ? `Mutual aid was supplied: ${state.aid[taskId].context}` : 'No mutual aid was supplied.',
      // What reopened the node, with its evidence: without it the diagnostician saw only counts.
      findings ? `The evidence that reopened it:\n${findings}` : 'No finding was recorded against this node.',
    ];

    return this.commissionIndependentDiagnosis(ctx, {
      taskId,
      attempts: cycle,
      deterministic,
      history,
    });
  }

  private async commissionIndependentDiagnosis(
    ctx: EngineContext,
    input: { taskId: string; attempts: number; deterministic: CauseFinding; history: string[] },
  ): Promise<CauseFinding> {
    const node = ctx.runState.graph!.nodes[input.taskId];

    try {
      const result = await ctx.dispatcher.dispatch<Diagnosis>({
        role: 'reviewer',
        personaId: 'independent-diagnostician',
        phase: 'institutional',
        systemPrompt: diagnosisSystemPrompt(),
        userPrompt: diagnosisUserPrompt(
          node,
          input.attempts,
          input.history,
          `${input.deterministic.cause} — ${input.deterministic.rationale}`,
        ),
        schemaDescription: DIAGNOSIS_SCHEMA_DESCRIPTION,
        validate: validateDiagnosis,
        temperature: 0.2,
        reasoningEffort: 'low',
        timeoutMs: 60_000,
      });

      ctx.ledger.record('independent_diagnosis', {
        taskId: input.taskId,
        cause: result.value.cause,
        diagnostician: 'independent-diagnostician',
        remedy: result.value.remedy,
        confident: result.value.confident,
        model: result.model,
      });
      // The diagnostician's own confidence, not the fact that it answered: an unconfident answer
      // is a better-informed default, and must not license a reassignment or a planner recall.
      return { cause: result.value.cause, confident: result.value.confident, rationale: result.value.rationale };
    } catch {
      return input.deterministic;
    }
  }

  /**
   * Section 11: "A council may appeal a decision that changes its agreed scope or violates the
   * constitution to a temporary, independently selected review panel."
   *
   * Deterministic throughout. Both grounds are recorded facts, and an appeal decided by asking a
   * model whether it sympathises would be an appeal decided on rhetoric — which section 9 rules out
   * in as many words.
   */
  private hearAppeal(ctx: EngineContext, taskId: string, node: TaskNode): void {
    const cfg = this.cfg(ctx);
    const state = this.state(ctx);
    const council = state.councils[taskId];
    if (!council || state.appealsHeard.includes(taskId)) return;

    const breaches = state.mandateBreaches.filter((b) => b.taskId === taskId).map((b) => b.remedy);
    const input = {
      taskId,
      appellant: council.id,
      agreedScope: state.agreedScope[taskId] ?? node.targetGlobs ?? [],
      touchedPaths: state.touchedPaths[taskId] ?? [],
      breaches,
    };
    if (!appealGround(input)) return;

    // Outside the affected council and outside the authorship chain — independence is structural
    // here, not a claim about anyone's impartiality.
    const excluded = [...council.members, ...(state.returnedBy[taskId] ?? []), state.coordinating?.convener ?? ''];
    const pool = [...new Set(guildRoster(cfg).flatMap((g) => guildMembers(g, cfg.councils?.membersPerGuild)))];
    const panel = convenePanel(pool, excluded, 2, `${seedBasis(lotSeed(ctx), cfg)}:appeal:${taskId}`);

    const appeal = hearAppeal(input, panel, cfg);
    state.appealsHeard.push(appeal.taskId);
    ctx.ledger.record('appeal_panel_convened', {
      taskId: appeal.taskId,
      appellant: appeal.appellant,
      panel: appeal.panel,
      granted: appeal.granted,
      rationale: appeal.rationale,
    });
  }
}
