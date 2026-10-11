import {
  evidenceMandateUserPrompt,
  evidenceSchemaDescription,
  toEvidenceItems,
  evidenceMandateValidator,
  type WireEvidenceMandate,
} from '../evidenceMandate.js';
import type { EngineContext, RecoveryRequest, SwarmStrategy } from '../../engine/SwarmStrategy.js';
import { emptyGraph, addNode, readyNodes } from '../../engine/TaskGraph.js';
import { classifyRiskByPaths } from '../../engine/risk.js';
import { awaitAllOrThrow } from '../../util/awaitAll.js';
import { digestArtifact, grantGovernanceMandate, nextGovernanceDecisionId, recordGovernanceDecision, requireGovernanceMandate, revokeGovernanceMandate } from '../../engine/governance.js';
import { separationOfFunctionsBreaches } from './constitution.js';
import type {
  Assignment,
  Decision,
  ReviewFinding,
  ReviewResult,
  TaskGraph,
  TaskSpec,
  TestResult,
  WorkProduct,
} from '../../engine/types.js';
import {
  committeeSchemaDescription,
  committeeSystemPrompt,
  committeeUserPrompt,
  governmentReplySchemaDescription,
  governmentReplySystemPrompt,
  governmentReplyUserPrompt,
  houseOfReviewSchemaDescription,
  houseOfReviewSystemPrompt,
  houseOfReviewUserPrompt,
  validateGovernmentReply,
  validateHouseOfReviewReport,
  implementerSchemaDescription,
  implementerSystemPrompt,
  implementerUserPrompt,
  oppositionSchemaDescription,
  oppositionSystemPrompt,
  oppositionUserPrompt,
  plannerSchemaDescription,
  plannerSystemPrompt,
  plannerUserPrompt,
  speakerSchemaDescription,
  speakerSystemPrompt,
  speakerUserPrompt,
  toEngineFileOps,
  validateCommitteeVerdict,
  validateImplementerOutput,
  validateOppositionOutput,
  validatePlannerOutput,
  validateSpeakerRuling,
  type ImplementerWireOutput,
} from './prompts.js';
import {
  testMandateSystemPrompt,
  commonsVerifierSystemPrompt,
  coordinatorBallotSchemaDescription,
  coordinatorBallotSystemPrompt,
  speakerDecisionQuestions,
  speakerDecisionState,
  coordinatorBallotUserPrompt,
  commonsVerifierUserPrompt,
  dispositionSystemPrompt,
  dispositionUserPrompt,
  integrationCommitteeSystemPrompt,
  integrationCommitteeUserPrompt,
} from './prompts.js';
import {
  applyDispositions,
  dispositionSchemaDescription,
  renderCheckSummary,
  diffBudget, truncateDiff,
  validateDispositionReport,
  type WireDispositionReport,
} from '../barriers.js';
import {
  runIntegrationBarrier,
  runOwnershipDeclaration,
  runVerificationBarrier,
} from '../barrierPipeline.js';
import type {
  DeliveryPacket,
  DoctrineAcceptance,
  Finding,
  IntegrationResult,
  OwnershipMap,
  RemediationPacket,
  VerificationResult,
} from '../../engine/packets.js';
import { blockingFailures } from '../../engine/checks.js';
import { classifyMotionClass, classifyThresholdCategory, committeeApproveScore, computeVote } from './vote.js';
import { DECISION_VOTE_FLOOR, decideCandidateBallot, decideQuestions, decideVote, summariseAnswer } from '../decisions.js';
import { computeQuestionTime } from './questionTime.js';
import { reportToTheHouse, toDeliveryNotes } from './accountability.js';
import { logger } from '../../util/logger.js';
import { lotSeed } from '../../util/lots.js';
import { remediationNote } from '../../engine/remediationNote.js';
import { isTestPath } from '../../engine/testIntegrity.js';
import {
  appointsCoordinator,
  authorisesEmergencyRollback,
  authorisesTaskAttemptRollback,
  preservesCharter,
  refusesInstruction,
  type ReservePowerExercise,
} from './ceremonialHead.js';
import {
  applyRevisingReport,
  shouldConvene,
  type RevisingReport,
} from './houseOfReview.js';
import {
  assessCollectiveResponsibility,
  confidenceMotionDue,
  ministerFor,
  putConfidenceMotion,
  replaceMinister,
  tallyConfidenceBallots,
  type ConfidenceBallot,
} from './cabinet.js';
import {
  prepareAlternativeProgramme,
  replyCitesEvidence,
  replyIsDue,
  severityAfterReply,
  shadowMinisterFor,
  type GovernmentReply,
} from './opposition.js';
import {
  callDivision,
  divisionShare,
  engagedConstituencies,
  expressedDivision,
  tallyAmendmentBallots,
  tallyChamberSupermajority,
  misrepresentations,
  type Division,
} from './commons.js';
import {
  restoreIfPaperEmpty,
  retainMinorityReports,
  screenMotions,
  amendOverlappingMandates,
  type AdmissibilityRuling,
} from './speaker.js';
import {
  candidatesFor,
  constituencyList,
  constituteOffices,
  performanceScore,
  readOfficePerformance,
  recallRepresentative,
  recordOfficePerformance,
  repairSeparationBreaches,
  rotateOffices,
  shouldRotate,
  tallyElection,
  type CandidateBallot,
  type OfficeRegister,
} from './offices.js';
import type {
  CommitteeFinding,
  DemocraticAssignmentMeta,
  DemocraticConfig,
  DemocraticStrategyState,
  Motion,
  MotionClass,
  OppositionFinding,
  PlannerOutput,
} from './types.js';
import { scopedRemediationTargets, compactRemediationRegister } from './remediationRegister.js';
import { IMPLEMENTER_TEMPERATURE } from '../implementerReminders.js';
import { DEMOCRATIC_DEFAULTS } from '../../constitution/schema.js';
import { carries } from '../../constitution/rules.js';

/** Loose path-like-token extractor: catches things like "auth/login.js" in free text so this
 * strategy's risk classification doesn't depend entirely on the planner LLM remembering to put
 * every mentioned path into a motion's targetGlobs — it's a defensive supplement, not a
 * replacement, so it never removes anything the LLM did list. */
function extractPathHints(text: string): string[] {
  const matches = text.match(/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+\.[a-zA-Z0-9]+/g);
  return matches ?? [];
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items.filter((s) => s.trim().length > 0)));
}

function asDemocraticConfig(ctx: EngineContext): DemocraticConfig {
  return ctx.config as unknown as DemocraticConfig;
}

function asStrategyState(ctx: EngineContext): DemocraticStrategyState {
  return ctx.strategyState as DemocraticStrategyState;
}

type RecordedDivision = NonNullable<DemocraticStrategyState['divisions']>[string];

function oppositionRejectedOutright(division: RecordedDivision | undefined): boolean {
  return division?.oppositionVerdict === 'reject' && division.oppositionSeverity !== 'low';
}

function frozenElectorate(state: DemocraticStrategyState, cfg: DemocraticConfig): string[] {
  return (state.electorate ??= state.offices
    ? Object.keys(state.offices.representatives)
    : constituencyList(cfg));
}

function isCloseDivision(division: RecordedDivision | undefined): boolean {
  const ayes = division?.ayes ?? 0;
  const noes = division?.noes ?? 0;
  return ayes > 0 && Math.abs(ayes - noes) <= 1;
}

function repairRequirements(
  meta: DemocraticAssignmentMeta,
  review: ReviewResult,
  test: TestResult,
): string[] {
  // Names only. The failing output reaches the implementer once, through the engine's repair brief,
  // identically for every doctrine; a close division used to get its own copy here that a
  // non-close one did not.
  const failingChecks = test.checks?.length
    ? test.checks.map((check) => check.status === 'new'
      ? `Fix the new verification failure: ${check.categoryId}`
      : `Make the required check pass: ${check.categoryId} (still failing)`)
    : (test.newFailures ?? []).map((failure) => `Fix the new verification failure: ${failure}`);
  const unnamed = !test.passed && test.ran && failingChecks.length === 0
    ? [`Make ${test.command ? `"${test.command}"` : 'the recorded verification'} pass.`]
    : [];

  return dedupe([...governanceRequirements(meta, review), ...failingChecks, ...unnamed]);
}

/** What the House said about a defeated attempt: committee and Opposition objections and the
 * minister's reply. Never check output — the engine's repair brief carries that. */
function governanceRequirements(meta: DemocraticAssignmentMeta, review: ReviewResult): string[] {
  // A carried authorisation was judged at the first sitting, before any code existed. Replayed as
  // a required change on every later attempt, it asked each one to answer the same plan-stage
  // remark again; only a sitting held for this attempt speaks to it.
  const committee = meta.committeeCarried ? [] : meta.committeeFindings
    .filter((finding) => finding.verdict === 'reject' || finding.verdict === 'flag')
    .map((finding) => `Address ${finding.personaId}'s committee finding: ${finding.rationale}`);
  const opposition = review.findings
    .filter((finding) => finding.verdict !== 'approve' && (
      finding.reviewerId.startsWith('opposition') || finding.reviewerId.startsWith('shadow-')
    ))
    .map((finding) => {
      const evidence = finding.evidenceRefs?.length ? ` Evidence: ${finding.evidenceRefs.join('; ')}` : '';
      return `Answer ${finding.reviewerId}'s ${finding.verdict}: ${finding.rationale}${evidence}`;
    });
  // The minister's reply is the one place a concrete diagnosis ("DATA_DIR at nuclear_data.py:36
  // points to the wrong directory") was written down, and it went only to the ledger. A concession
  // answers no objections, so what was conceded is in its rationale — which was never stored, and
  // every concession reached the next attempt as nothing. A defence the House then refused is
  // context for the next attempt, not a change it was asked to make.
  const reply = review.meta?.governmentReply as
    Pick<GovernmentReply, 'conceded' | 'objectionsAnswered' | 'rationale'> | undefined;
  const ministerial = !reply ? [] : reply.conceded
    ? [`Fix what the minister conceded to the Opposition: ${reply.rationale}`]
    : reply.objectionsAnswered.map((answer) =>
      `Context, not a required change — the government argued: ${answer} The House did not accept it.`);

  return dedupe([...committee, ...opposition, ...ministerial]);
}

/**
 * Westminster-style governance: committees scrutinize each motion before implementation, an
 * adversarial opposition falsification-tests the actual diff afterward, and a deterministic,
 * risk-scaled vote (never an LLM call) decides the outcome. See SwarmStrategy for the shared
 * plan -> assign -> execute -> review -> decide -> recordOutcome lifecycle this implements.
 */
export class DemocraticStrategy implements SwarmStrategy {
  readonly id = 'democratic' as const;


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
        phase: 'institutional',
        repositoryTools: false,
        reasoningEffort: 'low',
        personaId: 'testing-and-evidence-committee',
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

  /**
   * Fills the offices before any of them act (section 8), and checks the result against article 6
   * before letting it stand.
   *
   * A separation breach that can be repaired is repaired — the procedural office moves, never the
   * executive one. A breach that cannot be is raised as a non-waivable finding rather than
   * tolerated: the constitutional gate already refuses assent while one of those is open, so a
   * swarm that cannot separate its own functions cannot deliver.
   */
  private constituteOfficesFor(ctx: EngineContext, cfg: DemocraticConfig, termId: number): OfficeRegister {
    const state = asStrategyState(ctx);
    const perOffice = cfg.offices?.candidatesPerOffice ?? DEMOCRATIC_DEFAULTS.offices.candidatesPerOffice;

    const drawn = constituteOffices({
      seed: lotSeed(ctx),
      cfg,
      performance: readOfficePerformance(ctx.knowledge),
      termId,
      constitutedAt: new Date().toISOString(),
    });
    // Each office draws from its own candidate roster, so two of them colliding here is not
    // something that can happen by accident — this is a guard against a future change to how seats
    // are filled, not a live path. Article 6's real work happens at the gate, where the four
    // functions it names (proposal, implementation, approval, adjudication) are actual personas.
    const { register, repairs } = repairSeparationBreaches(drawn, perOffice);
    state.offices = register;

    for (const breach of repairs) {
      ctx.ledger.record('conflict_declared', {
        personaId: breach.personaId,
        offices: breach.offices,
        remedy: breach.remedy,
      });
    }

    ctx.ledger.record('offices_constituted', {
      termId: register.termId,
      method: cfg.offices?.seed === 'fixed' ? 'fixed-seed draw' : 'recorded performance, ties drawn by lot',
      primeCoordinator: register.primeCoordinator,
      speaker: register.speaker,
      ceremonialHead: register.ceremonialHead,
      representatives: Object.values(register.representatives),
      cabinet: Object.values(register.cabinet),
    });
    return register;
  }

  private async electCoordinator(
    ctx: EngineContext,
    cfg: DemocraticConfig,
    electionId = 'formation',
    exclude?: string,
  ): Promise<void> {
    if (!cfg.offices?.constituentBallots) return;
    const state = asStrategyState(ctx);
    const register = state.offices;
    if (!register) throw new Error('The offices must be constituted before an election.');
    const electors = frozenElectorate(state, cfg);
    const candidates = candidatesFor('prime-coordinator', (cfg.offices?.candidatesPerOffice ?? DEMOCRATIC_DEFAULTS.offices.candidatesPerOffice) + (exclude ? 2 : 0), register.termId)
      .filter((candidate) => candidate !== exclude);
    const performance = readOfficePerformance(ctx.knowledge);
    const ballotResults = await Promise.all(electors.map(async (elector): Promise<CandidateBallot> => {
      const scored = candidates.map((candidate) => ({ candidate, score: performanceScore(candidate, performance) }));
      const decided = await decideCandidateBallot(ctx, {
        personaId: `elector-${elector}`,
        instructions: coordinatorBallotSystemPrompt(elector),
        state: { constituency: elector, candidates: scored },
        candidates,
        abstainCriterion: 'You hold a specific objection to every candidate.',
      });
      if (decided) return { elector, candidate: decided.candidate };
      const response = await ctx.dispatcher.dispatch<{ candidate: string | null }>({
        role: 'reviewer',
        phase: 'institutional',
        repositoryTools: false,
        repositoryContext: false,
        personaId: `elector-${elector}`,
        systemPrompt: coordinatorBallotSystemPrompt(elector),
        userPrompt: coordinatorBallotUserPrompt(scored),
        schemaDescription: coordinatorBallotSchemaDescription,
        validate: (value: unknown) => {
          if (typeof value !== 'object' || value === null || !('candidate' in value) ||
            (value.candidate !== null && (typeof value.candidate !== 'string' || !candidates.includes(value.candidate)))) {
            throw new Error('The ballot must name a listed candidate or abstain.');
          }
        },
        temperature: 0.2,
      });
      return { elector, candidate: response.value.candidate };
    }));
    const result = tallyElection(electors, candidates, ballotResults);
    const artifactDigest = digestArtifact({ termId: register.termId, candidates, electors });
    recordGovernanceDecision(ctx.runState, ctx.ledger, {
      id: `prime-coordinator-election-${register.termId}-${electionId}`,
      body: 'constituencies',
      subject: 'prime-coordinator',
      artifactDigest,
      rule: 'equal-ballot-plurality-quorum-half-tie-roster-order-v1',
      eligible: electors,
      positions: ballotResults.map(({ elector, candidate }) => ({ actor: elector, choice: candidate ?? 'abstain' })),
      evidenceRefs: ['office-performance'],
      result: result.winner ?? 'no-mandate',
      nextAction: result.winner ? 'grant-executive-mandate' : 'suspend-executive-planning',
    });
    if (!result.winner) throw new Error('No Prime Coordinator was elected with quorum and a valid vote.');
    state.offices = {
      ...register,
      primeCoordinator: result.winner,
      holders: register.holders.map((holder) => holder.office === 'prime-coordinator'
        ? { ...holder, personaId: result.winner!, method: 'election' as const } : holder),
    };
    const mandateId = `executive-${register.termId}-${electionId}`;
    grantGovernanceMandate(ctx.runState, ctx.ledger, {
      id: mandateId,
      grantor: 'constituencies',
      holder: result.winner,
      scope: ['propose-programme', 'answer-confidence'],
      artifactDigest,
    });
    state.executiveMandateId = mandateId;
    state.executiveMandateDigest = artifactDigest;
  }

  private async electRepresentatives(
    ctx: EngineContext,
    cfg: DemocraticConfig,
    constituencies = frozenElectorate(asStrategyState(ctx), cfg),
    electionId = 'formation',
    exclude: Record<string, string> = {},
  ): Promise<void> {
    if (!cfg.offices?.constituentBallots) return;
    const state = asStrategyState(ctx);
    const register = state.offices;
    if (!register) throw new Error('Offices must exist before representative elections.');
    const voterCount = Math.max(2, Math.min(5, cfg.offices.votersPerConstituency ?? DEMOCRATIC_DEFAULTS.offices.votersPerConstituency));
    const elections = await Promise.all(constituencies.map(async (constituency) => {
      const candidates = candidatesFor(`representative-${constituency}`,
        (cfg.offices?.candidatesPerOffice ?? DEMOCRATIC_DEFAULTS.offices.candidatesPerOffice) + (exclude[constituency] ? 2 : 0), register.termId)
        .filter((candidate) => candidate !== exclude[constituency]);
      const electors = Array.from({ length: voterCount }, (_, index) => `${constituency}-constituent-${index + 1}`);
      const performance = readOfficePerformance(ctx.knowledge);
      const ballots = await Promise.all(electors.map(async (elector): Promise<CandidateBallot> => {
        const systemPrompt = `You are one member of the ${constituency} constituency. Elect its Commons representative ` +
          'by one independent equal ballot. Performance is information, not a binding ranking. Abstain only if you hold ' +
          'a specific objection to every candidate. A score of 0.5 means no record yet, and candidates with equal ' +
          'scores are interchangeable: pick one, because a constituency that abstains entirely has no representative.';
        const scored = candidates.map((candidate) => ({ candidate, score: performanceScore(candidate, performance) }));
        const decided = await decideCandidateBallot(ctx, {
          personaId: elector,
          instructions: systemPrompt,
          state: { constituency, candidates: scored },
          candidates,
          abstainCriterion: 'You hold a specific objection to every candidate.',
        });
        if (decided) return { elector, candidate: decided.candidate };
        const response = await ctx.dispatcher.dispatch<{ candidate: string | null }>({
          role: 'reviewer', phase: 'institutional', repositoryTools: false, repositoryContext: false, personaId: elector,
          systemPrompt,
          userPrompt: `Candidates: ${JSON.stringify(scored)}. Return {"candidate":"name"} or {"candidate":null}.`,
          schemaDescription: '{"candidate": string | null}; string must name a listed candidate',
          validate: (value: unknown) => {
            if (typeof value !== 'object' || value === null || !('candidate' in value) ||
              (value.candidate !== null && (typeof value.candidate !== 'string' || !candidates.includes(value.candidate)))) {
              throw new Error('A constituent ballot must name a listed candidate or abstain.');
            }
          },
          temperature: 0.2,
        });
        return { elector, candidate: response.value.candidate };
      }));
      return { constituency, candidates, electors, ballots, result: tallyElection(electors, candidates, ballots) };
    }));
    for (const election of elections) {
      const { constituency, candidates, electors, ballots, result } = election;
      const digest = digestArtifact({ termId: register.termId, constituency, candidates, electors });
      recordGovernanceDecision(ctx.runState, ctx.ledger, {
        id: `representative-election-${register.termId}-${constituency}-${electionId}`,
        body: `${constituency}-constituency`, subject: `representative-${constituency}`,
        artifactDigest: digest, rule: 'equal-ballot-plurality-quorum-half-tie-roster-order-v1',
        eligible: electors,
        positions: ballots.map(({ elector, candidate }) => ({ actor: elector, choice: candidate ?? 'abstain' })),
        evidenceRefs: ['office-performance'], result: result.winner ?? 'no-mandate',
        nextAction: result.winner ? 'grant-representative-mandate' : 'leave-seat-vacant',
      });
      if (!result.winner) throw new Error(`${constituency} elected no representative with quorum.`);
      const previous = state.representativeMandates?.[constituency];
      if (previous) revokeGovernanceMandate(ctx.runState, ctx.ledger, previous.id);
      const mandateId = `representative-${register.termId}-${constituency}-${electionId}`;
      grantGovernanceMandate(ctx.runState, ctx.ledger, {
        id: mandateId, grantor: `${constituency}-constituency`, holder: result.winner,
        scope: [`vote:${constituency}`], artifactDigest: digest,
      });
      (state.representativeMandates ??= {})[constituency] = { id: mandateId, digest };
      const current = state.offices!;
      state.offices = {
        ...current,
        representatives: { ...current.representatives, [constituency]: result.winner },
        holders: current.holders.map((holder) => holder.office === 'representative' && holder.seat === constituency
          ? { ...holder, personaId: result.winner!, method: 'election' as const } : holder),
      };
    }
  }

  async plan(ctx: EngineContext, task: TaskSpec): Promise<TaskGraph> {
    const cfg = asDemocraticConfig(ctx);
    const state = asStrategyState(ctx);

    // Nobody acts before there is an office to act from. A remediation cycle re-enters plan() with
    // a register already in place and keeps it: recalling the whole government because Claude
    // returned a defect would be a coup, not a term ending.
    if (!state.offices) {
      this.constituteOfficesFor(ctx, cfg, 1);
      await this.electCoordinator(ctx, cfg);
    }
    if (cfg.offices?.constituentBallots) {
      requireGovernanceMandate(ctx.runState, state.executiveMandateId ?? '',
        state.offices!.primeCoordinator, state.executiveMandateDigest ?? '');
      const missing = frozenElectorate(state, cfg).filter((constituency) => !state.representativeMandates?.[constituency]);
      if (missing.length > 0) await this.electRepresentatives(ctx, cfg, missing);
    }

    // The Testing and Evidence Committee reports before the House authorises implementation.
    await this.recordTestMandate(ctx, task);

    const result = await ctx.dispatcher.dispatch<PlannerOutput>({
      role: 'planner',
      systemPrompt: plannerSystemPrompt(),
      userPrompt: plannerUserPrompt(task),
      schemaDescription: plannerSchemaDescription,
      validate: validatePlannerOutput,
      temperature: 0.2,
    });
    ctx.ledger.record('motions_drafted', {
      count: result.value.motions.length,
      model: result.model,
      costUsd: result.costUsd,
    });

    // First reading (section 7 stage 2). "No implementation should begin merely because the
    // proposal sounds attractive" — and equally, none is refused merely because the Chair does not
    // fancy it: the Speaker rules on procedure, and the rulings decide what reaches the paper.
    const rulings = await this.holdFirstReading(ctx, cfg, task.goal, result.value.motions);
    const admissible = new Map(rulings.filter((r) => r.admissible).map((r) => [r.motionId, r]));
    const admitted = result.value.motions.filter((m) => admissible.has(m.id));

    // Path hints come from the motion's own text only. Section 7 stage 6 gives each task "a defined
    // mandate; affected files" — unioning every path the goal names onto every motion made each one
    // claim the whole programme, so every motion read as cross-module and ownership of every file
    // was contested between all of them. The Speaker then strikes whatever overlap the draft itself
    // left, so each file has one owning motion.
    const mandates = amendOverlappingMandates(admitted.map((motion) => ({
      id: motion.id,
      paths: dedupe([...motion.targetGlobs, ...extractPathHints(`${motion.title} ${motion.description}`)]),
    })));
    for (const amendment of mandates.amendments) {
      ctx.ledger.record('speaker_amendment', {
        motionId: amendment.motionId,
        struck: amendment.struck,
        keptBy: amendment.keptBy,
        subsumedBy: mandates.subsumed[amendment.motionId] ?? [],
      });
    }
    const motions = admitted.filter((m) => !mandates.subsumed[m.id]);

    const motionIds = new Set(motions.map((m) => m.id));
    const graph = emptyGraph();

    for (const motion of motions) {
      const touchedPaths = mandates.paths[motion.id] ?? [];
      const riskClass = classifyRiskByPaths(touchedPaths, {
        securityPathGlobs: cfg.riskClassification.securityPathGlobs,
        crossModuleThreshold: cfg.riskClassification.crossModuleThreshold,
      });
      const acceptanceCriteria = motion.acceptanceCriteria.length ? motion.acceptanceCriteria : task.acceptanceCriteria;

      addNode(graph, {
        id: motion.id,
        title: motion.title,
        description: motion.description,
        acceptanceCriteria,
        // A dependency on a subsumed motion is a dependency on the motions that now own its files.
        dependsOn: dedupe(motion.dependsOn.flatMap((d) => mandates.subsumed[d] ?? [d]))
          .filter((d) => motionIds.has(d) && d !== motion.id),
        targetGlobs: touchedPaths,
        riskTags: riskClass === 'high' ? ['security-boundary'] : riskClass === 'medium' ? ['cross-module'] : [],
        riskClass,
        phase: 'queued',
        attempts: [],
      });

      (state.taskMeta ??= {})[motion.id] = {
        title: motion.title,
        riskClass,
        portfolioTag: motion.portfolioTag?.trim() || 'general',
        treatment: admissible.get(motion.id)?.treatment,
      };

      // What the motion promised the House when it asked for authority (section 7 stage 1). Stage 9
      // sets the actual against this; a motion that promised nothing is recorded as having promised
      // nothing rather than being credited with a zero estimate it never made.
      // The petition fields are optional on the wire and the model may return anything at all for
      // them, so each is checked rather than trusted: a motion that promised nothing must be
      // recorded as promising nothing, not crash the run on the way to first reading.
      (state.motionEstimates ??= {})[motion.id] = {
        estimatedCostUsd: typeof motion.estimatedCostUsd === 'number' && Number.isFinite(motion.estimatedCostUsd)
          ? motion.estimatedCostUsd
          : 0,
        foreseeableRisks: Array.isArray(motion.foreseeableRisks)
          ? motion.foreseeableRisks.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
          : [],
        rollbackConditions: typeof motion.rollbackConditions === 'string' ? motion.rollbackConditions.trim() : '',
      };

      ctx.ledger.record('risk_classified', { taskId: motion.id, riskClass, touchedPaths });
    }

    // An empty Order Paper is a legitimate ending — the engine terminates the run incomplete — but
    // never a silent one. Section 5 forbids representing partial work as accepted, and a programme
    // that never reached committee is the starkest case of that.
    if (graph.order.length === 0) {
      ctx.addFinding({
        source: `speaker:${state.offices?.speaker ?? 'speaker'}`,
        summary: 'No motion survived first reading, so the House had no business to conduct.',
        evidenceRefs: rulings.map((r) => `${r.motionId}: ${r.rationale}`),
        disposition: 'unresolved',
        dispositionRationale: 'Recorded so an empty programme is explained rather than presented as a completed one.',
        nonWaivable: true,
      });
    }

    return graph;
  }

  /**
   * Section 7 stage 2, in two passes: the deterministic screen, then a ruling on what survives it.
   *
   * The screen goes first because it is free — refusing a duplicate does not need a model, and
   * paying for a ruling on a motion already before the House would be paying to be told what the
   * titles already say. Where the dispatch fails, the fallback is to admit the motion with the
   * treatment `classifyMotionClass` derives from its risk: a Speaker that cannot be reached must
   * not become a Speaker that refuses everything.
   */
  private async holdFirstReading(
    ctx: EngineContext,
    cfg: DemocraticConfig,
    goal: string,
    motions: Motion[],
  ): Promise<AdmissibilityRuling[]> {
    const state = asStrategyState(ctx);
    const speakerId = state.offices?.speaker ?? 'speaker';
    const screened = screenMotions(motions, {
      duplicateTitleSimilarity: cfg.speaker?.duplicateTitleSimilarity ?? DEMOCRATIC_DEFAULTS.speaker.duplicateTitleSimilarity,
      maxMotionsPerReading: cfg.speaker?.maxMotionsPerReading ?? DEMOCRATIC_DEFAULTS.speaker.maxMotionsPerReading,
    });
    const byId = new Map(motions.map((m) => [m.id, m]));
    const askForRuling = cfg.speaker?.admissibilityRuling ?? DEMOCRATIC_DEFAULTS.speaker.admissibilityRuling;

    const rulings: AdmissibilityRuling[] = [];
    for (const screen of screened) {
      const motion = byId.get(screen.motionId)!;
      const fallbackTreatment = classifyMotionClass(
        classifyRiskByPaths(motion.targetGlobs, {
          securityPathGlobs: cfg.riskClassification.securityPathGlobs,
          crossModuleThreshold: cfg.riskClassification.crossModuleThreshold,
        }),
      );

      if (screen.verdict !== 'in-order') {
        rulings.push({
          motionId: screen.motionId,
          admissible: false,
          treatment: fallbackTreatment,
          duplicateOf: screen.duplicateOf,
          rationale: screen.rationale,
        });
        continue;
      }

      if (!askForRuling) {
        rulings.push({ motionId: screen.motionId, admissible: true, treatment: fallbackTreatment, rationale: screen.rationale });
        continue;
      }

      const decided = await decideQuestions(ctx, {
        personaId: speakerId,
        state: speakerDecisionState(goal, motion),
        questions: speakerDecisionQuestions,
        confidenceFloor: DECISION_VOTE_FLOOR,
      });
      if (decided?.admissible?.type === 'noul' && decided.treatment?.type === 'choice') {
        rulings.push({
          motionId: screen.motionId,
          admissible: decided.admissible.noul >= 0.5,
          treatment: decided.treatment.choice as MotionClass,
          rationale: `Ruled by decision model: admissible ${summariseAnswer(decided.admissible)}; treatment ${summariseAnswer(decided.treatment)}.`,
        });
        continue;
      }
      try {
        const ruled = await ctx.dispatcher.dispatch<{ admissible: boolean; treatment: MotionClass; rationale: string }>({
          role: 'speaker',
          personaId: speakerId,
          systemPrompt: speakerSystemPrompt(),
          userPrompt: speakerUserPrompt(goal, motion),
          schemaDescription: speakerSchemaDescription,
          validate: validateSpeakerRuling,
          temperature: 0.1,
        });
        rulings.push({
          motionId: screen.motionId,
          admissible: ruled.value.admissible,
          treatment: ruled.value.treatment,
          rationale: ruled.value.rationale,
        });
      } catch (err) {
        rulings.push({
          motionId: screen.motionId,
          admissible: true,
          treatment: fallbackTreatment,
          rationale: `The Chair could not be reached (${String(err)}); the motion stands and goes to committee.`,
        });
      }
    }

    const { rulings: final, restored } = restoreIfPaperEmpty(motions, rulings);
    for (const ruling of final) {
      ctx.ledger.record('speaker_ruling', {
        motionId: ruling.motionId,
        admissible: ruling.admissible,
        treatment: ruling.treatment,
        duplicateOf: ruling.duplicateOf ?? '',
        rationale: ruling.rationale,
      });
    }
    if (restored) {
      ctx.ledger.record('order_paper_restored', { motionId: restored, speaker: speakerId });
    }
    return final;
  }

  async assign(ctx: EngineContext, graph: TaskGraph): Promise<Assignment[]> {
    const cfg = asDemocraticConfig(ctx);
    const state = asStrategyState(ctx);
    // Only motions whose dependencies have carried go to committee. The engine defers any other
    // assignment, and it then re-sat every waiting motion's committee on every pass: in the
    // 2026-09-21 sweep five blocked motions were re-examined on each of eight skeleton attempts.
    const readyIds = readyNodes(graph).map((node) => node.id);

    // Every ready motion's committee inquiry is independent of every other ready motion's: neither
    // touches the shared worktree (that happens in execute(), which the engine keeps serial), and
    // each motion only reads and writes state keyed by its own id. Running them one motion at a
    // time meant a tick with several ready motions paid for the full committee process motion by
    // motion instead of once; Promise.all lets them run concurrently while returning assignments in
    // the same readyIds order every time, so the chamber's business is unchanged, only its timing.
    const assignments = await Promise.all(readyIds.map((id) => this.assignMotion(ctx, cfg, state, graph, id)));
    return assignments.filter((assignment): assignment is Assignment => assignment !== null);
  }

  private async assignMotion(
    ctx: EngineContext,
    cfg: DemocraticConfig,
    state: DemocraticStrategyState,
    graph: TaskGraph,
    id: string,
  ): Promise<Assignment | null> {
    const node = graph.nodes[id];
    const taskMeta = state.taskMeta?.[id];
    const portfolioTag = taskMeta?.portfolioTag ?? 'general';
    const promptInput = {
      motionTitle: node.title,
      motionDescription: node.description,
      acceptanceCriteria: node.acceptanceCriteria,
      targetGlobs: node.targetGlobs,
      recommittal: state.recommittals?.[id],
      remediation: state.remediationDirectives?.[id],
    };
    // The Speaker's first-reading treatment stands where it gave one; the risk-derived class is
    // only the fallback for a motion the Chair never ruled on.
    const motionClass = taskMeta?.treatment ?? classifyMotionClass(node.riskClass);
    const personaBase = this.getPortfolioPersonaId(ctx, portfolioTag);

    // Section 14's closure rule against endless deliberation: "time-boxed stages, delegated
    // routine authority and automatic closure rules". A routine motion the committee authorised
    // at its first sitting is not re-examined on each retry: its wording is unchanged, so the
    // committee would only be asked again a question it has answered, and a lone recommittal seat
    // once refused six sound attempts that way. The authorisation carries; every retry still
    // faces the Opposition on the actual diff, the checks, and the division, where a failed check
    // or a high-severity objection still turns members against it. A motion the committee
    // objected to, or anything not ruled routine, sits again as before.
    const authorisation = state.committeeAuthorisations?.[id];
    if (promptInput.recommittal && motionClass === 'routine' && node.riskClass !== 'high' && authorisation) {
      ctx.ledger.record('closure_applied', {
        taskId: id,
        attemptNumber: promptInput.recommittal.attemptNumber,
        carriedFindings: authorisation.length,
      });
      const meta: DemocraticAssignmentMeta = {
        motionClass,
        riskClass: node.riskClass,
        portfolioTag,
        committeeFindings: authorisation,
        committeeCarried: true,
      };
      return { taskId: id, assigneeId: `implementer-${portfolioTag}`, role: 'implementer', meta };
    }

    // The matching committee inquiry: electedSpecialistCalls specialist members of this
    // portfolio's committee, plus sortitionCalls ordinary citizen(s) selected by lot.
    //
    // The Speaker's ruling now sizes it. Every motion used to get the full committee including
    // the 52 of 101 the Chair had ruled ROUTINE, which is not a chamber being more democratic —
    // it is a chamber declining to use its own expedited procedure while paying 90.7% of its
    // calls for deliberation and 9.3% for the work, and twice failing a whole run on the
    // maxWorkerCalls ceiling. Substantive business — anything ruled 'committee' or 'emergency' —
    // is untouched and still faces the full committee, the sortition seat, the division and the
    // Opposition's veto.
    //
    // A recommittal returns to the committee that already ruled rather than re-polling the
    // chamber: the motion's wording is unchanged between attempts, so a fresh full inquiry
    // re-asks a question already answered.
    const fullElected = Math.max(0, cfg.committee?.electedSpecialistCalls ?? DEMOCRATIC_DEFAULTS.committee.electedSpecialistCalls);
    const fullSortition = Math.max(0, cfg.committee?.sortitionCalls ?? DEMOCRATIC_DEFAULTS.committee.sortitionCalls);
    const expedited = motionClass === 'routine' || promptInput.recommittal !== undefined;
    const electedCalls = expedited
      ? Math.min(fullElected, Math.max(1, cfg.committee?.expeditedElectedSpecialistCalls ?? DEMOCRATIC_DEFAULTS.committee.expeditedElectedSpecialistCalls))
      : fullElected;
    const sortitionCalls = expedited
      ? Math.min(fullSortition, Math.max(0, cfg.committee?.expeditedSortitionCalls ?? DEMOCRATIC_DEFAULTS.committee.expeditedSortitionCalls))
      : fullSortition;
    if (expedited && electedCalls + sortitionCalls < fullElected + fullSortition) {
      ctx.ledger.record('committee_expedited', {
        taskId: id,
        motionClass,
        reason: promptInput.recommittal ? 'recommittal returns to the committee that ruled' : 'the Chair ruled this motion routine',
        seated: electedCalls + sortitionCalls,
        fullChamber: fullElected + fullSortition,
      });
    }

    // Elected specialists and the sortition citizen(s) each sit on this motion alone — none of
    // their verdicts depends on another seat's — so the committee's own inquiry runs concurrently
    // too, in the same elected-then-sortition order the ledger has always recorded.
    const electedFindings = await Promise.all(
      Array.from({ length: electedCalls }, (_, i) => i).map(async (i): Promise<CommitteeFinding> => {
        const personaId = `${personaBase}#${i + 1}`;
        const result = await ctx.dispatcher.dispatch<{ verdict: CommitteeFinding['verdict']; rationale: string }>({
          role: 'reviewer',
          personaId,
          scopeTaskId: id,
          phase: 'institutional',
          systemPrompt: committeeSystemPrompt('elected', portfolioTag),
          userPrompt: committeeUserPrompt(promptInput),
          schemaDescription: committeeSchemaDescription,
          validate: validateCommitteeVerdict,
          temperature: 0.3,
        });
        return { personaId, portfolioTag, seat: 'elected', verdict: result.value.verdict, rationale: result.value.rationale };
      }),
    );

    // Section 8's lay seats. The citizens are the ones this term's lot actually drew — a name
    // generated at the call site would make "selection by lot" a label rather than a procedure.
    const drawnCitizens = state.offices?.sortitionPool ?? [];
    const sortitionFindings = await Promise.all(
      Array.from({ length: sortitionCalls }, (_, i) => i).map(async (i): Promise<CommitteeFinding> => {
        const personaId = drawnCitizens[i] ?? `sortition-citizen#${i + 1}`;
        const result = await ctx.dispatcher.dispatch<{ verdict: CommitteeFinding['verdict']; rationale: string }>({
          role: 'generalist',
          phase: 'institutional',
          personaId,
          scopeTaskId: id,
          systemPrompt: committeeSystemPrompt('sortition', portfolioTag),
          userPrompt: committeeUserPrompt(promptInput),
          schemaDescription: committeeSchemaDescription,
          validate: validateCommitteeVerdict,
          temperature: 0.5,
        });
        return { personaId, portfolioTag, seat: 'sortition', verdict: result.value.verdict, rationale: result.value.rationale };
      }),
    );

    const committeeFindings: CommitteeFinding[] = [...electedFindings, ...sortitionFindings];

    ctx.ledger.record('committee_inquiry', { taskId: id, portfolioTag, motionClass, findings: committeeFindings });
    if (!promptInput.recommittal && motionClass === 'routine' && committeeApproveScore(committeeFindings) > 0.5) {
      (state.committeeAuthorisations ??= {})[id] = committeeFindings;
    }

    const meta: DemocraticAssignmentMeta = {
      motionClass,
      riskClass: node.riskClass,
      portfolioTag,
      committeeFindings,
    };
    return { taskId: id, assigneeId: `implementer-${portfolioTag}`, role: 'implementer', meta };
  }

  async execute(ctx: EngineContext, assignment: Assignment): Promise<WorkProduct> {
    const node = ctx.runState.graph!.nodes[assignment.taskId];
    const state = asStrategyState(ctx);
    const promptInput = {
      goal: ctx.runState.task.goal,
      motionTitle: node.title,
      motionDescription: node.description,
      acceptanceCriteria: node.acceptanceCriteria,
      targetGlobs: node.targetGlobs,
      recommittal: state.recommittals?.[assignment.taskId],
      remediation: state.remediationDirectives?.[assignment.taskId],
    };

    const result = await ctx.dispatcher.dispatch<ImplementerWireOutput>({
      role: 'implementer',
      taskId: assignment.taskId,
      personaId: assignment.assigneeId,
      systemPrompt: implementerSystemPrompt(),
      userPrompt: implementerUserPrompt(promptInput),
      schemaDescription: implementerSchemaDescription,
      validate: validateImplementerOutput,
      temperature: IMPLEMENTER_TEMPERATURE,
    });
    const proposed = toEngineFileOps(result.value.fileOps);

    // The guardian's one power over ordinary business: refusing an instruction that is
    // unconstitutional on its face. Deleting a test is the only thing that qualifies without anyone
    // having to form a view, and the offending ops are dropped rather than the whole motion — the
    // rest of the change still deserves its committee. The engine holds the same floor
    // independently, so this is the constitutional refusal, not the enforcement.
    const refusal = refusesInstruction(proposed, (p) => isTestPath(p, ctx.checks.testPathGlobs));
    const fileOps = refusal ? proposed.filter((op) => !(op.op === 'delete' && isTestPath(op.path, ctx.checks.testPathGlobs))) : proposed;
    if (refusal) this.exerciseReservePower(ctx, refusal, assignment.taskId);

    const opsSummary = fileOps.map((op) => ({ op: op.op, path: op.path }));
    (state.taskFileOps ??= {})[assignment.taskId] = opsSummary;
    ctx.ledger.record('file_ops_proposed', { taskId: assignment.taskId, ops: opsSummary });

    return {
      taskId: assignment.taskId,
      assignment,
      fileOps,
      rationale: result.value.rationale,
      unresolvedUncertainty: result.value.unresolvedUncertainty,
    };
  }

  async review(ctx: EngineContext, product: WorkProduct, test: TestResult): Promise<ReviewResult> {
    const cfg = asDemocraticConfig(ctx);
    const state = asStrategyState(ctx);
    const node = ctx.runState.graph!.nodes[product.taskId];
    const meta = product.assignment.meta as DemocraticAssignmentMeta;

    // Debate stage: the opposition critiques the ACTUAL proposed change (fileOps + rationale +
    // test result), not the motion — it runs here, after execute(), by design. The shadow minister
    // for this portfolio speaks, so the agent challenging a security change is the one that has
    // been watching security.
    const shadowId = shadowMinisterFor(state.offices, cfg, meta.portfolioTag);
    const result = await ctx.dispatcher.dispatch<OppositionFinding>({
      role: 'opposition',
      personaId: shadowId,
      scopeTaskId: product.taskId,
      systemPrompt: oppositionSystemPrompt(meta.portfolioTag),
      userPrompt: oppositionUserPrompt(
        node.title,
        product.rationale,
        product.fileOps,
        node.acceptanceCriteria,
        test,
        state.recommittals?.[product.taskId]?.requiredChanges,
      ),
      schemaDescription: oppositionSchemaDescription,
      validate: validateOppositionOutput,
      temperature: 0.4,
    });
    const opposition = result.value;
    const remedy = opposition.verdict !== 'approve' ? opposition.remedy?.trim() : undefined;

    ctx.ledger.record('opposition_brief', {
      taskId: product.taskId,
      verdict: opposition.verdict,
      severity: opposition.severity,
      ...(remedy ? { remedy } : {}),
    });

    // The government answers. Section 7 stage 4 requires objections be answered rather than
    // restated, and a debate with only one speaker is not scrutiny — but there is nothing to answer
    // when the Opposition did not object, so the reply is not paid for then.
    const reply = replyIsDue(opposition.verdict, cfg)
      ? await this.answerTheOpposition(ctx, product, meta, opposition, test)
      : null;
    const severity = severityAfterReply(opposition.verdict, opposition.severity, reply);

    // Section 14's safeguard against "opposition as sabotage": an objection names a feasible
    // remedy where it can, and the remedy travels with the finding so the next attempt is told
    // what would satisfy the Opposition instead of only what it disliked.
    const oppositionFinding: ReviewFinding = {
      reviewerId: shadowId,
      verdict: opposition.verdict,
      rationale: `[severity=${severity}] ${opposition.rationale}${remedy ? ` Remedy proposed: ${remedy}` : ''}`,
      evidenceRefs: opposition.counterBrief ? [opposition.counterBrief] : [],
    };
    // Abstentions do not appear here. ReviewFinding.verdict is the engine's shared three-value type
    // and an abstention is the absence of a verdict rather than a fourth one — a member who said "I
    // cannot judge this" has offered the review record nothing to record. The abstention itself is
    // not lost: it stays on the committee_inquiry ledger entry and in the assignment meta the
    // division reads, which is where it actually has an effect.
    // Findings the closure rule carried were already recorded at the sitting that made them; listed
    // again here they would reach the engine's repair brief as this attempt's review.
    const committeeReviewFindings: ReviewFinding[] = (meta.committeeCarried ? [] : meta.committeeFindings)
      .filter((f) => f.verdict !== 'abstain')
      .map((f) => ({
        reviewerId: f.personaId,
        verdict: f.verdict as ReviewFinding['verdict'],
        rationale: `[${f.seat} seat, portfolio=${f.portfolioTag}] ${f.rationale}`,
      }));

    return {
      taskId: product.taskId,
      findings: [...committeeReviewFindings, oppositionFinding],
      testResult: test,
      meta: {
        oppositionVerdict: opposition.verdict,
        // The severity the division sees is the one that survived the reply, not the one the
        // Opposition opened with.
        oppositionSeverity: severity,
        ministerConceded: reply?.conceded ?? false,
        // Read by repairRequirements, so a defeated motion's next attempt hears the reply too —
        // a concession included, though it answers no objections.
        ...(reply && (reply.conceded || reply.objectionsAnswered.length)
          ? { governmentReply: { conceded: reply.conceded, objectionsAnswered: reply.objectionsAnswered, rationale: reply.rationale } }
          : {}),
      },
    };
  }

  /**
   * The government's reply. Returns null rather than throwing if the minister cannot be reached:
   * the House can proceed on the Opposition's objection alone — that leaves the objection standing
   * at full weight, which is the right way for this to fail.
   */
  private async answerTheOpposition(
    ctx: EngineContext,
    product: WorkProduct,
    meta: DemocraticAssignmentMeta,
    opposition: OppositionFinding,
    test: TestResult,
  ): Promise<GovernmentReply | null> {
    const state = asStrategyState(ctx);
    const node = ctx.runState.graph!.nodes[product.taskId];
    const ministerId = ministerFor(state.offices, meta.portfolioTag);

    try {
      const replied = await ctx.dispatcher.dispatch<{
        conceded: boolean;
        objectionsAnswered: string[];
        citations: string[];
        rationale: string;
      }>({
        role: 'reviewer',
        personaId: ministerId,
        phase: 'institutional',
        systemPrompt: governmentReplySystemPrompt(meta.portfolioTag),
        userPrompt: governmentReplyUserPrompt(
          node.title,
          product.rationale,
          opposition.verdict,
          opposition.rationale,
          test,
          product.fileOps.map((op) => op.path),
        ),
        schemaDescription: governmentReplySchemaDescription,
        validate: validateGovernmentReply,
        temperature: 0.3,
      });

      const reply: GovernmentReply = {
        conceded: replied.value.conceded,
        objectionsAnswered: replied.value.objectionsAnswered,
        citations: replied.value.citations,
        rationale: replied.value.rationale,
      };
      ctx.ledger.record('government_reply', {
        taskId: product.taskId,
        personaId: ministerId,
        conceded: reply.conceded,
        objectionsAnswered: reply.objectionsAnswered,
        citesEvidence: replyCitesEvidence(reply),
      });
      (state.ministerConcessions ??= {})[product.taskId] = reply.conceded;
      return reply;
    } catch (err) {
      ctx.ledger.record('government_reply', {
        taskId: product.taskId,
        personaId: ministerId,
        conceded: false,
        objectionsAnswered: [],
        citesEvidence: false,
      });
      logger.warn('The minister could not be reached; the objection stands unanswered', {
        taskId: product.taskId,
        error: String(err),
      });
      return null;
    }
  }

  private async voteOnMinorityAmendment(
    ctx: EngineContext,
    product: WorkProduct,
    engaged: readonly string[],
    requiredChanges: readonly string[],
    minorityProposal: readonly ReviewFinding[],
    attemptNumber: number,
  ): Promise<boolean> {
    const state = asStrategyState(ctx);
    const proposal = minorityProposal.map((finding) => finding.rationale);
    const ballotResults = await awaitAllOrThrow(engaged.map(async (constituency) => {
      const representative = state.offices?.representatives[constituency];
      if (!representative) throw new Error(`No elected representative for ${constituency}.`);
      const systemPrompt = 'You are an elected Code Commons representative. Vote on the proposed minority amendment to repair a defeated motion. An aye authorizes a revised attempt with the stated changes; it does not approve the original work or waive any check. Return your own vote and reason.';
      const ballotState = { constituency, motion: product.taskId, proposal,
        requiredChanges, originalFileOps: product.fileOps.map((op) => ({ op: op.op, path: op.path })) };
      const decided = await decideVote(ctx, {
        personaId: representative, taskId: product.taskId, instructions: systemPrompt, state: ballotState,
        criteria: {
          aye: 'The amendment\'s stated changes would repair the defeated motion: authorise a revised attempt.',
          no: 'The amendment would not repair it, or repairs the wrong thing.',
          abstain: 'The amendment does not engage your constituency.',
        },
      });
      if (decided) return { constituency, ...decided };
      const response = await ctx.dispatcher.dispatch<{ vote: 'aye' | 'no' | 'abstain'; rationale: string }>({
        role: 'generalist', phase: 'institutional', repositoryTools: false,
        personaId: representative, taskId: product.taskId,
        systemPrompt,
        userPrompt: JSON.stringify(ballotState),
        schemaDescription: '{"vote":"aye|no|abstain","rationale":"evidence-based reason"}',
        validate: (value: unknown) => {
          if (!value || typeof value !== 'object' ||
            !['aye', 'no', 'abstain'].includes((value as { vote?: string }).vote ?? '') ||
            typeof (value as { rationale?: unknown }).rationale !== 'string' ||
            !(value as { rationale: string }).rationale.trim()) {
            throw new Error('Amendment requires an expressed representative ballot and reason.');
          }
        },
        temperature: 0.2,
      });
      return { constituency, vote: response.value.vote, rationale: response.value.rationale };
    }));
    const carried = tallyAmendmentBallots(engaged, ballotResults);
    const artifactDigest = digestArtifact({ taskId: product.taskId, fileOps: product.fileOps,
      proposal, requiredChanges });
    recordGovernanceDecision(ctx.runState, ctx.ledger, {
      id: `amendment:${product.taskId}:${attemptNumber}`,
      body: 'code-commons', subject: product.taskId, artifactDigest,
      rule: 'simple-majority-of-engaged-with-quorum', eligible: [...engaged],
      positions: ballotResults.map((ballot) => ({ actor: ballot.constituency, choice: ballot.vote })),
      evidenceRefs: minorityProposal.flatMap((finding) => finding.evidenceRefs ?? []),
      result: carried ? 'adopted' : 'defeated', nextAction: carried ? 'recommit-revised-motion' : 'retain-rejection',
    });
    return carried;
  }

  private async voteInHouseOfReview(
    ctx: EngineContext,
    product: WorkProduct,
    review: ReviewResult,
    test: TestResult,
    attemptNumber: number,
  ): Promise<boolean> {
    const chamber = asStrategyState(ctx).offices?.houseOfReview ?? [];
    if (chamber.length === 0) throw new Error('A constitutional amendment has no constituted House of Review.');
    const artifactDigest = digestArtifact({ fileOps: product.fileOps, test, review: review.findings });
    const ballotState = { motion: product.taskId, artifactDigest, fileOps: product.fileOps, test, findings: review.findings };
    const ballots = await awaitAllOrThrow(chamber.map(async (member) => {
      const systemPrompt = 'You sit in the House of Review. Vote on this constitutional motion after the Commons division. Two thirds of your chamber must support it before it can proceed to the independent human and safety gates. Give your own evidence-based vote.';
      const decided = await decideVote(ctx, {
        personaId: member, taskId: product.taskId, instructions: systemPrompt, state: ballotState,
        criteria: {
          aye: 'The recorded diff, tests and findings support this constitutional change proceeding.',
          no: 'The evidence shows a defect or an unjustified constitutional change.',
          abstain: 'The evidence is insufficient to judge either way.',
        },
      });
      if (decided) return { member, ...decided };
      const response = await ctx.dispatcher.dispatch<{ vote: 'aye' | 'no' | 'abstain'; rationale: string }>({
        role: 'reviewer', phase: 'institutional', repositoryTools: false,
        personaId: member, taskId: product.taskId,
        systemPrompt,
        userPrompt: JSON.stringify(ballotState),
        schemaDescription: '{"vote":"aye|no|abstain","rationale":"evidence-based reason"}',
        validate: (value: unknown) => {
          if (!value || typeof value !== 'object' ||
            !['aye', 'no', 'abstain'].includes((value as { vote?: string }).vote ?? '') ||
            typeof (value as { rationale?: unknown }).rationale !== 'string' ||
            !(value as { rationale: string }).rationale.trim()) {
            throw new Error('House of Review requires an expressed ballot and reason.');
          }
        },
        temperature: 0.2,
      });
      return { member, vote: response.value.vote, rationale: response.value.rationale };
    }));
    const carried = tallyChamberSupermajority(chamber, ballots);
    recordGovernanceDecision(ctx.runState, ctx.ledger, {
      id: `house-of-review:${product.taskId}:${attemptNumber}`,
      body: 'house-of-review', subject: product.taskId, artifactDigest,
      rule: 'two-thirds-of-all-seated-members', eligible: [...chamber],
      positions: ballots.map((ballot) => ({ actor: ballot.member, choice: ballot.vote })),
      evidenceRefs: review.findings.flatMap((finding) => finding.evidenceRefs ?? []),
      result: carried ? 'carried' : 'defeated',
      nextAction: carried ? 'refer-to-human-and-safety-gates' : 'reject-motion',
    });
    return carried;
  }

  private async voteInSecurityCommittee(
    ctx: EngineContext,
    product: WorkProduct,
    review: ReviewResult,
    test: TestResult,
    attemptNumber: number,
  ): Promise<boolean> {
    const state = asStrategyState(ctx);
    const offices = state.offices;
    if (!offices) throw new Error('Security Committee cannot sit before offices are constituted.');
    if (!offices.securityCommittee?.length) {
      offices.securityCommittee = ['verification', 'threat-review', 'operations']
        .map((seat) => `security-committee-${seat}-t${offices.termId}`);
      for (const member of offices.securityCommittee) {
        (offices.holders ??= []).push({ personaId: member, office: 'security-committee',
          method: 'appointment', termId: offices.termId });
      }
      ctx.ledger.record('security_committee_constituted', {
        termId: offices.termId, members: offices.securityCommittee, reason: 'legacy office register migration',
      });
    }
    const committee = offices.securityCommittee;
    if (committee.length !== 3 || new Set(committee).size !== 3 ||
      committee.some((member) => offices.houseOfReview?.includes(member) ||
        Object.values(offices.representatives).includes(member))) {
      throw new Error('Security Committee requires three distinct members outside both chambers.');
    }
    const artifactDigest = digestArtifact({ fileOps: product.fileOps, test, review: review.findings });
    const ballotState = { motion: product.taskId, artifactDigest, fileOps: product.fileOps, test, findings: review.findings };
    const ballots = await awaitAllOrThrow(committee.map(async (member) => {
      const systemPrompt = 'You sit on the independent Security Committee. Vote on this security-boundary motion using the recorded diff, tests, and findings. An aye supports referral to a human; it cannot waive the independent safety gate.';
      const decided = await decideVote(ctx, {
        personaId: member, taskId: product.taskId, instructions: systemPrompt, state: ballotState,
        criteria: {
          aye: 'The diff, tests and findings show the security boundary is respected: refer to a human.',
          no: 'The evidence shows the change weakens or bypasses a security control.',
          abstain: 'The evidence is insufficient to judge the security boundary.',
        },
      });
      if (decided) return { member, ...decided };
      const response = await ctx.dispatcher.dispatch<{ vote: 'aye' | 'no' | 'abstain'; rationale: string }>({
        role: 'reviewer', phase: 'institutional', repositoryTools: false,
        personaId: member, taskId: product.taskId,
        systemPrompt,
        userPrompt: JSON.stringify(ballotState),
        schemaDescription: '{"vote":"aye|no|abstain","rationale":"evidence-based reason"}',
        validate: (value: unknown) => {
          if (!value || typeof value !== 'object' ||
            !['aye', 'no', 'abstain'].includes((value as { vote?: string }).vote ?? '') ||
            typeof (value as { rationale?: unknown }).rationale !== 'string' ||
            !(value as { rationale: string }).rationale.trim()) {
            throw new Error('Security Committee requires an expressed ballot and reason.');
          }
        },
        temperature: 0.1,
      });
      return { member, vote: response.value.vote, rationale: response.value.rationale };
    }));
    const carried = tallyChamberSupermajority(committee, ballots);
    recordGovernanceDecision(ctx.runState, ctx.ledger, {
      id: `security-committee:${product.taskId}:${attemptNumber}`,
      body: 'security-committee', subject: product.taskId, artifactDigest,
      rule: 'two-thirds-of-seated-security-panel', eligible: [...committee],
      positions: ballots.map((ballot) => ({ actor: ballot.member, choice: ballot.vote })),
      evidenceRefs: review.findings.flatMap((finding) => finding.evidenceRefs ?? []),
      result: carried ? 'approved' : 'withheld',
      nextAction: carried ? 'refer-to-human-and-safety-gates' : 'reject-motion',
    });
    return carried;
  }

  async decide(ctx: EngineContext, product: WorkProduct, review: ReviewResult): Promise<Decision> {
    const cfg = asDemocraticConfig(ctx);
    const meta = product.assignment.meta as DemocraticAssignmentMeta;
    const test = review.testResult ?? { ran: false, passed: false };
    const touchedPaths = product.fileOps.map((op) => op.path);

    const category = classifyThresholdCategory(meta.riskClass, test, touchedPaths);
    const thresholdLabel = cfg.voteThresholds[category];
    const score = committeeApproveScore(meta.committeeFindings);
    const oppositionVerdict = (review.meta?.oppositionVerdict as OppositionFinding['verdict']) ?? 'flag';
    const oppositionSeverity = (review.meta?.oppositionSeverity as OppositionFinding['severity']) ?? 'medium';

    // The chamber divides. Members whose constituency the motion does not touch abstain — section 6
    // prefers that to uninformed voting — and a member may depart from its committee's view when
    // the evidence contradicts it, which is Burke's trustee as section 8 states him.
    const state = asStrategyState(ctx);
    const constituencies = frozenElectorate(state, cfg);
    if (cfg.offices?.constituentBallots) {
      for (const constituency of constituencies) {
        const mandate = state.representativeMandates?.[constituency];
        requireGovernanceMandate(ctx.runState, mandate?.id ?? '',
          state.offices?.representatives[constituency] ?? '', mandate?.digest ?? '');
      }
    }
    const engaged = category === 'constitutional_amendment' ? constituencies : engagedConstituencies(
      {
        portfolioTag: meta.portfolioTag,
        riskClass: meta.riskClass,
        touchedPaths,
        test,
        securityPathGlobs: cfg.riskClassification.securityPathGlobs,
      },
      constituencies,
    );
    const advisoryDivision = callDivision({
      constituencies,
      representatives: state.offices?.representatives ?? {},
      engaged,
      committeeFindings: meta.committeeFindings,
      oppositionVerdict,
      oppositionSeverity,
      test,
    });
    const ballots = cfg.offices?.constituentBallots
      ? await awaitAllOrThrow(engaged.map(async (constituency) => {
        const representative = state.offices?.representatives[constituency];
        if (!representative) throw new Error(`No elected representative for ${constituency}.`);
        const evidence = {
          constituency, motion: product.taskId, portfolio: meta.portfolioTag,
          committeeFindings: meta.committeeFindings, opposition: review.findings,
          test, touchedPaths, unresolvedUncertainty: product.unresolvedUncertainty,
        };
        const result = await ctx.dispatcher.dispatch<{ vote: 'aye' | 'no' | 'abstain'; rationale: string }>({
          role: 'generalist',
          phase: 'institutional',
          repositoryTools: false,
          personaId: representative,
          taskId: product.taskId,
          systemPrompt: 'You are an elected Code Commons representative. Vote on the motion from the evidence and your constituency remit. Return one JSON object with vote (aye, no, or abstain) and rationale. Do not claim a vote from any other member.',
          userPrompt: JSON.stringify(evidence),
          schemaDescription: '{"vote":"aye|no|abstain","rationale":"evidence-based reason"}',
          validate: (value) => {
            if (!value || typeof value !== 'object' ||
              !['aye', 'no', 'abstain'].includes((value as { vote?: string }).vote ?? '') ||
              typeof (value as { rationale?: unknown }).rationale !== 'string') {
              throw new Error('Representative must provide an expressed ballot and rationale.');
            }
          },
          temperature: 0.2,
        });
        return { constituency, vote: result.value.vote, rationale: result.value.rationale };
      }))
      : [];
    const division = ballots.length > 0 ? expressedDivision(advisoryDivision, engaged, ballots) : advisoryDivision;

    const vote = computeVote({
      category,
      thresholdLabel,
      committeeApproveScore: score,
      oppositionVerdict,
      oppositionSeverity,
      divisionShare: divisionShare(division),
      oppositionAnswered: state.recommittals?.[product.taskId]?.lastAttempt?.oppositionVerdict === 'reject',
    });

    ctx.ledger.record('division_recorded', {
      taskId: product.taskId,
      ayes: division.ayes,
      noes: division.noes,
      abstentions: division.abstentions,
      departures: division.departures,
      outcome: vote.outcome,
    });
    const recordedDivision: RecordedDivision = {
      ayes: division.ayes,
      noes: division.noes,
      abstentions: division.abstentions,
      oppositionVerdict,
      oppositionSeverity,
      voted: division.votes.filter((v) => v.vote !== 'abstain').map((v) => v.constituency),
    };
    (state.divisions ??= {})[product.taskId] = recordedDivision;

    // Section 8: a member who carried a motion the House then had to refuse has misrepresented its
    // constituency. A departure never counts — that one came with its evidence attached.
    for (const constituency of misrepresentations(division, vote.outcome)) {
      const tally = (state.representativeDepartures ??= {});
      tally[constituency] = (tally[constituency] ?? 0) + 1;
    }

    const evidenceRefs = review.findings.map((f) => `${f.reviewerId}:${f.verdict}`);
    const requiredChanges = vote.outcome === 'rejected' ? repairRequirements(meta, review, test) : [];
    const minorityProposal = review.findings.filter((finding) => finding.verdict !== 'approve' &&
      (finding.reviewerId.startsWith('opposition') || finding.reviewerId.startsWith('shadow-')));
    const attemptNumber = (ctx.runState.graph?.nodes[product.taskId]?.attempts.length ?? 0) + 1;
    let repairable = vote.outcome === 'rejected'
      && isCloseDivision(recordedDivision)
      && !oppositionRejectedOutright(recordedDivision)
      && requiredChanges.length > 0;
    // The amendment ballot is paid for only where its result can change what happens next. A
    // defeated motion is reworked by the engine whether or not the amendment carries, and the
    // engineering evidence the next attempt reads is the same either way (the engine's repair
    // brief), so below the guardian's rollback threshold the ballot's call per engaged constituency
    // decided nothing. At
    // or past it, an adopted amendment puts the motion before a human instead.
    const ballotDecidesOutcome = authorisesTaskAttemptRollback({ attemptNumber, taskId: product.taskId, requiredChanges, cfg }) !== null;
    const balloted = Boolean(cfg.offices?.constituentBallots) && vote.outcome === 'rejected' &&
      minorityProposal.length > 0 && requiredChanges.length > 0 && engaged.length > 0 && ballotDecidesOutcome;
    if (cfg.offices?.constituentBallots) {
      repairable = balloted
        ? await this.voteOnMinorityAmendment(ctx, product, engaged, requiredChanges, minorityProposal, attemptNumber)
        : false;
    }
    // The original division never supplies consent to a minority repair; the separate ballot does.
    if (minorityProposal.length > 0) {
      ctx.ledger.record('minority_amendment_considered', {
        taskId: product.taskId,
        proposal: minorityProposal.map((finding) => finding.rationale),
        evidenceRefs: minorityProposal.flatMap((finding) => finding.evidenceRefs ?? []),
        ayesForOriginal: division.ayes,
        noesForOriginal: division.noes,
        adoptedForRework: repairable,
        ...(cfg.offices?.constituentBallots ? { balloted } : {}),
      });
    }
    if (vote.outcome === 'approved') this.recordDissent(ctx, product.taskId, meta, division, review);
    const bicameralRequired = category === 'constitutional_amendment' && Boolean(cfg.offices?.constituentBallots);
    const divisionPositions = division.votes.map((member) => ({ actor: member.constituency, choice: member.vote }));
    // The label's own rule, so two_thirds_both_chambers counts every seated member, not votes cast.
    const commonsConstitutionalPass = vote.voteWouldPass &&
      carries(thresholdLabel, constituencies.length, divisionPositions);
    const bicameralPassed = bicameralRequired && commonsConstitutionalPass
      ? await this.voteInHouseOfReview(ctx, product, review, test, attemptNumber) : false;
    const securityCommitteeRequired = category === 'security_boundary' && Boolean(cfg.offices?.constituentBallots);
    const securityCommitteePassed = securityCommitteeRequired && vote.voteWouldPass
      ? await this.voteInSecurityCommittee(ctx, product, review, test, attemptNumber) : false;
    const rollback = repairable
      ? authorisesTaskAttemptRollback({ attemptNumber, taskId: product.taskId, requiredChanges, cfg })
      : null;
    const outcome = (bicameralRequired && !bicameralPassed) ||
      (securityCommitteeRequired && !securityCommitteePassed)
      ? 'rejected' : rollback ? 'needs_human' : repairable ? 'rework' : vote.outcome;
    const rationale = bicameralRequired && !bicameralPassed
      ? 'The constitutional motion failed the Commons or House of Review two-thirds requirement.'
      : securityCommitteeRequired && !securityCommitteePassed
        ? 'The security-boundary motion failed the Commons or Security Committee requirement.'
      : rollback?.rationale ?? vote.rationale;

    recordGovernanceDecision(ctx.runState, ctx.ledger, {
      id: `division:${product.taskId}:${attemptNumber}`,
      body: 'code-commons',
      subject: product.taskId,
      artifactDigest: digestArtifact({ fileOps: product.fileOps, test, category }),
      rule: thresholdLabel,
      eligible: constituencies,
      positions: divisionPositions,
      evidenceRefs: review.findings.flatMap((finding) => finding.evidenceRefs ?? []),
      result: vote.outcome,
      nextAction: outcome === 'approved' ? 'settle' : outcome === 'rework' ? 'recommit' : 'escalate-or-stop',
    });

    if (rollback) this.exerciseReservePower(ctx, rollback, product.taskId);

    if (outcome === 'needs_human') {
      ctx.openApproval({
        kind: 'vote_threshold',
        taskId: product.taskId,
        description:
          `Motion "${product.taskId}" (${nodeTitle(ctx, product.taskId)}) requires human sign-off — ` +
          `category=${category}, threshold=${thresholdLabel}. ${rationale}`,
      });
    }

    ctx.ledger.record('vote_computed', {
      taskId: product.taskId,
      category,
      thresholdLabel,
      committeeApproveScore: score,
      oppositionVerdict,
      oppositionSeverity,
      outcome,
      divisionOutcome: vote.outcome,
    });

    const decisionRecord = {
      taskId: product.taskId,
      rationale,
      evidenceRefs,
      meta: {
        category,
        thresholdLabel,
        committeeApproveScore: score,
        oppositionVerdict,
        oppositionSeverity,
        voteWouldPass: vote.voteWouldPass,
        division: { ayes: division.ayes, noes: division.noes, abstentions: division.abstentions },
      },
    };
    if (outcome === 'rework') {
      return { ...decisionRecord, outcome, rework: { requiredChanges } };
    }
    return { ...decisionRecord, outcome };
  }

  /**
   * Article 8, at the moment it bites: a motion has been carried, and the views that lost are about
   * to stop mattering to anything downstream.
   *
   * Every dissent recorded on a carried motion — a committee member who objected, a representative
   * who voted against, an Opposition that did not approve — becomes a finding marked `minority`, so
   * it reaches the delivery packet's minority reports and Claude sees what the House overrode. A
   * defeated motion needs none of this: its dissent won, and the rejection already carries it.
   *
   * These are dissent, not defects. They enter as `unresolved` like any other finding and the
   * disposition step answers for them; what article 8 guarantees is that they are answered for at
   * all rather than disappearing with the division.
   */
  private recordDissent(
    ctx: EngineContext,
    taskId: string,
    meta: DemocraticAssignmentMeta,
    division: Division,
    review: ReviewResult,
  ): void {
    const dissenting = meta.committeeFindings.filter((f) => f.verdict === 'reject' || f.verdict === 'flag');
    for (const member of dissenting) {
      ctx.addFinding({
        source: member.personaId,
        taskId,
        summary: `Minority report on a carried motion — the ${member.seat} member for ${member.portfolioTag} recorded a "${member.verdict}": ${member.rationale}`,
        evidenceRefs: [`committee:${member.verdict}`],
        disposition: 'unresolved',
        dispositionRationale: 'Dissent on a carried motion; preserved under article 8 and still to be answered for.',
        minority: true,
      });
    }

    for (const vote of division.votes.filter((v) => v.vote === 'no')) {
      ctx.addFinding({
        source: vote.personaId,
        taskId,
        summary: `Minority report on a carried motion — the member for ${vote.constituency} voted no: ${vote.rationale}`,
        evidenceRefs: [`division:${vote.constituency}`],
        disposition: 'unresolved',
        dispositionRationale: 'Dissent on a carried motion; preserved under article 8 and still to be answered for.',
        minority: true,
      });
    }

    const opposition = review.findings.find((f) => f.reviewerId.startsWith('opposition') || f.reviewerId.startsWith('shadow-'));
    if (opposition && opposition.verdict !== 'approve') {
      ctx.addFinding({
        source: opposition.reviewerId,
        taskId,
        summary: `Minority report on a carried motion — the Opposition recorded a "${opposition.verdict}": ${opposition.rationale}`,
        evidenceRefs: opposition.evidenceRefs ?? [`opposition:${opposition.verdict}`],
        disposition: 'unresolved',
        dispositionRationale: 'Dissent on a carried motion; preserved under article 8 and still to be answered for.',
        minority: true,
      });
    }
  }

  /**
   * Files the outgoing term's record with the civil service, so the next election has something to
   * read. Section 8's election criteria are recorded facts, and this is where they get recorded.
   *
   * The government answers for the whole term's business; a minister answers for its own portfolio.
   * Nothing is filed for offices whose job is not to carry motions — the Speaker's record is its
   * procedural neutrality, which a win/loss tally would misrepresent rather than measure.
   */
  private fileTermRecord(ctx: EngineContext, register: OfficeRegister): void {
    const state = asStrategyState(ctx);
    const filedAt = new Date().toISOString();
    const government = state.termTally ?? { carried: 0, defeated: 0 };
    recordOfficePerformance(ctx.knowledge, ctx.runId, { personaId: register.primeCoordinator, ...government }, filedAt);

    for (const [portfolio, minister] of Object.entries(register.cabinet)) {
      const tally = state.portfolioTally?.[portfolio];
      if (tally) recordOfficePerformance(ctx.knowledge, ctx.runId, { personaId: minister, ...tally }, filedAt);
    }

    state.termTally = { carried: 0, defeated: 0 };
    state.portfolioTally = {};
  }

  /**
   * Records a reserve power being used. Section 6 requires these to be "explicit and rarely used",
   * so every one of them lands in the ledger under its own name, with the subject it acted on.
   */
  private exerciseReservePower(ctx: EngineContext, exercise: ReservePowerExercise, taskId?: string): void {
    const state = asStrategyState(ctx);
    ctx.ledger.record('reserve_power_exercised', {
      power: exercise.power,
      subject: exercise.subject,
      rationale: exercise.rationale,
      guardian: state.offices?.ceremonialHead ?? 'ceremonial-head',
    });
    if (exercise.power === 'refuse-unconstitutional-instruction') {
      ctx.addFinding({
        source: state.offices?.ceremonialHead ?? 'ceremonial-head',
        taskId,
        summary: `The guardian refused an unconstitutional instruction: ${exercise.rationale}`,
        evidenceRefs: [exercise.subject],
        disposition: 'unresolved',
        dispositionRationale: 'Refused on constitutional ground; test integrity is not waivable by any office or majority.',
        nonWaivable: true,
      });
    }
  }

  /**
   * Section 11: the executive "remains legitimate only while it retains confidence".
   *
   * A lost motion dismisses the Prime Coordinator and returns a successor able to command the
   * House, and the Opposition publishes the alternative programme it has been arguing for all
   * along. What does not happen is the run stopping: section 11's remedy for a failing government
   * is a different government, not an abandoned programme, and the work the House has already
   * carried stands.
   */
  private async putTheQuestionOfConfidence(ctx: EngineContext, cfg: DemocraticConfig): Promise<void> {
    const state = asStrategyState(ctx);
    const register = state.offices;
    if (!register) return;

    let confidenceId: string | undefined;
    let motion = putConfidenceMotion({
      subject: register.primeCoordinator,
      constituencies: frozenElectorate(state, cfg),
      tally: state.termTally ?? { carried: 0, defeated: 0 },
      consecutiveFailures: state.governmentFailures ?? 0,
    });

    if (cfg.offices?.constituentBallots) {
      const electors = frozenElectorate(state, cfg);
      const ballots = await Promise.all(electors.map(async (elector): Promise<ConfidenceBallot> => {
        const decided = await decideVote(ctx, {
          personaId: register.representatives[elector]!,
          instructions: `You are the ${elector} representative. Decide independently whether ` +
            'the current Prime Coordinator retains your confidence, from the government record, ' +
            'your constituency responsibilities, and the reasons for the recent defeats.',
          state: { coordinator: register.primeCoordinator, tally: state.termTally, consecutiveFailures: state.governmentFailures },
          criteria: {
            aye: 'The Prime Coordinator retains your confidence.',
            no: 'The record shows the government has failed and should be replaced.',
            abstain: 'The record does not bear on your constituency.',
          },
        });
        if (decided) return { elector, choice: decided.vote };
        const response = await ctx.dispatcher.dispatch<{ choice: 'aye' | 'no' | 'abstain' }>({
          role: 'reviewer',
          phase: 'institutional',
          repositoryTools: false,
          repositoryContext: false,
          personaId: register.representatives[elector],
          systemPrompt: `You are the ${elector} representative. Decide independently whether ` +
            'the current Prime Coordinator retains your confidence. Use the government record, ' +
            'your constituency responsibilities, and reasons for the recent defeats.',
          userPrompt: `Coordinator: ${register.primeCoordinator}. Government record: ${JSON.stringify({
            tally: state.termTally, consecutiveFailures: state.governmentFailures,
          })}. Return {"choice":"aye"}, {"choice":"no"}, or {"choice":"abstain"}.`,
          schemaDescription: '{"choice": "aye" | "no" | "abstain"}',
          validate: (value: unknown) => {
            if (typeof value !== 'object' || value === null || !('choice' in value) ||
              !['aye', 'no', 'abstain'].includes(String(value.choice))) {
              throw new Error('Confidence position must be aye, no, or abstain.');
            }
          },
          temperature: 0.2,
        });
        return { elector, choice: response.value.choice };
      }));
      motion = tallyConfidenceBallots(register.primeCoordinator, electors, ballots);
      // Numbered within the term: the question can be put twice before another task completes.
      confidenceId = nextGovernanceDecisionId(ctx.runState, `confidence-${register.termId}-`);
      recordGovernanceDecision(ctx.runState, ctx.ledger, {
        id: confidenceId,
        body: 'commons',
        subject: register.primeCoordinator,
        artifactDigest: digestArtifact({ termId: register.termId, tally: state.termTally, failures: state.governmentFailures }),
        rule: 'equal-representative-ballot-quorum-half-simple-majority-v1',
        eligible: electors,
        positions: ballots.map(({ elector, choice }) => ({ actor: elector, choice })),
        evidenceRefs: ['term-tally', 'government-failures'],
        result: motion.outcome,
        nextAction: motion.outcome === 'lost' ? 'revoke-and-elect-successor' : 'retain-executive',
      });
    }

    ctx.ledger.record('confidence_motion', {
      subject: motion.subject,
      ayes: motion.ayes,
      noes: motion.noes,
      abstentions: motion.abstentions,
      outcome: motion.outcome,
      rationale: motion.rationale,
    });
    if (motion.outcome === 'sustained') return;

    if (cfg.offices?.constituentBallots) {
      if (state.executiveMandateId) revokeGovernanceMandate(ctx.runState, ctx.ledger, state.executiveMandateId);
      // Keyed by the lost motion, not the completed-task count: confidence can be lost twice before
      // another task completes, and a reused id with new ballots is a conflicting replay.
      const motionNumber = confidenceId!.slice(`confidence-${register.termId}-`.length);
      await this.electCoordinator(ctx, cfg, `successor-c${motionNumber}`, register.primeCoordinator);
      const successor = state.offices!.primeCoordinator;
      this.exerciseReservePower(ctx, appointsCoordinator(successor, register.primeCoordinator));
      ctx.ledger.record('government_formed', {
        primeCoordinator: successor,
        method: 'constituency election after lost confidence',
        termId: register.termId,
      });
    } else {
      const taken = new Set([register.primeCoordinator]);
      const successor =
        candidatesFor('prime-coordinator', (cfg.offices?.candidatesPerOffice ?? DEMOCRATIC_DEFAULTS.offices.candidatesPerOffice) + 2, register.termId).find(
          (c) => !taken.has(c),
        ) ?? register.primeCoordinator;

      state.offices = {
        ...register,
        primeCoordinator: successor,
        holders: register.holders.map((h) =>
          h.office === 'prime-coordinator' ? { ...h, personaId: successor } : h,
        ),
      };
      this.exerciseReservePower(ctx, appointsCoordinator(successor, register.primeCoordinator));
      ctx.ledger.record('government_formed', {
        primeCoordinator: successor,
        method: 'appointment after a lost confidence motion',
        termId: register.termId,
      });
    }

    const graph = ctx.runState.graph;
    const refused =
      graph?.order.filter((id) => graph.nodes[id].phase === 'abandoned').map((id) => ({ id, title: graph.nodes[id].title })) ??
      [];
    const programme = prepareAlternativeProgramme(
      shadowMinisterFor(state.offices, cfg, 'default'),
      refused,
      ctx.findings(),
    );
    ctx.ledger.record('alternative_programme_prepared', {
      author: programme.author,
      motions: programme.motions,
      rationale: programme.rationale,
    });
  }

  async recordOutcome(ctx: EngineContext, decision: Decision, _test: TestResult): Promise<void> {
    const cfg = asDemocraticConfig(ctx);
    const state = asStrategyState(ctx);
    const taskMeta = state.taskMeta?.[decision.taskId];
    const portfolioTag = taskMeta?.portfolioTag ?? 'general';
    const defeatedThisRound = decision.outcome === 'rejected' || decision.outcome === 'rework';

    if (decision.outcome === 'approved' || defeatedThisRound) {
      const carried = decision.outcome === 'approved' ? 1 : 0;
      const tally = (state.termTally ??= { carried: 0, defeated: 0 });
      tally.carried += carried;
      tally.defeated += 1 - carried;
      const byPortfolio = (state.portfolioTally ??= {});
      const portfolio = (byPortfolio[portfolioTag] ??= { carried: 0, defeated: 0 });
      portfolio.carried += carried;
      portfolio.defeated += 1 - carried;
    }

    // Collective responsibility (section 6). A minister who conceded the Opposition's objection and
    // then saw the motion carried anyway cannot both hold the portfolio and disown the policy, so
    // the dissent is recorded formally and the portfolio changes hands.
    if (decision.outcome === 'approved') {
      const dissent = assessCollectiveResponsibility({
        portfolioTag,
        personaId: ministerFor(state.offices, portfolioTag),
        conceded: state.ministerConcessions?.[decision.taskId] ?? false,
        carried: true,
        collectiveResponsibility: cfg.cabinet?.collectiveResponsibility ?? DEMOCRATIC_DEFAULTS.cabinet.collectiveResponsibility,
      });

      if (dissent) {
        const replacement = state.offices
          ? replaceMinister(state.offices, portfolioTag, cfg.offices?.candidatesPerOffice ?? DEMOCRATIC_DEFAULTS.offices.candidatesPerOffice)
          : null;
        if (replacement) state.offices = replacement.register;

        ctx.ledger.record('cabinet_dissent', {
          portfolioTag: dissent.portfolioTag,
          personaId: dissent.personaId,
          resigned: dissent.resigned,
          rationale: dissent.rationale,
        });
        ctx.addFinding({
          source: dissent.personaId,
          taskId: decision.taskId,
          summary: `The Minister for ${portfolioTag} conceded the Opposition's objection on a motion the House carried, and resigned the portfolio.`,
          evidenceRefs: [`cabinet:${portfolioTag}`],
          disposition: 'unresolved',
          dispositionRationale: 'Formal dissent under collective responsibility; preserved with the decision under article 8.',
          minority: true,
        });
      }
    }

    // Section 11's confidence. The portfolio-level swap below answers for one brief; this answers
    // for the government as a whole, which is the thing that holds office by confidence.
    if (defeatedThisRound) {
      state.governmentFailures = (state.governmentFailures ?? 0) + 1;
      if (confidenceMotionDue(state.governmentFailures, cfg)) {
        await this.putTheQuestionOfConfidence(ctx, cfg);
        state.governmentFailures = 0;
      }
    } else if (decision.outcome === 'approved') {
      state.governmentFailures = 0;
    }

    // Confidence mechanism: track consecutive rejections per portfolio. Crossing the
    // configured threshold logs a `confidence_vote` ledger event and "swaps" that portfolio's
    // minister persona — implemented purely as changing which personaId future committee
    // dispatches for that portfolio use (read back via getPortfolioPersonaId), never hardcoded.
    if (defeatedThisRound) {
      const failures = (state.portfolioFailures ??= {});
      failures[portfolioTag] = (failures[portfolioTag] ?? 0) + 1;
      const swapThreshold = cfg.confidenceVote?.consecutiveFailuresBeforeSwap ?? DEMOCRATIC_DEFAULTS.confidenceVote.consecutiveFailuresBeforeSwap;

      if (failures[portfolioTag] >= swapThreshold) {
        const versions = (state.portfolioVersions ??= {});
        versions[portfolioTag] = (versions[portfolioTag] ?? 1) + 1;
        const ministers = (state.portfolioMinisters ??= {});
        const outgoingPersonaId = ministers[portfolioTag] ?? `committee-${portfolioTag}`;
        const incomingPersonaId = `committee-${portfolioTag}-v${versions[portfolioTag]}`;
        ministers[portfolioTag] = incomingPersonaId;

        ctx.ledger.record('confidence_vote', {
          portfolioTag,
          consecutiveFailures: failures[portfolioTag],
          outgoingPersonaId,
          incomingPersonaId,
          note: `Portfolio "${portfolioTag}" lost confidence after ${failures[portfolioTag]} consecutive rejections; minister considered swapped for future committee dispatches.`,
        });
        failures[portfolioTag] = 0;
      }
    } else if (decision.outcome === 'approved') {
      // A clean approval restores some confidence rather than leaving old failures dangling
      // forever — otherwise a single old rejection would count toward a swap threshold years
      // (well, tasks) later even after a run of clean approvals in between.
      const failures = (state.portfolioFailures ??= {});
      if (failures[portfolioTag]) failures[portfolioTag] = 0;
    }

    // Question Time: every questionTimeEveryNTasks completed (approved-or-rejected) tasks,
    // compute a free (no LLM call) deterministic summary from graph + ledger-tracked fileOps data.
    // A motion put to a human is requeued, if refused, carrying the refusal — whose rationale names
    // this attempt's required changes. The directive left from the attempt before would otherwise
    // be shown alongside it as the latest one.
    if (decision.outcome === 'needs_human' && state.recommittals) delete state.recommittals[decision.taskId];
    // A remediation directive is the only record of why a carried motion was reopened. The engine
    // reports a rejection it reworks here as `rejected`, so clearing it on that too left a reopened
    // motion's third attempt with no idea what the delivery had found wrong. Only settling it does.
    if (decision.outcome === 'approved' && state.remediationDirectives) delete state.remediationDirectives[decision.taskId];
    if (decision.outcome === 'approved' || decision.outcome === 'rejected') {
      if (state.recommittals) delete state.recommittals[decision.taskId];
      state.completedTaskCount = (state.completedTaskCount ?? 0) + 1;

      // Section 8: recall for persistent misrepresentation. A member that keeps carrying motions the
      // House then has to refuse is not representing its constituency, whatever its intentions —
      // and unlike the government, it does not hold its seat by confidence, so the constituency
      // takes it back directly.
      const recallAt = cfg.confidence?.representativeRecallFailures ?? DEMOCRATIC_DEFAULTS.confidence.representativeRecallFailures;
      for (const [constituency, count] of Object.entries(state.representativeDepartures ?? {})) {
        if (count < recallAt || !state.offices) continue;
        const recalled = recallRepresentative(state.offices, constituency, cfg.offices?.candidatesPerOffice ?? DEMOCRATIC_DEFAULTS.offices.candidatesPerOffice);
        if (!recalled) continue;
        state.offices = recalled.register;
        if (cfg.offices?.constituentBallots) {
          await this.electRepresentatives(ctx, cfg, [constituency],
            `recall-${state.completedTaskCount}`, { [constituency]: recalled.outgoing });
        }
        state.representativeDepartures![constituency] = 0;
        ctx.ledger.record('representative_recalled', {
          constituency,
          outgoing: recalled.outgoing,
          incoming: recalled.incoming,
          misrepresentations: count,
        });
      }

      // Article 9: offices are temporary. The term ends on a fixed cadence and the whole selection
      // runs again — an incumbent with a good record may well be returned, but never by inertia.
      // The outgoing term's record is filed first, so the election that follows can read it.
      if (state.offices && shouldRotate(state.completedTaskCount, cfg)) {
        const outgoing = state.offices;
        this.fileTermRecord(ctx, outgoing);
        const incoming = rotateOffices(outgoing, {
          seed: lotSeed(ctx),
          cfg,
          performance: readOfficePerformance(ctx.knowledge),
          constitutedAt: new Date().toISOString(),
        });
        const { register } = repairSeparationBreaches(incoming, cfg.offices?.candidatesPerOffice ?? DEMOCRATIC_DEFAULTS.offices.candidatesPerOffice);
        if (cfg.offices?.constituentBallots && state.executiveMandateId) {
          revokeGovernanceMandate(ctx.runState, ctx.ledger, state.executiveMandateId);
        }
        state.offices = register;
        await this.electCoordinator(ctx, cfg);
        await this.electRepresentatives(ctx, cfg, frozenElectorate(state, cfg), `term-${register.termId}`);
        ctx.ledger.record('offices_rotated', {
          termId: register.termId,
          rotated: [register.primeCoordinator, register.speaker, ...Object.values(register.representatives)],
          method: 'term expiry',
        });
      }

      const everyN = Math.max(1, cfg.questionTimeEveryNTasks ?? DEMOCRATIC_DEFAULTS.questionTimeEveryNTasks);
      if (state.completedTaskCount % everyN === 0) {
        const summary = computeQuestionTime(
          {
            graph: ctx.runState.graph,
            state,
            constituencies: frozenElectorate(state, cfg),
            evidence: ctx.runState.evidence ?? [],
            findings: ctx.findings(),
            costUsd: ctx.runState.costUsd,
            budgetUsd: ctx.runState.budgetUsd,
            workerCalls: ctx.runState.workerCalls,
          },
          new Date().toISOString(),
        );
        state.questionTime = summary;
        ctx.ledger.record('question_time', summary as unknown as Record<string, unknown>);
      }
    }
  }

  /**
   * A defeated motion is recommitted, not settled here. Its one deterministic close-division
   * appeal is heard, and the resulting repair record is placed before both institutions in the
   * next ordinary assign/execute cycle.
   */
  async recover(ctx: EngineContext, request: RecoveryRequest): Promise<void> {
    const state = asStrategyState(ctx);
    const taskId = request.product.taskId;
    const appealResult = this.hearAppeal(ctx, state, taskId);
    const appealGranted = appealResult ?? state.appealOutcomes?.[taskId] ?? false;

    // A `rejected` motion reaches here with the engine's directive — the rationale and the failing
    // checks' names — in place of the House's own. An Opposition reject at medium or high severity,
    // the very case that draws a minister's reply, always goes that way, so a concession was lost
    // exactly where it mattered. The House's wording is added back; on a doctrine-issued rework it
    // is already present and dedupes away.
    const meta = request.product.assignment.meta as DemocraticAssignmentMeta | undefined;
    const governance = meta ? governanceRequirements(meta, request.review) : [];
    (state.recommittals ??= {})[taskId] = {
      requiredChanges: dedupe([...request.decision.rework.requiredChanges, ...governance]),
      attemptNumber: request.attemptNumber,
      maxAttempts: request.maxAttempts,
      repeated: request.repeated,
      appealGranted,
      lastAttempt: {
        checksPassed: request.test.ran && request.test.passed === true,
        oppositionVerdict: request.review.meta?.oppositionVerdict as 'approve' | 'reject' | 'flag' | undefined,
      },
    };
    ctx.ledger.record('motions_recommitted', {
      cycle: request.attemptNumber,
      taskIds: [taskId],
      findings: request.decision.rework.requiredChanges,
      appealGranted,
    });
  }

  requiresHumanApproval(_ctx: EngineContext, decision: Decision): boolean {
    return decision.outcome === 'needs_human';
  }

  // ---------- acceptance barriers ----------

  /**
   * The dependency and ownership map section 8 requires the Prime Coordinator and Cabinet to
   * publish before dispatch. Portfolios are the constituencies here, so a motion's ownership is its
   * declared file paths plus the portfolio that will answer for them; overlaps between motions in
   * the same portfolio are declared up front rather than discovered as collisions later.
   */
  async declareOwnership(ctx: EngineContext, graph: TaskGraph): Promise<OwnershipMap> {
    const state = asStrategyState(ctx);
    return runOwnershipDeclaration(ctx, graph, {
      interfacesFor: (entry) => [`portfolio:${state.taskMeta?.[entry.taskId]?.portfolioTag ?? 'general'}`],
      overlapRationale: 'Declared shared surface: multiple motions in the authorised programme name this path.',
    });
  }

  /** Section 10: "the Integration Committee, not an individual portfolio, integrates" and inspects
   * the aggregate diff. Never one of the implementers. */
  async integrate(ctx: EngineContext, approvedTaskIds: string[], diffText: string): Promise<IntegrationResult> {
    return runIntegrationBarrier(ctx, approvedTaskIds, diffText, {
      integratorId: 'integration-committee',
      systemPrompt: integrationCommitteeSystemPrompt(),
      buildUserPrompt: integrationCommitteeUserPrompt,
    });
  }

  /** A verifier the Commons appoints from outside the authorship chain — section 10's "at least one
   * verifier who did not author the relevant change". */
  async verifyDelivery(ctx: EngineContext, draft: DeliveryPacket): Promise<VerificationResult> {
    const result = await runVerificationBarrier(ctx, draft, {
      verifierId: 'commons-verifier',
      systemPrompt: commonsVerifierSystemPrompt(),
      buildUserPrompt: commonsVerifierUserPrompt,
    });
    // Kept for the second chamber, which sits at the next barrier. `runState.delivery` is not
    // written until after acceptance, so this draft is the only place the integrated tree's check
    // results exist while the House of Review is still able to act on them.
    const stash = asStrategyState(ctx);
    stash.finalChecks = draft.finalChecks;
    // The resolved matrix, for the stage 9 report at the next barrier. `runState.evidence` holds the
    // mandate as written; this holds it as the checks actually settled it, which is the difference
    // between what the House was promised and what it got.
    stash.requirementMatrix = draft.requirementMatrix;
    return result;
  }

  async disposeFindings(ctx: EngineContext, open: Finding[]): Promise<Finding[]> {
    // The second chamber sits before the disposition, so what it raises is answered for in the same
    // pass rather than arriving after every finding already has a disposition.
    await this.conveneHouseOfReview(ctx, open);

    if (open.length === 0) {
      this.reportAfterImplementation(ctx, []);
      return [];
    }
    const { diffText } = await ctx.worktree.diff();

    const result = await ctx.dispatcher.dispatch<WireDispositionReport>({
      role: 'reviewer',
      personaId: 'select-committee-disposition',
      phase: 'institutional',
      systemPrompt: dispositionSystemPrompt(),
      userPrompt: dispositionUserPrompt(
        open.map((f) => ({ id: f.id, source: f.source, summary: f.summary, evidenceRefs: f.evidenceRefs })),
        truncateDiff(diffText, diffBudget(ctx)),
      ),
      schemaDescription: dispositionSchemaDescription,
      validate: validateDispositionReport,
      temperature: 0.2,
    });

    // The committee's dispositions stand as it made them. What the Chair will not allow is for the
    // fact of dissent to be lost along the way — article 8 preserves a minority report with the
    // final decision, whichever way that decision went.
    const disposed = applyDispositions(open, result.value.dispositions);
    const { findings, retained } = retainMinorityReports(open, disposed);
    if (retained.length > 0) {
      ctx.ledger.record('minority_report_retained', {
        findingIds: retained,
        retainedBy: asStrategyState(ctx).offices?.speaker ?? 'speaker',
      });
    }

    this.reportAfterImplementation(ctx, findings);
    return findings;
  }

  /**
   * Section 6's second chamber, sitting after integration and independent verification.
   *
   * It sits only where a revising chamber has something to add — a programme of purely low-risk
   * motions does not convene one, because that dispatch would buy ceremony rather than scrutiny.
   * Its report speaks in findings, and only a constitutional safety objection can stop the
   * delivery; see houseOfReview.ts for why the chamber cannot express itself through `accept()`.
   */
  private async conveneHouseOfReview(ctx: EngineContext, open: Finding[]): Promise<void> {
    const cfg = asDemocraticConfig(ctx);
    const state = asStrategyState(ctx);
    const graph = ctx.runState.graph;
    const riskClasses = graph?.order.map((id) => graph.nodes[id].riskClass) ?? [];
    if (!shouldConvene(riskClasses, cfg)) return;

    const chamberId = state.offices?.houseOfReview[0] ?? 'house-of-review';
    const { diffText } = await ctx.worktree.diff();

    let report: RevisingReport;
    try {
      const result = await ctx.dispatcher.dispatch<RevisingReport>({
        role: 'reviewer',
        personaId: chamberId,
        phase: 'institutional',
        systemPrompt: houseOfReviewSystemPrompt(),
        userPrompt: houseOfReviewUserPrompt(
          ctx.runState.task.goal,
          ctx.runState.task.acceptanceCriteria,
          renderCheckSummary(state.finalChecks ?? [], ctx.checks),
          open.map((f) => ({ id: f.id, source: f.source, summary: f.summary, evidenceRefs: f.evidenceRefs })),
          truncateDiff(diffText, diffBudget(ctx)),
        ),
        schemaDescription: houseOfReviewSchemaDescription,
        validate: validateHouseOfReviewReport,
        temperature: 0.2,
      });
      report = result.value;
    } catch (err) {
      // A chamber that cannot sit raises nothing. It has only delaying and revising powers, so its
      // silence costs the delivery nothing that the Commons and the verifier have not already
      // covered — recorded, so the record does not imply it sat and was content.
      ctx.ledger.record('house_of_review_report', {
        convened: false,
        revisions: 0,
        delayed: 0,
        vetoes: 0,
        rationale: `The second chamber could not sit (${String(err)}).`,
      });
      return;
    }

    const outcome = applyRevisingReport(report, chamberId, state.houseOfReviewDelays ?? 0, cfg);
    for (const finding of outcome.findings) ctx.addFinding(finding);
    state.houseOfReviewDelays = (state.houseOfReviewDelays ?? 0) + outcome.delayed;

    ctx.ledger.record('house_of_review_report', {
      convened: true,
      revisions: outcome.revisions,
      delayed: outcome.delayed,
      vetoes: outcome.vetoes,
      rationale: report.rationale,
    });
  }

  /**
   * The constitutional verification gate of section 10 — deliberately deterministic, and
   * deliberately not a vote. "Release requires a constitutional verification gate independent of
   * ordinary confidence or majority approval… Constitutional requirements, user criteria, and
   * safety constraints cannot be waived by the Cabinet, Commons, committee chair, or a vote."
   */
  /**
   * Section 7 stage 9, and the reason the planner is made to estimate anything.
   *
   * The report is deterministic: asking a model to grade the executive's performance would be asking
   * the executive to mark its own homework with extra steps. Its disclosures go into the delivery
   * manifest through the engine's doctrine-neutral notes channel, so a limitation the House knows
   * about is a limitation Claude is told about.
   *
   * It runs at the disposition barrier rather than at the gate, and that is not cosmetic:
   * `assembleDelivery` reads the notes while building the packet it hands to `accept()`, so a report
   * filed inside `accept()` is written after the only thing that would have read it. Here the
   * dispositions are final and the manifest has not been assembled yet.
   */
  private reportAfterImplementation(ctx: EngineContext, disposed: Finding[]): void {
    const cfg = asDemocraticConfig(ctx);
    const state = asStrategyState(ctx);
    if (!(cfg.accountability?.postImplementationReport ?? DEMOCRATIC_DEFAULTS.accountability.postImplementationReport)) return;

    // The engine merges `disposed` back into the run's findings only after this method returns, so
    // the current picture is those plus anything not in that set — including whatever the second
    // chamber raised a moment ago.
    const disposedIds = new Set(disposed.map((f) => f.id));
    const findings = [...ctx.findings().filter((f) => !disposedIds.has(f.id)), ...disposed];

    const report = reportToTheHouse({
      graph: ctx.runState.graph,
      state,
      evidence: state.requirementMatrix ?? ctx.runState.evidence ?? [],
      findings,
      costUsd: ctx.runState.costUsd,
    });

    ctx.ledger.record('accountability_report', {
      criteriaMet: report.criteriaMet,
      criteriaUnmet: report.criteriaUnmet,
      defects: report.defects,
      costUsd: report.costUsd,
      estimatedCostUsd: report.estimatedCostUsd,
      unresolvedRisks: report.unresolvedRisks,
      lessons: report.lessons,
    });

    const notes = toDeliveryNotes(report);
    // Every motion's stated rollback conditions travel with the manifest, so section 10's "rollback
    // instructions" say what this programme in particular would need undone.
    const rollbackNotes = Object.entries(state.motionEstimates ?? {})
      .filter(([, e]) => e.rollbackConditions)
      .map(([id, e]) => `Motion "${id}" stated its rollback condition as: ${e.rollbackConditions}`);

    // Replaced, never appended to. A remediation cycle files a fresh report on the run as it now
    // stands; accumulating them would put each cycle's limitations in the manifest again, so a run
    // that went round the loop three times would look three times as compromised as it is.
    state.deliveryNotes = {
      limitations: notes.limitations,
      residualRisks: notes.residualRisks,
      rollbackNotes,
    };
  }

  async accept(ctx: EngineContext, draft: DeliveryPacket): Promise<DoctrineAcceptance> {
    const cfg = asDemocraticConfig(ctx);
    const breaches: string[] = [];

    if (!draft.integrationEvidence.integrated) {
      breaches.push(`the Integration Committee did not certify the combined tree (${draft.integrationEvidence.rationale})`);
    }
    if (!draft.independentVerification.verified) {
      breaches.push(`independent verification failed (${draft.independentVerification.rationale})`);
    }
    const untraced = draft.acceptanceCriteria.filter(
      (c) => !draft.independentVerification.criteriaTraced.some((t) => t.trim() === c.trim()),
    );
    if (untraced.length > 0) {
      breaches.push(`the verifier could not trace ${untraced.length} acceptance criterion/criteria to code and evidence`);
    }
    const failing = blockingFailures(draft.finalChecks, ctx.checks);
    if (failing.length > 0) {
      breaches.push(`required check(s) failing on the integrated tree: ${failing.map((f) => f.categoryId).join(', ')}`);
    }
    const nonWaivableOpen = draft.findings.filter((f) => f.nonWaivable && f.disposition !== 'accepted' && f.disposition !== 'rejected');
    if (nonWaivableOpen.length > 0) {
      breaches.push(`${nonWaivableOpen.length} finding(s) on non-waivable constitutional ground remain open`);
    }

    // Article 6, checked against the agents that actually did the work rather than against the
    // office roster. A collision between elected offices cannot occur — each is drawn from its own
    // candidate roster — but the four functions the article names only become real personas here:
    // who implemented, who integrated, who verified. This is where the check has something to find.
    const state = asStrategyState(ctx);
    const implementers = Object.values(state.taskMeta ?? {}).map((m) => `implementer-${m.portfolioTag}`);
    const breachesOfSeparation = separationOfFunctionsBreaches({
      primeCoordinator: state.offices?.primeCoordinator ?? '',
      speaker: state.offices?.speaker ?? '',
      ceremonialHead: state.offices?.ceremonialHead ?? '',
      implementers,
      integrator: draft.integrationEvidence.integratorId,
      verifier: draft.independentVerification.verifierId,
    });
    for (const breach of breachesOfSeparation) {
      ctx.ledger.record('conflict_declared', {
        personaId: breach.personaId,
        offices: breach.offices,
        remedy: breach.remedy,
      });
      breaches.push(`article 6 is breached: "${breach.personaId}" holds both ${breach.offices.join(' and ')}`);
    }

    // The term ends with the run. Rotation files a record when it fires, but a run shorter than one
    // term never rotates — and without this, no election would ever have a record to read and
    // section 8's "election based on recorded performance" would be permanently hypothetical.
    if (state.offices) this.fileTermRecord(ctx, state.offices);

    // The guardian's duty to preserve the charter: the delivery records what this run was actually
    // governed by, rather than a claim that it was governed.
    this.exerciseReservePower(ctx, preservesCharter());

    // Section 14's automatic closure rule against endless deliberation. A delivery that has been
    // round the remediation loop past the charter's limit and still carries an unremedied
    // constitutional finding is not converging, and the guardian puts it in front of the human in
    // whom article 12 vests the decision. It does not roll anything back itself. The ruling goes
    // into the refusal, which is what reaches the owner when the engine ends a run whose delivery
    // its own doctrine will not accept.
    const rollback = authorisesEmergencyRollback({
      remediationCycles: draft.remediationCycles,
      openNonWaivable: nonWaivableOpen,
      cfg,
    });
    if (rollback) {
      this.exerciseReservePower(ctx, rollback);
      breaches.push(`the constitutional guardian applied the closure rule: ${rollback.rationale}`);
    }

    const accepted = breaches.length === 0;
    ctx.ledger.record('constitutional_gate', { accepted, breaches });
    return {
      accepted,
      procedure: 'constitutional verification gate, then assent',
      rationale: accepted
        ? 'The gate confirmed integration, independent verification, criterion traceability, required checks and finding dispositions. Assent granted.'
        : `Assent refused. The gate is not subject to confidence or majority approval, and it found: ${breaches.join('; ')}.`,
      decidedAt: new Date().toISOString(),
    };
  }

  /**
   * Claude's rejection returns the defects to committee for renewed scrutiny — section 10's
   * "Material interaction defects return to the executive for remediation and renewed scrutiny."
   * The motions named by the findings are reopened; the rest of the programme stands.
   */
  async remediate(ctx: EngineContext, packet: RemediationPacket): Promise<TaskGraph> {
    const state = asStrategyState(ctx);
    const graph = ctx.runState.graph!;
    const named = scopedRemediationTargets(graph, packet.findings);
    const targets = named.filter((id) => graph.nodes[id]);
    const register = compactRemediationRegister(packet.findings);

    for (const id of targets) {
      graph.nodes[id].phase = 'queued';
      // remediationOf stays the shared compact register: the engine matches sibling tasks of one
      // remediation by it. The implementer reads the per-task directive with its evidence instead;
      // it used to read neither, and re-ran the reopened motion on its original wording.
      graph.nodes[id].remediationOf = register;
      (state.remediationDirectives ??= {})[id] = remediationNote(packet.findings, id) || register;
      // A recommittal from before the motion carried (or before an ownership handoff abandoned it)
      // describes an attempt the remediation has superseded.
      if (state.recommittals) delete state.recommittals[id];
    }
    ctx.ledger.record('motions_recommitted', {
      cycle: packet.cycle,
      taskIds: targets,
      findings: register,
    });

    this.hearAppeals(ctx, state, graph, packet);
    return graph;
  }

  /**
   * Section 6's right of appeal, exercised where it can still change anything: a delivery has come
   * back, the House is sitting again, and a motion the division defeated narrowly may ask to be
   * put once more.
   *
   * Granted deterministically and only on the narrow ground — a motion defeated on a close division
   * without a serious Opposition objection against it. Once per motion, because an appeal that
   * could be repeated is not an appeal but a way of ignoring the result. A motion the Opposition
   * rejected outright does not qualify: that is not a close-run thing, and the chamber has already
   * heard the argument.
   */
  private hearAppeals(
    ctx: EngineContext,
    state: DemocraticStrategyState,
    graph: TaskGraph,
    packet: RemediationPacket,
  ): void {
    const defeated = packet.preservedDelivery?.decisions.filter((d) => d.outcome === 'rejected') ?? [];

    for (const decision of defeated) {
      const node = graph.nodes[decision.taskId];
      if (!node) continue;
      if (this.hearAppeal(ctx, state, decision.taskId)) {
        node.phase = 'queued';
        node.remediationOf = `${node.remediationOf ?? ''} Appeal granted on a close division.`.trim();
      }
    }
  }

  /**
   * The appeal is the doctrine's existing deterministic close-vote ruling, not a separately
   * convened chamber. It records one ruling per task and leaves lifecycle mutation to its caller.
   */
  private hearAppeal(
    ctx: EngineContext,
    state: DemocraticStrategyState,
    taskId: string,
  ): boolean | null {
    const heard = (state.appealsHeard ??= []);
    if (heard.includes(taskId)) return null;

    const meta = state.taskMeta?.[taskId];
    const division = state.divisions?.[taskId];
    const granted = isCloseDivision(division) && !oppositionRejectedOutright(division);
    heard.push(taskId);
    (state.appealOutcomes ??= {})[taskId] = granted;

    ctx.ledger.record('appeal_recorded', {
      taskId,
      appellant: ministerFor(state.offices, meta?.portfolioTag ?? 'general'),
      granted,
      rationale: granted
        ? 'The division was close and the Opposition did not reject outright, so the motion may be put again.'
        : 'The motion was not defeated narrowly, or the Opposition rejected it outright. The result stands.',
    });
    return granted;
  }

  /** Reads back the current personaId for a portfolio's committee — defaults to committee-<tag>,
   * or the swapped-in persona once a confidence vote has fired for that portfolio. */
  private getPortfolioPersonaId(ctx: EngineContext, portfolioTag: string): string {
    const state = asStrategyState(ctx);
    const ministers = (state.portfolioMinisters ??= {});
    return ministers[portfolioTag] ?? `committee-${portfolioTag}`;
  }

}

/** Small helper so decide()'s openApproval description can name the motion, without threading the
 * title through every call site. */
function nodeTitle(ctx: EngineContext, taskId: string): string {
  return ctx.runState.graph?.nodes[taskId]?.title ?? taskId;
}
