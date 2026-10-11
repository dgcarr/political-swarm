import { fillMissingRationale } from '../validation.js';
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
import { lotSeed } from '../../util/lots.js';
import { BudgetExceededError } from '../../engine/BudgetGuard.js';
import type {
  Assignment,
  Decision,
  DecisionOutcome,
  ReviewFinding,
  ReviewResult,
  TaskGraph,
  TaskNode,
  TaskSpec,
  TestResult,
  WorkProduct,
} from '../../engine/types.js';
import {
  BidSchema,
  ImplementerOutputSchema,
  PlannerOutputSchema,
  ReviewerOutputSchema,
  type Bid,
  type CapitalAccount,
  type CapitalistConfig,
  type CapitalistStrategyState,
  type ImplementerOutput,
  type PlannerOutput,
  type RetenderRound,
  type ReviewerOutput,
} from './types.js';
import {
  BIDDER_SYSTEM_PROMPT,
  BID_SCHEMA_DESCRIPTION,
  IMPLEMENTER_SCHEMA_DESCRIPTION,
  IMPLEMENTER_SYSTEM_PROMPT,
  PLANNER_SCHEMA_DESCRIPTION,
  PLANNER_SYSTEM_PROMPT,
  REVIEWER_SCHEMA_DESCRIPTION,
  REVIEWER_SYSTEM_PROMPT,
  buildBidderUserPrompt,
  buildImplementerUserPrompt,
  buildPlannerUserPrompt,
  buildReviewerUserPrompt,
  ACCEPTANCE_SCHEDULE_SYSTEM_PROMPT,
  TEST_MANDATE_SYSTEM_PROMPT,
  CONTRACTUAL_ASSESSOR_SYSTEM_PROMPT,
  INTEGRATION_ASSESSOR_SYSTEM_PROMPT,
  ARBITRATOR_SYSTEM_PROMPT,
  buildArbitratorUserPrompt,
  SUBCONTRACTOR_SYSTEM_PROMPT,
  buildSubcontractorUserPrompt,
  buildAcceptanceScheduleUserPrompt,
  buildContractualAssessorUserPrompt,
  buildIntegrationAssessorUserPrompt,
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
import { blockingFailures } from '../../engine/checks.js';
import { digestArtifact, nextGovernanceDecisionId, recordGovernanceDecision } from '../../engine/governance.js';
import type { DispatchResult } from '../../engine/WorkerDispatcher.js';
import {
  emptyConsumption,
  priceConsumption,
  profitAndLoss,
  resolvePriceList,
  type ResourceConsumption,
} from './prices.js';
import { inspectRepository, renderDiligence } from './diligence.js';
import {
  applyRuling,
  arbitrationSchemaDescription,
  detectDisputes,
  supplierPrevailed,
  validateRuling,
  type Adjudication,
  type WireRuling,
} from './arbitration.js';
import { creditLimit, drawCredit, openCreditBook, outstandingCredit, repayCredit, resolveCreditPolicy } from './credit.js';
import { buildMarketReport, toDeliveryNotes } from './marketReport.js';
import {
  collectLevy,
  considerBailout,
  openTreasury,
  resolveTreasuryPolicy,
  subsidizeExperimentListing,
  subsidizePublicGoodListing,
  treasuryBalance,
} from './treasury.js';
import {
  collectPremium,
  insuranceRequired,
  openReserve,
  payClaim,
  premiumFor,
  resolveInsurancePolicy,
} from './insurance.js';
import {
  applySettlement,
  claimWarranty,
  assessInsolvency,
  domainReputation,
  eligibleForHighRisk,
  openAccount,
  resolveCapitalPolicy,
  type CapitalPolicy,
} from './capital.js';
import {
  deliveryMissedDeadline,
  hasMeasurableCriterion,
  overSpendCap,
  payableRevenue,
  resolveContractPolicy,
  retentionFor,
  selectContractType,
  type ContractTerms,
} from './contracts.js';
import {
  formFirm,
  integrableListings,
  mergeSubcontractedOps,
  subcontractorsOf,
  type Firm,
} from './firms.js';
import {
  bidderCapabilities,
  buildListing,
  renderListing,
  scoreBid,
  specialistsAvailable,
  withinBudget,
  type Listing,
} from './exchange.js';
import {
  antitrustBreaches,
  marketConcentration,
  markNonWaivableFindings,
  publicGoodsUnderfunded,
  regulatorOverreach,
  scopeBreaches,
  undisclosedRisk,
  unpricedConsumption,
  unpricedExternalities,
} from './constitution.js';
import { IMPLEMENTER_TEMPERATURE } from '../implementerReminders.js';
import { remediationNote } from '../../engine/remediationNote.js';
import { CAPITALIST_DEFAULTS } from '../../constitution/schema.js';

/**
 * How many failed contracts' required changes a re-tender carries. Enough that a firm sees the fix
 * an earlier round made before it undoes it; bounded, because every bid on the listing pays for it.
 */
const RETENDER_ROUNDS = 3;

/**
 * Per required change, in a bidder's prompt. A bidder prices the work and never sees the engine's
 * repair brief, so it gets the gist of each change; the winner gets them in full with the brief.
 */
const BIDDER_CHANGE_CHARS = 300;

/** The charter's own citation for the delivery safety floor, quoted in findings and the ledger. */
const SAFETY_FLOOR_ARTICLE = 'article 11';

/**
 * Capitalist governance strategy: an internal task exchange. Listings (TaskNodes) are put up for
 * bid; a deterministic, non-LLM expected-value function awards each listing to a bidder; winners
 * post conceptual escrow against the contract price; an independent reviewer plus a deterministic
 * "regulator" check settle the contract; capital/reputation/escrow bookkeeping lives in
 * ctx.strategyState so it persists across the run (and would across resumed runs, since RunStore
 * round-trips it through state.json).
 *
 * The market's own law lives in constitution.ts — section 12's twelve articles as predicates rather
 * than prose. Article 3 is applied at review, article 4 and article 10 at the acceptance gate, and
 * the reported articles travel to the market report rather than blocking a sound delivery.
 *
 * KNOWN GAP: what article 4 enforces is self-dealing and essential-facility capture — one party
 * standing on both sides of a transaction it is paid for, which is visible in a single run's
 * register. Bid *collusion* between nominally independent bidders is not enforced: it is a logged
 * statistical flag at most (see trackCollusionWatch below), because distinguishing a cartel from
 * three bidders who happen to price similarly needs cross-run history this runtime does not keep.
 */
export class CapitalistStrategy implements SwarmStrategy {
  readonly id = 'capitalist' as const;


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
        personaId: 'acceptance-terms',
        systemPrompt: TEST_MANDATE_SYSTEM_PROMPT,
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

  async plan(ctx: EngineContext, task: TaskSpec): Promise<TaskGraph> {
    const config = getConfig(ctx);
    const state = getState(ctx);

    // Section 9's due diligence, before anything is listed. It reads the baseline the engine already
    // recorded rather than running its own: the same commands against the same tree, so a second
    // opinion would spend the run's budget to learn what is on the record already.
    const diligence = inspectRepository(
      // Test-layout probes (TEST_LAYOUT_PROBES) name directories as often as files (e.g. 'tests'),
      // so presence alone must count even when there's no file content to read.
      (relPath) => ctx.worktree.readFileIfExists(relPath) ?? (ctx.worktree.pathExists(relPath) ? '' : null),
      ctx.checks,
      ctx.runState.baseline ?? [],
    );
    state.diligence = diligence;
    ctx.ledger.record('diligence_completed', {
      instructions: diligence.instructions,
      manifests: diligence.manifests,
      declaredTestCommand: diligence.declaredTestCommand ?? null,
      ciConfigs: diligence.ciConfigs,
      testLayout: diligence.testLayout,
      applicableChecks: diligence.applicableChecks,
      excludedChecks: diligence.excludedChecks,
      scopeUnderstood: diligence.scopeUnderstood,
    });

    // Acceptance terms are fixed before bidding closes, so no bid can be won by omitting them.
    await this.recordTestMandate(ctx, task);

    try {
      const result = await ctx.dispatcher.dispatch<PlannerOutput>({
        role: 'planner',
        personaId: 'planner',
        systemPrompt: PLANNER_SYSTEM_PROMPT,
        userPrompt: buildPlannerUserPrompt(task),
        schemaDescription: PLANNER_SCHEMA_DESCRIPTION,
        validate: (value) => {
          PlannerOutputSchema.parse(value);
        },
        temperature: 0.2,
      });

      if (result.value.tasks.length === 0) throw new Error('Planner returned zero tasks');

      const graph = emptyGraph();
      const finalIds = dedupeSlugs(result.value.tasks.map((t) => slugify(t.id || t.title)));
      const idSet = new Set(finalIds);

      result.value.tasks.forEach((raw, i) => {
        const id = finalIds[i];
        const targetGlobs = raw.targetGlobs && raw.targetGlobs.length > 0 ? raw.targetGlobs : ['**/*'];
        const riskClass = classifyRiskByPaths(targetGlobs, {
          securityPathGlobs: config.riskClassification.securityPathGlobs,
        });
        const dependsOn = (raw.dependsOn ?? []).map(slugify).filter((d) => idSet.has(d) && d !== id);
        addNode(graph, {
          id,
          title: raw.title,
          description: raw.description,
          acceptanceCriteria:
            raw.acceptanceCriteria && raw.acceptanceCriteria.length > 0 ? raw.acceptanceCriteria : task.acceptanceCriteria,
          dependsOn,
          targetGlobs,
          riskTags: [],
          riskClass,
          phase: 'queued',
          attempts: [],
        });
      });

      ctx.ledger.record('plan_source', { source: 'planner-llm', nodeCount: graph.order.length });
      return graph;
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      ctx.ledger.record('plan_fallback', { reason: String(err) });
      return fallbackGraph(task, config);
    }
  }

  async assign(ctx: EngineContext, graph: TaskGraph): Promise<Assignment[]> {
    const config = getConfig(ctx);
    const state = getState(ctx);
    const assignments: Assignment[] = [];
    const awardedThisRound: string[] = [];

    // First: unblock any high-risk listings whose spend approval has since been resolved by a
    // human via swarm_decide. We look at ALL blocked nodes here (not just readyNodes(), which
    // excludes blocked nodes by definition) since that's the only way a node we blocked
    // ourselves gets reconsidered.
    for (const id of graph.order) {
      const node = graph.nodes[id];
      if (node.phase !== 'blocked') continue;
      const approvalId = state.approvals[id];
      if (!approvalId) continue; // blocked for some other reason; not ours to touch
      const resolution = ctx.getApprovalResolution(approvalId);
      if (!resolution?.resolvedAt) continue; // still waiting on the human
      if (resolution.resolution === 'reject') {
        node.phase = 'abandoned';
      } else {
        node.phase = 'queued'; // approve or modify: proceed to bidding this round
      }
    }

    for (const node of readyNodes(graph)) {
      // Already absorbed into a firm earlier in this round — it has a contractor, and re-auctioning
      // it would sell the same work twice.
      if (awardedThisRound.includes(node.id)) continue;

      const warrantyRepair = state.warrantyRepairs[node.id];
      if (warrantyRepair) {
        const contractor = getAccount(ctx, state, warrantyRepair.assignment.assigneeId, config.initialCapital);
        if (!contractor.bankrupt && !isContractorExcluded(state, node.id, contractor.personaId)) {
          assignments.push({
            ...warrantyRepair.assignment,
            taskId: node.id,
            meta: {
              ...warrantyRepair.assignment.meta,
              warrantyRepair: { requiredChanges: [...warrantyRepair.requiredChanges] },
            },
          });
          awardedThisRound.push(node.id);
          continue;
        }
        // The repair order lapses with its contractor; the defect it named does not. recover() has
        // normally entered it in the listing's history already.
        recordRetenderRound(state, node.id, warrantyRepair.attempt ?? 0, warrantyRepair.requiredChanges);
        delete state.warrantyRepairs[node.id];
      }

      // High-risk gate: the first time we see a high-risk listing ready, open a spend approval
      // and block it rather than soliciting bids. state.approvals[node.id] being unset is what
      // distinguishes "first time" from "just came back approved" (in which case the node was
      // already put back into the queue by the unblock pass above, and we fall through to bidding).
      if (
        node.riskClass === 'high' &&
        config.riskClassification.highRiskRequiresSpendApproval &&
        !state.approvals[node.id]
      ) {
        const approval = ctx.openApproval({
          kind: 'spend_approval',
          taskId: node.id,
          description: `High-risk listing "${node.title}" touches security-sensitive paths (${node.targetGlobs.join(
            ', ',
          )}). Human spend approval is required before the task exchange opens this listing for bids.`,
        });
        state.approvals[node.id] = approval.id;
        node.phase = 'blocked';
        continue;
      }

      // The listing, with every term section 6 requires. Built before the call for bids, because a
      // term disclosed after tender is not a term anybody bid against.
      const listing = buildListing(node, config.listingTerms);
      const priorRounds = state.retenderRequiredChanges[node.id] ?? [];
      // The contract shape is chosen before the call for bids, because a bidder prices the terms as
      // much as the work: what is withheld, for how long, and whether there is a cap all change what
      // the contract is worth taking on.
      const terms = selectContractType(
        {
          listing,
          scopeUnderstood: state.diligence?.scopeUnderstood ?? true,
          hasMeasurableCriterion: hasMeasurableCriterion(listing.acceptanceCriteria),
          tournamentRequested: false,
        },
        resolveContractPolicy(config.contractPolicy),
      );
      state.contractTerms[node.id] = terms;
      ctx.ledger.record('listing_published', {
        taskId: node.id,
        contractType: terms.type,
        retentionFraction: terms.retentionFraction,
        budget: listing.availableBudget,
        deadlineMinutes: listing.deadlineMinutes,
        warrantyPeriodTasks: terms.warrantyPeriodTasks,
        requiredCapabilities: listing.requiredCapabilities,
        risk: terms.risk,
      });

      // Sealed bids are 41% of this doctrine's model calls — 175 of them to make 72 awards, three
      // per listing whatever was being bought. Two sealed bids on a low-risk listing is still a
      // competitive tender; a third is ceremony. Medium and high risk keep the full field, as do
      // the capital floor, exclusion, escrow, warranty and insurance, none of which change.
      const bidCount = node.riskClass === 'low'
        ? Math.max(2, Math.min(config.bidCount, config.lowRiskBidCount))
        : config.bidCount;
      // Free entry. Every firm excluded from a listing for its own failure is replaced by one
      // entrant, so the market keeps bidCount firms competing for the work rather than shrinking
      // toward nobody. Without this the pool is exactly bidCount and each failure retires a firm
      // permanently, so a listing could never be re-tendered more than bidCount times: a real run
      // exhausted the market on its second attempt at two dependency-free modules and terminated
      // with four attempts still allowed and no reason recorded beyond "no task remained runnable".
      // Exclusion, insolvency and the high-risk capital floor all still apply — a firm that failed
      // here never bids here again. What changes is that unmet demand attracts a new competitor,
      // which is the market's own answer to a supplier that has withdrawn.
      const retiredHere = state.excludedContractors[node.id]?.length ?? 0;
      const personaPool = Array.from({ length: bidCount + retiredHere }, (_, i) => `bidder-${i + 1}`);
      if (retiredHere > 0) {
        ctx.ledger.record('market_entry', {
          taskId: node.id,
          entrants: retiredHere,
          reason: 'incumbent firms excluded for prior failure on this listing',
        });
      }
      const capitalPolicy = resolveCapitalPolicy({
        initialCapital: config.initialCapital,
        capitalFloorForHighRisk: config.capitalFloorForHighRisk,
        retentionReleaseAfterCleanTasks: config.escrowReleaseAfterCleanTasks,
        ...config.capitalPolicy,
      });
      // Free entry again, now for the other way a market empties. Exclusion is per listing, but
      // insolvency and the capital floor are global: three firms that spent themselves failing one
      // hard task leave every LATER listing unfillable, including tasks they never touched. A real
      // run released damage-calc the moment its dependency was abandoned, published the listing,
      // and got "no eligible bidders" on a task with no exclusions of its own — the market had gone
      // bankrupt around it. Unmet demand attracts entrants until someone can bid, capped so a
      // genuinely unservable listing still fails rather than conjuring firms forever.
      let pool = personaPool;
      let eligible = eligibleBidderIds({ ctx, state, node, config, capitalPolicy, personaPool: pool });
      for (let entrants = 1; eligible.length === 0 && entrants <= bidCount; entrants += 1) {
        pool = Array.from({ length: pool.length + 1 }, (_, i) => `bidder-${i + 1}`);
        eligible = eligibleBidderIds({ ctx, state, node, config, capitalPolicy, personaPool: pool });
        if (eligible.length > 0) {
          ctx.ledger.record('market_entry', {
            taskId: node.id,
            entrants,
            reason: 'incumbent firms could not bid (excluded, insolvent, or below the capital floor)',
          });
        }
      }
      const roster = eligible.map((personaId) => ({
        personaId,
        capabilities: bidderCapabilities(personaId, config.specialisations),
      }));
      const specialists = specialistsAvailable(listing, roster);

      if (eligible.length === 0) {
        const reason =
          'no eligible bidders (all excluded, insolvent, or below the capital floor for high-risk work)';
        state.unfilledListings.push({ taskId: node.id, reason });
        ctx.ledger.record('listing_unfilled', { taskId: node.id, reason });
        continue;
      }

      const solicitBids = async (): Promise<Array<{ personaId: string; bid: Bid }>> => {
        const bidOutcomes = await Promise.all(eligible.map(async (personaId) => {
          try {
            const account = getAccount(ctx, state, personaId, config.initialCapital);
            const result = await ctx.dispatcher.dispatch<Bid>({
              role: 'bidder',
              personaId,
              systemPrompt: BIDDER_SYSTEM_PROMPT,
              userPrompt: buildBidderUserPrompt(
                ctx.runState.task.goal,
                renderListing(listing),
                bidderCapabilities(personaId, config.specialisations),
                state.diligence ? renderDiligence(state.diligence) : undefined,
                node.remediationOf,
                {
                  capital: account.capital,
                  liabilities: account.liabilities ?? 0,
                  settlements: account.settlements ?? 0,
                  defects: account.defects,
                },
                retenderLines(priorRounds, BIDDER_CHANGE_CHARS),
              ),
              schemaDescription: BID_SCHEMA_DESCRIPTION,
              validate: (value) => {
                BidSchema.parse(value);
              },
              temperature: 0.5,
            });
            return { personaId, bid: result.value };
          } catch (err) {
            if (err instanceof BudgetExceededError) throw err;
            ctx.ledger.record('bid_failed', { taskId: node.id, personaId, error: String(err) });
            return null;
          }
        }));
        const received = bidOutcomes.filter((b): b is { personaId: string; bid: Bid } => b !== null);
        ctx.ledger.record('bids_received', {
          taskId: node.id, budget: listing.availableBudget,
          bids: received.map((b) => ({ personaId: b.personaId, ...b.bid })),
        });
        return received;
      };

      let bids = await solicitBids();

      if (bids.length === 0) {
        state.unfilledListings.push({ taskId: node.id, reason: 'no valid bids received' });
        ctx.ledger.record('listing_unfilled', { taskId: node.id, reason: 'no valid bids received' });
        continue;
      }

      // A bid above the published budget is refused rather than merely scored down: the buyer said
      // what it would pay, and a budget that can be outbid was never a term of the listing.
      let admissible = bids.filter((b) => withinBudget(b.bid, listing));
      let appliedGrant: { good: string; amount: number; fund: 'publicGoodsFund' | 'venturePool' } | null = null;
      if (admissible.length === 0) {
        const cheapest = Math.min(...bids.map((bid) => bid.bid.priceTokens));
        const publicGrant = subsidizePublicGoodListing(state.treasury, {
          taskId: node.id, title: node.title, paths: node.targetGlobs,
          publishedBudget: listing.availableBudget, cheapestBid: cheapest,
          outstandingCredit: outstandingCredit(state.creditBook), reserveBalance: state.reserve.balance,
        }, resolveTreasuryPolicy(config.treasuryPolicy));
        const experimentGrant = publicGrant ? null : subsidizeExperimentListing(state.treasury, {
          taskId: node.id, title: node.title, publishedBudget: listing.availableBudget,
          cheapestBid: cheapest, outstandingCredit: outstandingCredit(state.creditBook),
          reserveBalance: state.reserve.balance, scopeUnderstood: state.diligence?.scopeUnderstood ?? true,
        });
        if (publicGrant || experimentGrant) {
          appliedGrant = publicGrant
            ? { ...publicGrant, fund: 'publicGoodsFund' }
            : { good: `experiment: ${node.title}`, amount: experimentGrant!.amount, fund: 'venturePool' };
          const originalBudget = listing.availableBudget;
          listing.availableBudget += appliedGrant.amount;
          state.treasuryBalance = treasuryBalance(state.treasury);
          if (publicGrant) {
            ctx.ledger.record('public_good_granted', {
              taskId: node.id, good: appliedGrant.good, amount: appliedGrant.amount, originalBudget,
              amendedBudget: listing.availableBudget, evidenceRefs: [`listing:${node.id}`],
            });
          } else {
            ctx.ledger.record('venture_experiment_commissioned', {
              taskId: node.id, good: appliedGrant.good, amount: appliedGrant.amount, originalBudget,
              amendedBudget: listing.availableBudget, evidenceRefs: [`listing:${node.id}`],
              publicationObligation: experimentGrant!.publicationObligation,
            });
          }
          ctx.ledger.record('listing_republished', {
            taskId: node.id, budget: listing.availableBudget,
            reason: publicGrant ? 'public-good grant' : 'venture experiment commission',
          });
          bids = await solicitBids();
          admissible = bids.filter((bid) => withinBudget(bid.bid, listing));
        }
      }
      const overBudget = bids.filter((b) => !withinBudget(b.bid, listing));
      if (overBudget.length > 0) {
        ctx.ledger.record('bids_refused', {
          taskId: node.id,
          budget: listing.availableBudget,
          refused: overBudget.map((b) => ({ personaId: b.personaId, priceTokens: b.bid.priceTokens })),
        });
      }
      if (admissible.length === 0) {
        if (appliedGrant) {
          const grantIndex = state.treasury.grants.findIndex((entry) =>
            entry.taskId === node.id && entry.amount === appliedGrant!.amount && entry.good === appliedGrant!.good);
          if (grantIndex >= 0) state.treasury.grants.splice(grantIndex, 1);
          state.treasury[appliedGrant.fund] = Math.round((state.treasury[appliedGrant.fund] + appliedGrant.amount) * 100) / 100;
          state.treasuryBalance = treasuryBalance(state.treasury);
          if (appliedGrant.fund === 'publicGoodsFund') {
            ctx.ledger.record('public_good_grant_reversed', {
              taskId: node.id, amount: appliedGrant.amount, reason: 'amended tender received no admissible bid',
            });
          } else {
            ctx.ledger.record('venture_experiment_reversed', {
              taskId: node.id, amount: appliedGrant.amount, reason: 'amended tender received no admissible bid',
            });
          }
        }
        const reason = bids.length === 0
          ? 'no valid bids received for the amended tender'
          : `every bid exceeded the published budget of ${listing.availableBudget} tokens`;
        state.unfilledListings.push({ taskId: node.id, reason });
        ctx.ledger.record('listing_unfilled', { taskId: node.id, reason });
        continue;
      }

      const allBids = admissible.map((b) => b.bid);
      let winner = admissible[0];
      let winnerScore = -Infinity;
      let winnerTerms: Record<string, number> = {};
      for (const candidate of admissible) {
        const account = getAccount(ctx, state, candidate.personaId, config.initialCapital);
        // Reputation for *this* listing's domains, decayed — not one flat lifetime score. A firm
        // with an excellent security record is not thereby a good documentation supplier.
        const domains = listing.requiredCapabilities;
        const standing = {
          ...account,
          reputationScore:
            domains.reduce((sum, d) => sum + domainReputation(account, d, capitalPolicy), 0) /
            Math.max(1, domains.length),
        };
        const scored = scoreBid(candidate.bid, standing, {
          listing,
          allBids,
          queueLength: openContractsHeldBy(ctx, state, candidate.personaId),
          specialistsAvailable: specialists,
          holdsDependency: listing.dependencies.some((dep) => state.register.contractors[dep] === candidate.personaId),
          capabilities: bidderCapabilities(candidate.personaId, config.specialisations),
        });
        if (scored.score > winnerScore) {
          winnerScore = scored.score;
          winner = candidate;
          winnerTerms = scored.terms;
        }
      }

      ctx.ledger.record('listing_awarded', {
        taskId: node.id,
        personaId: winner.personaId,
        score: winnerScore,
        terms: winnerTerms,
        bid: winner.bid,
      });
      // Numbered by tender, not by attempt: an award whose batch never ran leaves no attempt behind,
      // and its re-tender is a new decision on new bids.
      recordGovernanceDecision(ctx.runState, ctx.ledger, {
        id: nextGovernanceDecisionId(ctx.runState, `award:${node.id}:`),
        body: 'task-exchange',
        subject: node.id,
        artifactDigest: digestArtifact(listing),
        rule: 'published-weighted-bid-score',
        eligible: admissible.map((candidate) => candidate.personaId),
        positions: admissible.map((candidate) => ({ actor: candidate.personaId, choice: String(candidate.bid.priceTokens) })),
        evidenceRefs: [`listing:${node.id}`, `bids:${node.id}`],
        result: winner.personaId,
        nextAction: 'contract-award',
      });
      trackCollusionWatch(ctx, state, winner.personaId);

      // A re-tendered contract's resource accounting starts fresh for its new holder. Without
      // this, consumptionFor's per-taskId accumulator kept every predecessor's spend on the
      // books across reassignment, and settlement billed the CURRENT bidder for the running total
      // — including firms that had already separately been charged their own share of it at their
      // own failed settlement. A task needing several re-tenders (any non-trivial rework) then
      // guaranteed bankruptcy for whichever firm happened to be holding it when the bill came due,
      // regardless of that firm's own performance — the opposite of "a firm's own consumption
      // falls on that firm" (section 6).
      state.consumption[node.id] = {
        ...emptyConsumption(node.id, node.riskClass),
        dependants: countDependants(ctx, node.id),
        awardedAtMs: Date.now(),
      };

      // Article 4 needs to know who was paid, and article 7 needs what they said at tender. Both
      // are recorded at award rather than reconstructed at the gate: by acceptance time remediation
      // may have reassigned the node, and "did the firm that was paid also certify it" would no
      // longer have an answer.
      state.register.contractors[node.id] = winner.personaId;
      state.bidRecords[node.id] = {
        personaId: winner.personaId,
        declaredRisks: winner.bid.knownRisks ?? [],
        quotedPrice: winner.bid.priceTokens,
        estimatedResourceCost: winner.bid.estimatedResourceCost,
        successProbability: winner.bid.confidence,
      };

      // Section 6: "Insurance converts hidden risk into an explicit price." The premium is charged
      // against the winning firm's own capital, which is what makes it a price rather than a tax on
      // the commons — and section 14's answer to moral hazard is capital actually at risk.
      const insurancePolicy = resolveInsurancePolicy(config.insurancePolicy);
      const winnerAccount = getAccount(ctx, state, winner.personaId, config.initialCapital);
      const settlementsSoFar = winnerAccount.settlements ?? 0;
      const premium = premiumFor(
        winner.bid.priceTokens,
        node.riskClass,
        {
          defectRate: settlementsSoFar > 0 ? winnerAccount.defects / settlementsSoFar : 0,
          hasTests: (winner.bid.warranties ?? []).some((w) => /test/i.test(w)),
          filesInScope: listing.targetGlobs.length,
          dependants: countDependants(ctx, node.id),
          irreversible: /migrat|delete|drop|remove/i.test(`${node.title} ${node.description}`),
          confidence: winner.bid.confidence,
          hasRollbackPlan: (winner.bid.warranties ?? []).some((w) => /rollback|revert/i.test(w)),
        },
        insurancePolicy,
      );

      if (insuranceRequired(node.riskClass, insurancePolicy) || premium.amount > 0) {
        // Section 6: a firm may borrow against expected future earnings rather than being limited to
        // work it can already fund. Without this the exchange quietly becomes an auction among
        // whoever is richest, which on a run where capital only accumulates means whoever won first.
        const shortfall = Math.round((premium.amount - winnerAccount.capital) * 100) / 100;
        if (shortfall > 0) {
          const creditPolicy = resolveCreditPolicy(config.creditPolicy);
          const assessment = creditLimit(winnerAccount, { projectRisk: node.riskClass }, creditPolicy);
          // Backed by what actually stands behind the book. Section 6's warning is that unchecked
          // leverage lets agents "consume shared compute while shifting losses to the repository",
          // and the tokens a borrowed contract spends are metered and real.
          const draw = drawCredit(
            state.creditBook,
            winner.personaId,
            shortfall,
            assessment.limit,
            state.reserve.balance + state.treasuryBalance,
            creditPolicy,
          );
          winnerAccount.capital = Math.round((winnerAccount.capital + draw.drawn) * 100) / 100;
          winnerAccount.liabilities = Math.round(((winnerAccount.liabilities ?? 0) + draw.drawn) * 100) / 100;
          ctx.ledger.record('credit_drawn', {
            taskId: node.id,
            personaId: winner.personaId,
            requested: shortfall,
            drawn: draw.drawn,
            refused: draw.refused,
            limit: assessment.limit,
            outstanding: outstandingCredit(state.creditBook),
            reason: draw.reason ?? assessment.rationale,
          });
        }
        winnerAccount.capital = Math.round((winnerAccount.capital - premium.amount) * 100) / 100;
        collectPremium(state.reserve, premium.amount);
        state.insured[node.id] = { personaId: winner.personaId, premium: premium.amount };
        ctx.ledger.record('premium_charged', {
          taskId: node.id,
          personaId: winner.personaId,
          premium: premium.amount,
          reserveBalance: state.reserve.balance,
          raisedBy: premium.lines.filter((l) => l.multiplier > 1).map((l) => ({ factor: l.factor, basis: l.basis })),
          rationale: premium.rationale,
        });
      }

      const firm = formFirm({
        leadId: winner.personaId,
        listing,
        declaredSubcontractors: winner.bid.subcontractors,
        pool: eligible,
        seed: lotSeed(ctx),
        maxSubcontractors: config.firms.maxSubcontractors,
        specialisations: config.specialisations,
      });
      const engaged = subcontractorsOf(firm);
      if (engaged.length > 0) {
        // Article 4 checks that a firm did not assess its own subcontract, so who engaged whom has
        // to be on the record before the assessment happens.
        state.register.subcontractors[firm.leadId] = [
          ...new Set([...(state.register.subcontractors[firm.leadId] ?? []), ...engaged.map((m) => m.personaId)]),
        ];
        ctx.ledger.record('firm_formed', {
          taskId: node.id,
          leadId: firm.leadId,
          liableId: firm.liableId,
          members: engaged.map((m) => ({ personaId: m.personaId, role: m.role, capability: m.capability })),
        });
      }

      assignments.push({
        taskId: node.id,
        assigneeId: winner.personaId,
        role: 'implementer',
        meta: {
          bid: winner.bid, awardScore: winnerScore, bidCount: bids.length, listing, firm, terms,
          // Not `warrantyRepair`: this is a fresh contract on the market's ordinary terms, which only
          // inherits the information about what the last one got wrong.
          ...(priorRounds.length ? { retender: { requiredChanges: retenderLines(priorRounds) } } : {}),
        },
      });
      awardedThisRound.push(node.id);

      // Coase: "Firms arise when internal coordination is cheaper than repeated market exchange."
      // A listing that interlocks with the one just awarded goes to the same firm rather than to a
      // second auction, which would buy a stranger's implementation of one half of a single change
      // and an integration defect nobody is liable for.
      const stillOpen = readyNodes(graph)
        .map((n) => n.id)
        .filter(
          (id) =>
            !awardedThisRound.includes(id) &&
            !state.register.contractors[id] &&
            !isContractorExcluded(state, id, winner.personaId),
        );
      for (const absorbed of integrableListings(graph, node.id, stillOpen, config.firms.integrationThreshold)) {
        const absorbedNode = graph.nodes[absorbed.taskId];
        // A high-risk listing keeps its own spend approval. Coupling is a reason to keep work in one
        // firm, never a way around a gate the human holds.
        if (
          absorbedNode.riskClass === 'high' &&
          config.riskClassification.highRiskRequiresSpendApproval &&
          !state.approvals[absorbed.taskId]
        ) {
          continue;
        }
        const absorbedListing = buildListing(absorbedNode, config.listingTerms);
        // The absorbed listing keeps its own contract shape. Coupling is a reason for one firm to
        // hold both, never a reason to pay for high-risk work on a routine listing's terms.
        const absorbedTerms = selectContractType(
          {
            listing: absorbedListing,
            scopeUnderstood: state.diligence?.scopeUnderstood ?? true,
            hasMeasurableCriterion: hasMeasurableCriterion(absorbedListing.acceptanceCriteria),
            tournamentRequested: false,
          },
          resolveContractPolicy(config.contractPolicy),
        );
        state.contractTerms[absorbed.taskId] = absorbedTerms;
        state.register.contractors[absorbed.taskId] = winner.personaId;
        state.bidRecords[absorbed.taskId] = {
          personaId: winner.personaId,
          declaredRisks: winner.bid.knownRisks ?? [],
          quotedPrice: winner.bid.priceTokens,
          estimatedResourceCost: winner.bid.estimatedResourceCost,
          successProbability: winner.bid.confidence,
        };
        ctx.ledger.record('listings_integrated', {
          leadTaskId: node.id,
          taskId: absorbed.taskId,
          personaId: winner.personaId,
          coupling: absorbed.score,
          reasons: absorbed.reasons,
        });
        assignments.push({
          taskId: absorbed.taskId,
          assigneeId: winner.personaId,
          role: 'implementer',
          meta: {
            bid: winner.bid,
            awardScore: winnerScore,
            bidCount: bids.length,
            listing: absorbedListing,
            firm,
            terms: absorbedTerms,
            integratedWith: node.id,
            ...(state.retenderRequiredChanges[absorbed.taskId]?.length
              ? { retender: { requiredChanges: retenderLines(state.retenderRequiredChanges[absorbed.taskId]) } }
              : {}),
          },
        });
        awardedThisRound.push(absorbed.taskId);
      }
    }

    return assignments;
  }

  async execute(ctx: EngineContext, assignment: Assignment): Promise<WorkProduct> {
    const config = getConfig(ctx);
    const state = getState(ctx);
    const node = ctx.runState.graph!.nodes[assignment.taskId];
    const bid = assignment.meta?.bid as Bid | undefined;
    const price = bid?.priceTokens ?? 0;
    // What is withheld is the contract shape's retention, not one flat fraction for every contract.
    // That is the point of having shapes: a high-risk warranty contract holds back twice what a
    // routine fixed-price one does, because the exposure it covers runs twice as long.
    const terms = (assignment.meta?.terms as ContractTerms | undefined) ?? state.contractTerms[assignment.taskId];
    const escrowAmount = terms ? retentionFor(terms, price) : price * config.escrowFraction;

    // Withhold escrow conceptually: the payout at decide()-time will be price - escrowAmount,
    // with escrowAmount accumulating in the persona's heldEscrow until enough clean tasks release it.
    state.pendingEscrow[assignment.taskId] = { personaId: assignment.assigneeId, amount: escrowAmount, price };

    const warrantyRequiredChanges = (
      assignment.meta?.warrantyRepair as { requiredChanges: string[] } | undefined
    )?.requiredChanges;
    const retenderRequiredChanges = (
      assignment.meta?.retender as { requiredChanges: string[] } | undefined
    )?.requiredChanges;

    const result = await meteredDispatch<ImplementerOutput>(ctx, assignment.taskId, 'contractor', {
      role: 'implementer',
      personaId: assignment.assigneeId,
      systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
      userPrompt: buildImplementerUserPrompt(
        ctx.runState.task.goal,
        node,
        bid,
        warrantyRequiredChanges,
        retenderRequiredChanges,
      ),
      schemaDescription: IMPLEMENTER_SCHEMA_DESCRIPTION,
      validate: (value) => {
        fillMissingRationale(value);
        ImplementerOutputSchema.parse(value);
      },
      temperature: IMPLEMENTER_TEMPERATURE,
    });

    // Section 6's firm: the lead has delivered, and each specialist it engaged now delivers its own
    // part. The lead remains liable for all of it — section 10 lets a firm subcontract risk but not
    // externalise it — so a subcontractor's failure costs the lead rather than going unowned.
    const firm = assignment.meta?.firm as Firm | undefined;
    const listing = assignment.meta?.listing as Listing | undefined;
    let fileOps = [...result.value.fileOps];
    const subcontractedNotes: string[] = [];

    // Each member works from the lead's delivery alone, so the members run concurrently. Their
    // operations are merged afterwards in firm order, which keeps precedence where it was: a later
    // member still cannot overwrite the lead or an earlier member.
    const leadOps = fileOps;
    const members = firm ? subcontractorsOf(firm) : [];
    const deliveries = await Promise.all(members.map(async (member) => {
      try {
        const sub = await meteredDispatch<ImplementerOutput>(ctx, assignment.taskId, 'contractor', {
          role: 'implementer',
          personaId: member.personaId,
          systemPrompt: SUBCONTRACTOR_SYSTEM_PROMPT,
          userPrompt: buildSubcontractorUserPrompt(
            ctx.runState.task.goal,
            listing ? renderListing(listing) : node.description,
            member.role,
            member.capability,
            leadOps,
            // A test-author subcontractor writes the regression test for the defect, so it is told
            // the defect too.
            {
              remediationOf: node.remediationOf,
              requiredChanges: [...(warrantyRequiredChanges ?? []), ...(retenderRequiredChanges ?? [])],
            },
          ),
          schemaDescription: IMPLEMENTER_SCHEMA_DESCRIPTION,
          validate: (value) => {
            fillMissingRationale(value);
            ImplementerOutputSchema.parse(value);
          },
          temperature: IMPLEMENTER_TEMPERATURE,
        });
        return { member, delivered: true as const, ops: sub.value.fileOps };
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        return { member, delivered: false as const, error: err };
      }
    }));

    for (const delivery of deliveries) {
      const { member } = delivery;
      if (!delivery.delivered) {
        // A subcontractor that fails does not fail the contract: the lead is liable and delivers
        // what it has. The gap is disclosed rather than hidden, so review sees the firm was short.
        subcontractedNotes.push(`The ${member.role} subcontractor (${member.personaId}) did not deliver: ${String(delivery.error)}`);
        ctx.ledger.record('subcontract_failed', {
          taskId: assignment.taskId,
          personaId: member.personaId,
          role: member.role,
          error: String(delivery.error),
        });
        continue;
      }
      const { kept, dropped } = mergeSubcontractedOps(fileOps, delivery.ops);
      fileOps = [...fileOps, ...kept];
      if (dropped.length > 0) {
        // The lead answers for the delivery, so it is told when a member of its own firm tried to
        // write over work already delivered rather than having it silently applied.
        subcontractedNotes.push(
          `${member.personaId} (${member.role}) attempted to rewrite ${dropped.map((o) => o.path).join(', ')}, ` +
            'already delivered by the lead. Those operations were refused.',
        );
      }
      ctx.ledger.record('subcontract_delivered', {
        taskId: assignment.taskId,
        leadId: firm?.leadId,
        personaId: member.personaId,
        role: member.role,
        kept: kept.length,
        dropped: dropped.length,
      });
    }

    // Merge risk and maintenance burden are both properties of the delivery's shape, so they are
    // read off the FileOps rather than guessed from the listing. A file written where none existed
    // is new surface somebody maintains from now on; an edit is not.
    const consumption = consumptionFor(ctx, assignment.taskId);
    consumption.filesTouched = new Set(fileOps.map((op) => op.path)).size;
    consumption.filesCreated = new Set(fileOps.filter((op) => op.op === 'write').map((op) => op.path)).size;
    consumption.openWarranties = (bid?.warranties ?? []).length;
    consumption.deliveredAtMs = Date.now();

    ctx.ledger.record('work_executed', {
      taskId: assignment.taskId,
      personaId: assignment.assigneeId,
      fileOpCount: fileOps.length,
      subcontractors: firm ? subcontractorsOf(firm).length : 0,
      costUsd: result.costUsd,
    });

    const uncertainty = [result.value.unresolvedUncertainty, ...subcontractedNotes].filter(Boolean).join(' ');
    return {
      taskId: assignment.taskId,
      assignment,
      fileOps,
      rationale: result.value.rationale,
      unresolvedUncertainty: uncertainty || undefined,
    };
  }

  async review(ctx: EngineContext, product: WorkProduct, test: TestResult): Promise<ReviewResult> {
    const node = ctx.runState.graph?.nodes[product.taskId];
    const state = getState(ctx);
    const reviewerPersonaId = `reviewer-${product.taskId}`;
    state.register.assessors[product.taskId] = reviewerPersonaId;

    const userPrompt = buildReviewerUserPrompt(node, product, test);
    const verdict = (await meteredDispatch<ReviewerOutput>(ctx, product.taskId, 'assessor', {
      role: 'reviewer',
      personaId: reviewerPersonaId,
      scopeTaskId: product.taskId,
      systemPrompt: REVIEWER_SYSTEM_PROMPT,
      userPrompt,
      schemaDescription: REVIEWER_SCHEMA_DESCRIPTION,
      validate: (value) => {
        ReviewerOutputSchema.parse(value);
      },
      temperature: 0.2,
    })).value;

    const findings: ReviewFinding[] = [
      { reviewerId: reviewerPersonaId, verdict: verdict.verdict, rationale: verdict.rationale },
    ];

    // Article 3, applied by the regulator: did the delivery stay inside the awarded statement of
    // work? Plain code, not a model call — article 10 requires the regulator to act under stable,
    // published rules, and a ruling that varies with a model's mood on the day is neither.
    const declaredGlobs = node?.targetGlobs && node.targetGlobs.length > 0 ? node.targetGlobs : ['**/*'];
    const [scopeBreach] = scopeBreaches([
      {
        taskId: product.taskId,
        personaId: product.assignment.assigneeId,
        paths: product.fileOps.map((op) => op.path),
        declaredGlobs,
      },
    ]);
    if (scopeBreach) {
      findings.push({
        reviewerId: 'regulator',
        verdict: 'flag',
        rationale: scopeBreach.remedy,
        evidenceRefs: scopeBreach.paths,
      });
      // Article 10: every block the regulator lays down cites a published ground, recorded as it is
      // made so regulatorOverreach() has something to check at the gate.
      state.regulatorActions.push({
        taskId: product.taskId,
        ground: 'contract-breach',
        rationale: scopeBreach.remedy,
      });
    } else {
      findings.push({
        reviewerId: 'regulator',
        verdict: 'approve',
        rationale: "All delivered FileOps paths fall within the listing's declared targetGlobs.",
      });
    }

    ctx.ledger.record('review_completed', { taskId: product.taskId, findings, test });
    return { taskId: product.taskId, findings, testResult: test };
  }

  async decide(ctx: EngineContext, product: WorkProduct, review: ReviewResult): Promise<Decision> {
    const config = getConfig(ctx);
    const state = getState(ctx);
    const settlementKey = settlementAttemptKey(ctx, product.taskId);
    const priorDecision = state.settlementDecisions[settlementKey];
    if (priorDecision) return priorDecision;
    const personaId = product.assignment.assigneeId;
    const capitalPolicy = resolveCapitalPolicy({
      initialCapital: config.initialCapital,
      capitalFloorForHighRisk: config.capitalFloorForHighRisk,
      retentionReleaseAfterCleanTasks: config.escrowReleaseAfterCleanTasks,
      ...config.capitalPolicy,
    });
    const account = getAccount(ctx, state, personaId, config.initialCapital);

    const regulatorFlag = review.findings.find((f) => f.reviewerId === 'regulator' && f.verdict === 'flag');
    const reviewerFinding = review.findings.find((f) => f.reviewerId.startsWith('reviewer'));
    const reviewerApproved = reviewerFinding?.verdict === 'approve';
    const testResult = review.testResult;
    // Only treat a genuine test failure as blocking. `ran: true, passed: false` can also mean
    // the test *command itself* couldn't be spawned (observed on this Windows dev box: the
    // engine's RepoWorktree.runAllowListedCommand calls execFile('npm', ...) without
    // shell:true, which throws ENOENT since npm is a .cmd shim on Windows — a test-infra
    // problem, not a code-correctness one). Conflating the two would mean every contract on an
    // affected machine gets rejected regardless of what the implementer actually produced, so we
    // only count it as blocking when the output doesn't look like a spawn/infra failure.
    // Whether a failed check is a defect or a broken environment is section 6's "who caused a
    // regression", and it is genuinely contested — both readings come off the same output. It used
    // to be settled here by a regular expression, on behalf of the party the regex favours. The
    // heuristic is still a reasonable prior and still decides which disputes exist; what it no
    // longer does is decide them.
    const infraSuspected = !!testResult && testResult.ran && !testResult.passed && looksLikeTestInfraFailure(testResult);
    const disputes = detectDisputes({
      taskId: product.taskId,
      personaId,
      reviewerVerdict: reviewerFinding?.verdict,
      scopeFlagged: !!regulatorFlag,
      scopePaths: regulatorFlag?.evidenceRefs ?? [],
      testRan: !!testResult?.ran,
      testPassed: !!testResult?.passed,
      testOutput: testResult?.output,
      looksLikeInfraFailure: infraSuspected,
    });

    // Slots are taken in order before anything is heard, so the limit binds exactly as it did when
    // disputes were heard one by one; the hearings themselves are independent and sit together.
    const admitted: typeof disputes = [];
    for (const dispute of disputes) {
      if (state.arbitrations >= config.arbitration.maxPerRun) {
        state.arbitrationsDeclined += 1;
        ctx.ledger.record('arbitration_declined', {
          taskId: product.taskId,
          matter: dispute.matter,
          reason:
            `this run has already held ${state.arbitrations} arbitration(s), which is its limit — a market that ` +
            'litigates everything has moved its transaction costs, not reduced them',
        });
        continue;
      }
      state.arbitrations += 1;
      admitted.push(dispute);
    }

    // Every hearing reads the same delivered diff, so it is fetched once.
    const diffFetch = admitted.length > 0 ? ctx.worktree.diff() : undefined;
    const hearings = await Promise.all(admitted.map(async (dispute) => {
      try {
        const { diffText } = await diffFetch!;
        const result = await meteredDispatch<WireRuling>(ctx, product.taskId, 'assessor', {
          role: 'regulator',
          personaId: 'arbitrator',
          systemPrompt: ARBITRATOR_SYSTEM_PROMPT,
          userPrompt: buildArbitratorUserPrompt(
            ctx.runState.task.goal,
            dispute.matter,
            dispute.buyerPosition,
            dispute.supplierPosition,
            dispute.evidence,
            testResult ? `${testResult.command ?? 'check'}: ran=${testResult.ran} passed=${testResult.passed}` : '',
            truncateDiff(diffText, diffBudget(ctx)),
          ),
          schemaDescription: arbitrationSchemaDescription,
          validate: validateRuling,
          temperature: 0.1,
        });
        return { dispute, sat: true as const, adjudication: applyRuling(dispute, result.value) };
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        return { dispute, sat: false as const, error: err };
      }
    }));

    // Recorded in the order the disputes were raised, whichever hearing finished first.
    const adjudications: Adjudication[] = [];
    for (const hearing of hearings) {
      if (!hearing.sat) {
        // A court that cannot sit does not thereby decide for anyone. The matter falls to the party
        // carrying the burden of proof, which is the supplier — the same rule an ungrounded ruling
        // gets, for the same reason.
        ctx.ledger.record('arbitration_failed', {
          taskId: product.taskId,
          matter: hearing.dispute.matter,
          error: String(hearing.error),
          effect: 'the matter falls against the supplier, who bears the burden of showing performance',
        });
        continue;
      }
      const { adjudication } = hearing;
      adjudications.push(adjudication);
      ctx.ledger.record('arbitration_ruled', {
        taskId: product.taskId,
        matter: adjudication.matter,
        ruling: adjudication.ruling,
        liableParty: adjudication.liableParty,
        stood: adjudication.stood,
        evidenceCited: adjudication.evidenceCited,
        rationale: adjudication.rationale,
      });
    }

    const regressionRuling = adjudications.find((a) => a.matter === 'regression-cause');
    const scopeRuling = adjudications.find((a) => a.matter === 'scope-change');
    // Blocking unless the arbitrator found for the supplier. Where no arbitration happened, an
    // unproven delivery blocks — the supplier's claim that the environment was at fault has not
    // been established by anyone.
    const testsBlocking =
      !!testResult && testResult.ran && !testResult.passed && !(regressionRuling && supplierPrevailed(regressionRuling));

    const escrow = state.pendingEscrow[product.taskId];
    const price = escrow?.price ?? 0;

    // Article 5, at the moment it bites: what this contract actually consumed, priced against the
    // published list. The latency line closes here because settlement is when the clock stops.
    const consumption = consumptionFor(ctx, product.taskId);
    if (testResult?.ran) consumption.toolCalls += 1;
    if (consumption.awardedAtMs) consumption.latencyMs = Math.max(0, Date.now() - consumption.awardedAtMs);
    const priced = priceConsumption(consumption, resolvePriceList(config.priceList));
    const revenue = payableRevenue(state.contractTerms[product.taskId], price, priced.total);
    const escrowAmount = Math.min(escrow?.amount ?? 0, revenue);

    // Section 8's answer to the one risk time and materials carries — "weak incentive to finish
    // efficiently". A contract that consumed past its cap is stopped rather than settled at whatever
    // it came to, which is the term the bidder priced when it took that shape on.
    const terms = state.contractTerms[product.taskId];
    const capBreached = terms ? overSpendCap(terms, price, priced.total) : false;
    const listing = (product.assignment.meta?.listing as Listing | undefined) ?? undefined;
    const deadlineBreached = deliveryMissedDeadline(
      consumption.awardedAtMs, consumption.deliveredAtMs, listing?.deadlineMinutes,
    );
    if (deadlineBreached) {
      const latenessMs = consumption.deliveredAtMs! - consumption.awardedAtMs! - listing!.deadlineMinutes * 60_000;
      const reason = `Delivery for "${product.taskId}" missed its published deadline by ${Math.ceil(latenessMs / 60_000)} minute(s).`;
      state.regulatorActions.push({ taskId: product.taskId, ground: 'contract-breach', rationale: reason });
      ctx.ledger.record('contract_deadline_breached', {
        taskId: product.taskId, personaId, deadlineMinutes: listing!.deadlineMinutes,
        awardedAtMs: consumption.awardedAtMs, deliveredAtMs: consumption.deliveredAtMs,
      });
    }
    if (capBreached) {
      state.regulatorActions.push({
        taskId: product.taskId,
        ground: 'contract-breach',
        rationale:
          `The time-and-materials contract on "${product.taskId}" consumed ${priced.total.toFixed(2)} against a cap of ` +
          `${(price * (terms?.spendCapMultiple ?? 0)).toFixed(2)}.`,
      });
      ctx.ledger.record('spend_cap_breached', {
        taskId: product.taskId,
        personaId,
        consumed: priced.total,
        cap: price * (terms?.spendCapMultiple ?? 0),
      });
    }

    let outcome: DecisionOutcome;
    let rationale: string;

    // The work itself: review, scope and checks. The deadline and the spend cap are commercial
    // terms, and breaching one is not a defect in the code.
    const workAccepted = !regulatorFlag && reviewerApproved && !testsBlocking;
    const verified = workAccepted && !capBreached && !deadlineBreached;
    // Sound work delivered late or over its cap used to be rejected and reverted, which threw the
    // buyer's verified code away to punish the supplier and paid for the same work twice. It is kept
    // and the breach is priced with the instruments the contract already has: the retention is
    // forfeited rather than held against the warranty, and the firm's standing records a failed
    // contract (section 6: capital is lost through budget overruns and failed contracts). A
    // time-and-materials contract is also paid no more than its cap (payableRevenue).
    const commercialBreachOnly = workAccepted && !verified;

    // Section 8: "Profit is verified value minus consumed resources and liabilities." What the firm
    // keeps is the profit, not the contract price — a contract that consumed more than it was worth
    // is a loss even when the code was accepted, which is the feedback the doctrine runs on.
    const pnl = profitAndLoss({
      taskId: product.taskId,
      personaId,
      contractPrice: revenue,
      escrowWithheld: escrowAmount,
      verified: workAccepted,
      resourceCost: priced.total,
      liabilities: 0,
    });

    // Section 6's two lists, applied to the firm's account: profit is only part of what a settlement
    // establishes. Estimate calibration, disclosed risks that materialised as warned, and
    // obligations left for others to carry all bear on standing without appearing in the profit.
    const bidRecord = state.bidRecords[product.taskId];
    const effect = applySettlement(
      account,
      {
        taskId: product.taskId,
        domains: listing?.requiredCapabilities ?? [],
        verified,
        profit: pnl.profit,
        quotedPrice: bidRecord?.quotedPrice ?? price,
        estimatedResourceCost: bidRecord?.estimatedResourceCost,
        successProbability: bidRecord?.successProbability,
        warrantyPeriodTasks: terms?.warrantyPeriodTasks,
        attemptKey: settlementKey,
        artifactDigest: digestArtifact(product.fileOps),
        actualCost: priced.total,
        risksDisclosedAndRealised:
          (bidRecord?.declaredRisks.length ?? 0) > 0 && !verified ? bidRecord!.declaredRisks.length : 0,
        externalisedObligations: 0,
        retentionWithheld: verified ? escrowAmount : 0,
        ...(commercialBreachOnly ? { failureReason: 'the contract breached its commercial terms' } : {}),
      },
      capitalPolicy,
    );
    if (effect.retentionReleased > 0) {
      ctx.ledger.record('escrow_released', {
        personaId,
        taskId: product.taskId,
        amount: effect.retentionReleased,
      });
    }
    ctx.ledger.record('capital_recorded', {
      taskId: product.taskId,
      personaId,
      capital: effect.capitalAfter,
      liabilities: effect.liabilitiesAfter,
      reputation: effect.reputationAfter,
      domainScores: effect.domainScores,
      reasons: effect.reasons,
    });

    const breaches = [
      capBreached ? 'the contract consumed past its agreed spend cap' : null,
      deadlineBreached ? 'delivery missed the published deadline' : null,
    ].filter(Boolean);
    if (verified) {
      outcome = 'approved';
      delete state.warrantyRepairs[product.taskId];
      delete state.retenderRequiredChanges[product.taskId];
      rationale = `Reviewer approved, regulator raised no flag, tests ${
        testResult?.ran ? 'passed' : 'not applicable'
      }. ${pnl.rationale} ${escrowAmount.toFixed(2)} retained against the warranty. ${effect.reasons.join('; ')}.`;
    } else if (commercialBreachOnly) {
      outcome = 'approved';
      delete state.warrantyRepairs[product.taskId];
      delete state.retenderRequiredChanges[product.taskId];
      rationale = `Reviewer approved, regulator raised no flag, tests ${
        testResult?.ran ? 'passed' : 'not applicable'
      }, so the work is accepted; but ${breaches.join(' and ')}, so the contract settles in breach. ` +
        `${pnl.rationale} Forfeited retention of ${escrowAmount.toFixed(2)} tokens. ${effect.reasons.join('; ')}.`;
    } else {
      outcome = 'rejected';
      // Forfeited retention is the defect penalty, on top of the loss applySettlement already took.
      // Section 6: agents that "consume scarce resources without producing verified value lose
      // capital" — a failed contract burned the commons exactly as much as a successful one.
      account.capital -= escrowAmount;
      const reasons = [
        regulatorFlag ? `regulator flag: ${regulatorFlag.rationale}` : null,
        !reviewerApproved ? `reviewer verdict: ${reviewerFinding?.verdict ?? 'no reviewer finding'}` : null,
        // Named, not pasted: the engine's repair brief carries the output to the next implementer,
        // and a second copy here would reach it again through the directive built from this text.
        testsBlocking ? `tests failed: ${failingCheckNames(testResult)}` : null,
        ...breaches,
      ]
        .filter(Boolean)
        .join('; ');
      rationale = `Contract failed settlement for ${personaId} (${reasons || 'no specific reason recorded'}). Forfeited retention of ${escrowAmount.toFixed(
        2,
      )} tokens. ${pnl.rationale}`;
    }

    // Section 11, checked after every settlement rather than only on a rejection: a firm can be
    // driven insolvent by liabilities it accrued on contracts it delivered. The purpose is not
    // punishment — it is to stop scarce resources staying trapped in a firm that cannot deliver.
    const insolvency = assessInsolvency(account, capitalPolicy);
    if (insolvency.insolvent && !account.bankrupt) {
      account.bankrupt = true;
      rationale += ` ${insolvency.rationale}`;
      ctx.ledger.record('bankruptcy', {
        personaId,
        capital: account.capital,
        liabilities: account.liabilities ?? 0,
        grounds: insolvency.grounds,
        consequences: insolvency.consequences,
      });
    } else if (account.capital < config.bankruptcyThreshold && !account.bankrupt) {
      // The configured floor still applies alongside section 11's own grounds.
      account.bankrupt = true;
      rationale += ` Persona ${personaId} is excluded from further bidding: capital ${account.capital.toFixed(
        2,
      )} is below the configured floor of ${config.bankruptcyThreshold}.`;
      ctx.ledger.record('bankruptcy', {
        personaId,
        capital: account.capital,
        liabilities: account.liabilities ?? 0,
        grounds: ['below-configured-floor'],
        consequences: ['exclusion from further bidding this run'],
      });
    }

    // Settlement closes pending escrow on every outcome. On failure the retention was forfeited
    // above; leaving the same amount marked pending would represent it as both lost and still held.
    // A warranty execution re-establishes the original terms for that new attempt.
    delete state.pendingEscrow[product.taskId];
    // Articles 5 and 9 are checked over settled contracts, so the settlement is what has to be
    // recorded — not the award. `resourceCost` is left unset here and filled in by prices.ts;
    // until then article 5 reports every contract as unpriced, which is the truth.
    state.settled = state.settled.filter((c) => c.taskId !== product.taskId);
    state.settled.push({ taskId: product.taskId, personaId, price: revenue, resourceCost: priced.total });

    // Article 9's levy, at the only moment a contract's profit is known. Section 6: "A levy on
    // profitable contracts may fund these services." Without it there is nothing for a contract to
    // have failed to pay into, and articles 8 and 9 would be unenforceable.
    const treasuryPolicy = resolveTreasuryPolicy(config.treasuryPolicy);
    const levy = collectLevy(state.treasury, { taskId: product.taskId, personaId, profit: pnl.profit }, treasuryPolicy);
    account.capital = Math.round((account.capital - levy.amount) * 100) / 100;
    state.levied = [...new Set([...state.levied, product.taskId])];
    state.treasuryBalance = treasuryBalance(state.treasury);
    ctx.ledger.record('levy_collected', {
      taskId: product.taskId,
      personaId,
      profit: pnl.profit,
      amount: levy.amount,
      toPublicGoods: levy.toPublicGoods,
      toVenturePool: levy.toVenturePool,
      rationale: levy.rationale,
    });

    if (verified && pnl.profit > levy.amount) {
      const repayment = repayCredit(state.creditBook, personaId, Math.min(account.capital, pnl.profit - levy.amount));
      if (repayment > 0) {
        account.capital = Math.round((account.capital - repayment) * 100) / 100;
        account.liabilities = Math.round((Math.max(0, (account.liabilities ?? 0) - repayment)) * 100) / 100;
        ctx.ledger.record('credit_repaid', {
          taskId: product.taskId,
          personaId,
          amount: repayment,
          outstanding: outstandingCredit(state.creditBook),
        });
      }
    }

    // Section 6's bounded bailout, considered only where a firm's failure would actually stop the
    // run. Every limit here can refuse, and the refusals are recorded as deliberately as the
    // rescues: "It should not rescue every failing firm. Permanent bailouts destroy market
    // discipline."
    if (account.bankrupt && account.capital < 0) {
      const systemic = solventBidders(state, config.initialCapital) === 0;
      const rescue = considerBailout(
        state.treasury,
        { personaId, shortfall: Math.abs(account.capital), systemic },
        treasuryPolicy,
      );
      if (rescue.granted) {
        account.capital = Math.round((account.capital + rescue.amount) * 100) / 100;
        account.bankrupt = false;
        state.treasuryBalance = treasuryBalance(state.treasury);
      }
      ctx.ledger.record('bailout_considered', {
        personaId,
        granted: rescue.granted,
        amount: rescue.amount,
        systemic,
        reason: rescue.reason,
      });
    }

    const supplierLiable =
      (!reviewerApproved && !!reviewerFinding) ||
      (testsBlocking && (!regressionRuling || regressionRuling.liableParty !== 'buyer')) ||
      (!!regulatorFlag && (!scopeRuling || scopeRuling.liableParty !== 'buyer')) ||
      capBreached || deadlineBreached;
    const requiredChanges = requiredChangesForFailure({
      regulatorFlag,
      reviewFindings: review.findings,
      testsBlocking,
      testResult,
    });
    // A firm the reviewer found to be on a fundamentally wrong approach is not handed the same work
    // back under warranty: its repair would start from the approach that failed. The listing goes
    // straight to re-tender, with the evidence intact, rather than being refused outright — which
    // used to drop the evidence, after which the engine's own rework sent it to that same firm.
    const warrantyBarred =
      !!reviewerFinding && reviewerFinding.verdict !== 'approve' && isFundamentallyWrongApproach(reviewerFinding.rationale);
    const warrantyFailed = !!product.assignment.meta?.warrantyRepair;
    const eligibleRetenderBidders = warrantyFailed || warrantyBarred
      ? eligibleBidderIds({
          ctx,
          state,
          node: ctx.runState.graph!.nodes[product.taskId],
          config,
          capitalPolicy,
          personaPool: Array.from({ length: config.bidCount }, (_, i) => `bidder-${i + 1}`),
          additionalExclusions: supplierLiable ? [personaId] : [],
        })
      : [];
    const recoveryAvailable = !(warrantyFailed || warrantyBarred) || eligibleRetenderBidders.length > 0;
    if (outcome === 'rejected' && recoveryAvailable && requiredChanges.length > 0) {
      outcome = 'rework';
      rationale += ` The contract remains failed and settled; a bounded warranty/re-tender path may attempt: ${requiredChanges.join(
        '; ',
      )}.`;
    }
    if (outcome === 'rejected') delete state.warrantyRepairs[product.taskId];

    // The lines, not just the total. Article 5 asks for visible costs, and a settlement a firm
    // cannot see the derivation of is one it cannot dispute.
    ctx.ledger.record('resources_priced', {
      taskId: product.taskId,
      personaId,
      total: priced.total,
      lines: priced.lines.filter((l) => l.amount > 0).map((l) => ({ item: l.item, amount: l.amount, basis: l.basis })),
    });
    ctx.ledger.record('contract_settled', {
      taskId: product.taskId,
      personaId,
      outcome,
      price: revenue,
      quotedPrice: price,
      resourceCost: priced.total,
      profit: pnl.profit,
      capital: account.capital,
      reputationScore: account.reputationScore,
    });
    if (state.treasury.grants.some((grant) => grant.taskId === product.taskId && grant.good.startsWith('experiment:'))) {
      ctx.ledger.record('venture_findings_published', {
        taskId: product.taskId, outcome, rationale: product.rationale,
        unresolvedUncertainty: product.unresolvedUncertainty ?? '',
        reviewFindings: review.findings.map((finding) => finding.rationale),
      });
    }

    const decision: Decision = outcome === 'rework'
      ? {
          taskId: product.taskId,
          outcome,
          rationale,
          evidenceRefs: review.findings.map((f) => f.rationale),
          rework: { requiredChanges },
          meta: {
            personaId,
            price,
            escrowAmount,
            resourceCost: priced.total,
            profit: pnl.profit,
            capitalAfter: account.capital,
            supplierLiable,
            ...(warrantyBarred ? { warrantyBarred } : {}),
          },
        }
      : {
      taskId: product.taskId,
      outcome,
      rationale,
      evidenceRefs: review.findings.map((f) => f.rationale),
      // The rationale is the settlement record — forfeiture, P&L — and stays in the ledger. If the
      // engine compels another attempt anyway, the next firm gets only what to fix.
      ...(outcome === 'rejected'
        ? { repairDirective: requiredChanges.length
          ? requiredChanges
          : ['The delivery did not pass settlement. Resolve the failing checks and review findings in the repair brief.'] }
        : {}),
      meta: {
        personaId,
        price,
        escrowAmount,
        resourceCost: priced.total,
        profit: pnl.profit,
        capitalAfter: account.capital,
        supplierLiable,
        // The engine may still turn a refusal into rework; recover() must then re-tender too.
        ...(warrantyBarred ? { warrantyBarred } : {}),
      },
    };
    state.settlementDecisions[settlementKey] = decision;
    return decision;
  }

  async recordOutcome(ctx: EngineContext, decision: Decision, test: TestResult): Promise<void> {
    // Capital/reputation/escrow bookkeeping already happened directly on ctx.strategyState in
    // decide() above (both are acceptable per the strategy contract); this just closes the audit
    // trail with the final outcome alongside the test result the engine ran.
    ctx.ledger.record('outcome_recorded', {
      taskId: decision.taskId,
      outcome: decision.outcome,
      testRan: test.ran,
      testPassed: test.passed,
    });
  }

  requiresHumanApproval(_ctx: EngineContext, decision: Decision): boolean {
    return decision.outcome === 'needs_human';
  }

  async recover(ctx: EngineContext, request: RecoveryRequest): Promise<void> {
    const state = getState(ctx);
    const taskId = request.product.taskId;
    const contractorId = request.product.assignment.assigneeId;
    // Every failed round joins the listing's history, the warranty round included: if the repair
    // fails too, the firm that wins the re-tender must hear what both rounds were told to fix.
    recordRetenderRound(state, taskId, request.attemptNumber, request.decision.rework.requiredChanges);

    // Warranty covers the first failure of a contract, counted from the listing's last acceptance. A
    // remediation reopen starts a new contract on accepted work, so the attempts that preceded the
    // acceptance do not use the warranty up — counting them meant a reopened listing never had one.
    const node = ctx.runState.graph?.nodes[taskId];
    const warrantyEligible = request.decision.meta?.warrantyBarred !== true &&
      (node ? judgedAttemptsBefore(node, request.attemptNumber) === 0 : request.attemptNumber === 1);
    if (warrantyEligible) {
      state.warrantyRepairs[taskId] = {
        assignment: structuredClone(request.product.assignment),
        requiredChanges: [...request.decision.rework.requiredChanges],
        attempt: request.attemptNumber,
      };
      ctx.ledger.record('warranty_claim_returned', {
        cycle: request.attemptNumber,
        taskIds: [taskId],
        relisted: [],
        escrowHeld: Object.keys(state.pendingEscrow),
        requiredChanges: request.decision.rework.requiredChanges,
      });
      return;
    }

    delete state.warrantyRepairs[taskId];
    // Relisting moves the work, and its liability, to whoever wins the re-tender. What the failed
    // contracts were required to change goes with the listing (recorded above), or the next firm
    // repeats the defect.
    delete state.approvals[taskId];
    delete state.register.contractors[taskId];

    const supplierLiable = request.decision.meta?.supplierLiable === true;
    if (supplierLiable) {
      state.excludedContractors[taskId] = [
        ...new Set([...(state.excludedContractors[taskId] ?? []), contractorId]),
      ];
      fundRemediationOnce(ctx, taskId, Number(request.decision.meta?.price ?? 0));
    }

    ctx.ledger.record('warranty_claim_returned', {
      cycle: request.attemptNumber,
      taskIds: [taskId],
      relisted: [taskId],
      escrowHeld: Object.keys(state.pendingEscrow),
      previousContractor: contractorId,
      supplierLiable,
      excludedContractors: state.excludedContractors[taskId] ?? [],
      nextAttempt: request.attemptNumber + 1,
      maxAttempts: request.maxAttempts,
      repeated: request.repeated,
    });
  }

  // ---------- acceptance barriers ----------

  /**
   * The task exchange's dependency and property schedule (section 8): what each contract owns, what
   * it depends on, and which surfaces more than one contract claims. "Overlapping claims or a
   * dependency on an unsettled interface block unsupervised parallel work."
   */
  async declareOwnership(ctx: EngineContext, graph: TaskGraph): Promise<OwnershipMap> {
    return runOwnershipDeclaration(ctx, graph, {
      interfacesFor: (entry, graph) => {
        const node = graph.nodes[entry.taskId];
        return node?.dependsOn.map((d) => `contract:${d}`) ?? [];
      },
      overlapRationale:
        'Declared shared property: more than one awarded contract claims this path in its statement of work.',
    });
  }

  /** A separately procured integration assessor. Section 10: "Component-level certificates do not
   * warrant the combined product." */
  async integrate(ctx: EngineContext, approvedTaskIds: string[], diffText: string): Promise<IntegrationResult> {
    const result = await runIntegrationBarrier(ctx, approvedTaskIds, diffText, {
      integratorId: 'integration-assessor',
      systemPrompt: INTEGRATION_ASSESSOR_SYSTEM_PROMPT,
      buildUserPrompt: buildIntegrationAssessorUserPrompt,
    });
    return { ...result, findings: this.underSafetyFloor(ctx, result.findings, result.integratorId) };
  }

  /**
   * Article 11: "No contract may waive non-negotiable safety, security, privacy or human-control
   * requirements", and section 10: "The regulator blocks delivery that breaches this floor even if
   * every commercial party prefers acceptance." What the assessors find on the assembled product on
   * such a ground is marked so no acceptance schedule can defer it; accept() then withholds escrow
   * while it is open.
   */
  private underSafetyFloor<T extends DraftFinding>(ctx: EngineContext, findings: T[], raisedBy: string): T[] {
    const marked = markNonWaivableFindings(findings, SAFETY_FLOOR_ARTICLE);
    if (marked.grounds.length > 0) {
      ctx.ledger.record('safety_floor_applied', { raisedBy, article: SAFETY_FLOOR_ARTICLE, grounds: marked.grounds });
    }
    return marked.findings;
  }

  /** The independent contractual assessor — "who did not author, subcontract, or hold a success fee
   * in the relevant change". */
  async verifyDelivery(ctx: EngineContext, draft: DeliveryPacket): Promise<VerificationResult> {
    const verified = await runVerificationBarrier(ctx, draft, {
      verifierId: 'contractual-assessor',
      systemPrompt: CONTRACTUAL_ASSESSOR_SYSTEM_PROMPT,
      buildUserPrompt: buildContractualAssessorUserPrompt,
    });
    const result = { ...verified, findings: this.underSafetyFloor(ctx, verified.findings, verified.verifierId) };

    // Kept for the market report, which files from disposeFindings() and so cannot reach the draft.
    // Section 9 requires skipped and inapplicable checks to reach the record with their reasons.
    getState(ctx).finalChecks = draft.finalChecks;
    return result;
  }

  async disposeFindings(ctx: EngineContext, open: Finding[]): Promise<Finding[]> {
    // A run with nothing to dispose still owes an account of itself. Closing positions, levies
    // collected, listings that cleared no bid, concentration, free-riding and skipped checks are
    // facts about the market rather than about findings, and a clean run has all of them.
    //
    // This guard used to return before the report was filed, which meant the tidier the run the less
    // it disclosed — the delivery packet of a flawless run carried nothing at all. Found by running
    // the smoke test: scenario 1 reached acceptance with no findings and filed no report.
    if (open.length === 0) {
      await this.fileMarketReport(ctx, []);
      return [];
    }
    const { diffText } = await ctx.worktree.diff();

    const result = await ctx.dispatcher.dispatch<WireDispositionReport>({
      role: 'reviewer',
      personaId: 'acceptance-schedule',
      systemPrompt: ACCEPTANCE_SCHEDULE_SYSTEM_PROMPT,
      userPrompt: buildAcceptanceScheduleUserPrompt(
        open.map((f) => ({ id: f.id, source: f.source, summary: f.summary, evidenceRefs: f.evidenceRefs })),
        truncateDiff(diffText, diffBudget(ctx)),
      ),
      schemaDescription: dispositionSchemaDescription,
      validate: validateDispositionReport,
      temperature: 0.2,
    });

    const disposed = applyDispositions(open, result.value.dispositions);
    await this.fileMarketReport(ctx, disposed);
    return disposed;
  }

  /**
   * The run's account of itself to its own market.
   *
   * Filed here, at the end of disposeFindings(), and the timing is load-bearing rather than
   * incidental: engine/delivery.ts reads strategyState.deliveryNotes while assembling the packet,
   * which happens before accept() is called. A report filed in accept() would be silently dropped,
   * and the run would look as though it had accounted for itself while disclosing nothing.
   */
  private async fileMarketReport(ctx: EngineContext, findings: readonly Finding[]): Promise<void> {
    const state = getState(ctx);
    const report = buildMarketReport({
      accounts: state.capitalAccounts,
      capitalIssuances: state.capitalIssuances,
      treasury: state.treasury,
      reserve: state.reserve,
      creditBook: state.creditBook,
      findings,
      finalChecks: state.finalChecks ?? [],
      unfilledListings: state.unfilledListings,
      concentration: marketConcentration(state.register.contractors),
      unpricedContracts: unpricedConsumption(state.settled),
      disclosureBreaches: undisclosedRisk(
        Object.entries(state.bidRecords).map(([taskId, r]) => ({ taskId, ...r })),
        countFindingsByTask(findings),
      ),
      freeRiders: publicGoodsUnderfunded(state.settled, state.levied),
      arbitrationsHeld: state.arbitrations,
      arbitrationsDeclined: state.arbitrationsDeclined,
    });

    ctx.ledger.record('market_report', {
      positions: report.positions.length,
      unmet: report.unmet.length,
      unresolved: report.unresolved.length,
      carried: report.carried.length,
      limitations: report.limitations.length,
      skippedChecks: report.skippedChecks.length,
    });

    // Replaced rather than appended to. A remediation cycle files a fresh account of the market as
    // it now stands; accumulating them would repeat every limitation, so a run that went round the
    // loop three times would read as three times as compromised as it is.
    state.deliveryNotes = toDeliveryNotes(report);
  }

  /**
   * Escrow release, bounded by the regulatory safety floor. Deterministic and not a commercial
   * judgment: section 10 states that "no low bid, disclaimer, indemnity, buyer preference, or
   * escrow release may waive user acceptance criteria, repository rules, security obligations,
   * independent verification, truthful disclosure, or the minimum review gate. The regulator blocks
   * delivery that breaches this floor even if every commercial party prefers acceptance."
   */
  async accept(ctx: EngineContext, draft: DeliveryPacket): Promise<DoctrineAcceptance> {
    const state = getState(ctx);
    const breaches: string[] = [];

    // The constitutional gate runs first, and only the articles that genuinely block appear here.
    // Article 4's self-dealing is one of them: a delivery certified by the firm that was paid for it
    // has not been assessed at all, so no amount of commercial agreement makes it acceptable.
    const antitrust = antitrustBreaches({
      contractors: state.register.contractors,
      assessors: state.register.assessors,
      subcontractors: state.register.subcontractors,
      integratorId: draft.integrationEvidence.integratorId,
      verifierId: draft.independentVerification.verifierId,
    });
    for (const breach of antitrust) {
      breaches.push(`article 4 (${breach.holdings.join('/')} held by ${breach.personaId}): ${breach.remedy}`);
    }

    // Article 10 binds the regulator too. A block citing an unpublished ground is the enforcer
    // legislating for itself, and it stops the delivery for the same reason a breach by a firm
    // would: the acceptance would rest on an act nobody authorised.
    const overreach = regulatorOverreach(state.regulatorActions);
    for (const action of overreach) {
      breaches.push(
        `article 10 (regulator acted on "${action.ground}", which is not a published ground): ${action.rationale}`,
      );
    }

    // Reported, never blocking — each one is an accounting or structural gap whose remedy is to
    // record, collect or redraw, not to throw sound work away. They travel to the market report.
    const reported = {
      concentration: marketConcentration(state.register.contractors),
      unpriced: unpricedConsumption(state.settled),
      undisclosed: undisclosedRisk(
        Object.entries(state.bidRecords).map(([taskId, r]) => ({ taskId, ...r })),
        countFindingsByTask(draft.findings),
      ),
      externalities: unpricedExternalities(
        draft.findings
          .filter((f) => f.disposition === 'deferred')
          .map((f) => ({ findingId: f.id, summary: f.summary, owner: f.owner, returnCondition: f.returnCondition })),
      ),
      freeRiders: publicGoodsUnderfunded(state.settled, state.levied),
    };
    ctx.ledger.record('constitutional_gate', {
      blocking: antitrust.length + overreach.length,
      concentration: reported.concentration.length,
      unpricedContracts: reported.unpriced.length,
      disclosureBreaches: reported.undisclosed.length,
      unpricedExternalities: reported.externalities.length,
      unleviedContracts: reported.freeRiders.length,
    });

    if (!draft.integrationEvidence.integrated) {
      breaches.push(`the integration assessor did not certify the assembled product (${draft.integrationEvidence.rationale})`);
    }
    if (!draft.independentVerification.verified) {
      breaches.push(`the independent contractual assessor withheld acceptance (${draft.independentVerification.rationale})`);
    }
    const untraced = draft.acceptanceCriteria.filter(
      (c) => !draft.independentVerification.criteriaTraced.some((t) => t.trim() === c.trim()),
    );
    if (untraced.length > 0) {
      breaches.push(`${untraced.length} contractual acceptance criterion/criteria lack traced evidence`);
    }
    const failing = blockingFailures(draft.finalChecks, ctx.checks);
    if (failing.length > 0) {
      breaches.push(`required check(s) failing on the assembled product: ${failing.map((f) => f.categoryId).join(', ')}`);
    }
    const nonWaivableOpen = draft.findings.filter(
      (f) => f.nonWaivable && f.disposition !== 'accepted' && f.disposition !== 'rejected',
    );
    if (nonWaivableOpen.length > 0) {
      breaches.push(`${nonWaivableOpen.length} finding(s) on the non-waivable safety floor remain open`);
    }

    const accepted = breaches.length === 0;
    ctx.ledger.record('regulator_safety_floor', { accepted, breaches });
    return {
      accepted,
      procedure: 'independent assessment, then escrow release under the regulatory safety floor',
      rationale: accepted
        ? 'Acceptance terms satisfied: the assembled product was independently assessed, every criterion traced to evidence, and required checks pass. Escrow may be released.'
        : `Escrow withheld and delivery marked incomplete. The safety floor is not tradable: ${breaches.join('; ')}.`,
      decidedAt: new Date().toISOString(),
    };
  }

  /**
   * Repair under warranty. Section 10: "Conflicts and integration defects return to the liable firms
   * for repair and independent retest before the buyer releases acceptance", and section 9's
   * warranties "survive acceptance". A repeatedly defective supplier is relisted rather than paid
   * to try again, so a second cycle reopens the listing to fresh bidding.
   */
  async remediate(ctx: EngineContext, packet: RemediationPacket): Promise<TaskGraph> {
    const graph = ctx.runState.graph!;
    const state = getState(ctx);
    const named = new Set(packet.findings.flatMap((f) => f.affectedTaskIds ?? []));
    const targets = named.size > 0 ? [...named].filter((id) => graph.nodes[id]) : graph.order;
    const relisted: string[] = [];

    for (const id of targets) {
      graph.nodes[id].phase = 'queued';
      // Each listing's own findings with their evidence: a summary says that a check failed, the
      // evidence says why, and another listing's defects are not this contractor's to fix.
      graph.nodes[id].remediationOf = remediationNote(packet.findings, id);
      const contractorId = state.register.contractors[id];
      if (contractorId && state.capitalAccounts[contractorId]) {
        const forfeited = claimWarranty(state.capitalAccounts[contractorId], id);
        if (forfeited > 0) ctx.ledger.record('warranty_escrow_claimed', { taskId: id, contractorId, forfeited });
      }
      if (packet.cycle > 1) {
        relisted.push(id);
        delete state.approvals?.[id];
      }
    }

    // Section 6: "If a covered failure occurs, the reserve funds rollback, repair and investigation."
    // The claim is made against the pool the premiums built, and what the pool cannot cover is
    // disclosed rather than absorbed — an uncovered loss nobody records is the externalised risk the
    // whole instrument exists to price.
    for (const taskId of targets) fundRemediationOnce(ctx, taskId);

    ctx.ledger.record('warranty_claim_returned', {
      cycle: packet.cycle,
      taskIds: targets,
      relisted,
      escrowHeld: Object.keys(state.pendingEscrow ?? {}),
      findings: packet.findings.map((f) => f.summary),
    });
    return graph;
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function getConfig(ctx: EngineContext): CapitalistConfig {
  // loadStrategiesConfig has already filled every default; this only fills a hand-built context's.
  const raw = ctx.config as Partial<CapitalistConfig>;
  return {
    ...CAPITALIST_DEFAULTS,
    ...raw,
    riskClassification: { ...CAPITALIST_DEFAULTS.riskClassification, ...raw.riskClassification },
    arbitration: { ...CAPITALIST_DEFAULTS.arbitration, ...raw.arbitration },
    firms: { ...CAPITALIST_DEFAULTS.firms, ...raw.firms },
  };
}

function getState(ctx: EngineContext): CapitalistStrategyState {
  const s = ctx.strategyState as Partial<CapitalistStrategyState>;
  if (!s.capitalAccounts) s.capitalAccounts = {};
  if (!s.pendingEscrow) s.pendingEscrow = {};
  if (!s.approvals) s.approvals = {};
  if (!s.warrantyRepairs) s.warrantyRepairs = {};
  if (!s.retenderRequiredChanges) s.retenderRequiredChanges = {};
  // State saved before re-tender rounds were kept held one flat list per listing; a resumed run
  // reads it as a single unlabelled round.
  for (const [taskId, rounds] of Object.entries(s.retenderRequiredChanges)) {
    if (rounds.some((round) => typeof round === 'string')) {
      s.retenderRequiredChanges[taskId] = [{ attempt: 0, requiredChanges: rounds as unknown as string[] }];
    }
  }
  if (!s.excludedContractors) s.excludedContractors = {};
  if (!s.settlementDecisions) s.settlementDecisions = {};
  if (!s.recentWinners) s.recentWinners = [];
  if (!s.consumption) s.consumption = {};
  if (!s.contractTerms) s.contractTerms = {};
  if (!s.reserve) s.reserve = openReserve();
  if (!s.creditBook) s.creditBook = openCreditBook();
  if (!s.treasury) s.treasury = openTreasury();
  if (typeof s.arbitrations !== 'number') s.arbitrations = 0;
  if (typeof s.arbitrationsDeclined !== 'number') s.arbitrationsDeclined = 0;
  if (!s.unfilledListings) s.unfilledListings = [];
  if (typeof s.treasuryBalance !== 'number') s.treasuryBalance = 0;
  if (!s.insured) s.insured = {};
  if (!s.register) s.register = { contractors: {}, assessors: {}, subcontractors: {} };
  if (!s.regulatorActions) s.regulatorActions = [];
  if (!s.bidRecords) s.bidRecords = {};
  if (!s.settled) s.settled = [];
  if (!s.levied) s.levied = [];
  return s as CapitalistStrategyState;
}

function getAccount(ctx: EngineContext, state: CapitalistStrategyState, personaId: string, initialCapital: number): CapitalAccount {
  if (!state.capitalAccounts[personaId]) {
    state.capitalAccounts[personaId] = openAccount(personaId, resolveCapitalPolicy({ initialCapital }));
    const amount = state.capitalAccounts[personaId].capital;
    const issuance = { personaId, amount, source: 'run-charter' as const };
    (state.capitalIssuances ??= []).push(issuance);
    ctx.ledger.record('capital_issued', { personaId, amount, source: 'run-charter' });
  }
  return state.capitalAccounts[personaId];
}

function settlementAttemptKey(ctx: EngineContext, taskId: string): string {
  const attemptNumber = (ctx.runState.graph?.nodes[taskId]?.attempts.length ?? 0) + 1;
  return `${taskId}:${attemptNumber}`;
}

function isContractorExcluded(state: CapitalistStrategyState, taskId: string, personaId: string): boolean {
  return state.excludedContractors[taskId]?.includes(personaId) ?? false;
}

interface FailureDetails {
  regulatorFlag?: ReviewFinding;
  reviewFindings: readonly ReviewFinding[];
  testsBlocking: boolean;
  testResult?: TestResult;
}

interface BidderEligibilityInput {
  ctx: EngineContext;
  state: CapitalistStrategyState;
  node: TaskNode;
  config: CapitalistConfig;
  capitalPolicy: CapitalPolicy;
  personaPool: string[];
  additionalExclusions?: string[];
}

function eligibleBidderIds(input: BidderEligibilityInput): string[] {
  const additionallyExcluded = new Set(input.additionalExclusions ?? []);
  return input.personaPool.filter((personaId) => {
    if (additionallyExcluded.has(personaId) || isContractorExcluded(input.state, input.node.id, personaId)) {
      return false;
    }
    const account = getAccount(input.ctx, input.state, personaId, input.config.initialCapital);
    if (account.bankrupt) return false;
    // Capital already owed cannot also be put at risk on a high-risk contract.
    return input.node.riskClass !== 'high' || eligibleForHighRisk(account, input.capitalPolicy);
  });
}

/**
 * The engineering directive for a failed contract: what the next implementer must change. Commercial
 * consequences — profit, forfeited retention, a missed deadline or spend cap — are the settlement's
 * business and stay in its rationale and the ledger. Check output is not pasted either: the engine's
 * repair brief already carries it, with the reverted attempt, to whoever does the work next.
 */
function requiredChangesForFailure(details: FailureDetails): string[] {
  const requiredChanges: string[] = [];
  if (details.regulatorFlag) {
    const paths = details.regulatorFlag.evidenceRefs?.length
      ? ` Affected paths: ${details.regulatorFlag.evidenceRefs.join(', ')}.`
      : '';
    requiredChanges.push(`Bring the delivery within the awarded scope: ${details.regulatorFlag.rationale}.${paths}`);
  }
  // Every reject and flag, not just the first: a review that names two defects has not been
  // answered by fixing one.
  for (const finding of details.reviewFindings) {
    if (finding.reviewerId === 'regulator') continue;
    if (finding.verdict !== 'reject' && finding.verdict !== 'flag') continue;
    const evidence = finding.evidenceRefs?.length ? ` Evidence: ${finding.evidenceRefs.join(', ')}.` : '';
    requiredChanges.push(`Address the independent review finding: ${finding.rationale}.${evidence}`);
  }
  if (details.testsBlocking) {
    requiredChanges.push(
      `Make the failed check pass and add or strengthen regression coverage: ${failingCheckNames(details.testResult)}.`,
    );
  }
  return requiredChanges;
}

/** The checks charged to this task, by name and status — the output itself is in the repair brief. */
function failingCheckNames(test: TestResult | undefined): string {
  const checks = test?.checks ?? [];
  if (checks.length > 0) {
    return checks
      .map((check) => `${check.categoryId} (${check.status === 'new' ? 'passed before this change' : 'required, still failing'})`)
      .join(', ');
  }
  return test?.newFailures?.join(', ') || test?.command || 'the required check did not pass';
}

/** Judged (non-transient) attempts on a node after its last acceptance and before `attemptNumber`. */
function judgedAttemptsBefore(node: TaskNode, attemptNumber: number): number {
  const lastApproved = node.attempts.filter((attempt) => attempt.outcome === 'approved').at(-1)?.attempt ?? 0;
  return node.attempts.filter(
    (attempt) => !attempt.transient && attempt.attempt > lastApproved && attempt.attempt < attemptNumber,
  ).length;
}

/** Adds a failed round to a listing's re-tender history, once, keeping the last RETENDER_ROUNDS. */
function recordRetenderRound(
  state: CapitalistStrategyState,
  taskId: string,
  attempt: number,
  requiredChanges: readonly string[],
): void {
  const rounds = state.retenderRequiredChanges[taskId] ?? [];
  const recorded = rounds.some((round) =>
    (attempt > 0 && round.attempt === attempt) ||
    (round.requiredChanges.length === requiredChanges.length &&
      round.requiredChanges.every((change, i) => change === requiredChanges[i])));
  if (recorded || requiredChanges.length === 0) return;
  state.retenderRequiredChanges[taskId] = [...rounds, { attempt, requiredChanges: [...requiredChanges] }]
    .slice(-RETENDER_ROUNDS);
}

/**
 * A listing's re-tender history as directive lines, labelled by attempt so a firm can tell an old
 * round's fix from the latest defect. `maxChars` clips each change for bidders, who price the work.
 */
function retenderLines(rounds: readonly RetenderRound[], maxChars?: number): string[] {
  return rounds.flatMap((round) => {
    const label = round.attempt > 0 ? `attempt ${round.attempt}` : 'an earlier attempt';
    return round.requiredChanges.map((change) => {
      const text = maxChars !== undefined && change.length > maxChars ? `${change.slice(0, maxChars - 1)}…` : change;
      return `(${label}) ${text}`;
    });
  });
}

function isFundamentallyWrongApproach(rationale: string): boolean {
  return /fundamentally|wrong approach|unrelated implementation|rewrite from scratch|does not address the task/i.test(rationale);
}

function fundRemediationOnce(ctx: EngineContext, taskId: string, requestedAmount?: number): void {
  const state = getState(ctx);
  const cover = state.insured[taskId];
  if (!cover) return;

  if (state.reserve.claims.some((claim) => claim.taskId === taskId)) {
    return;
  }

  const amount = requestedAmount && requestedAmount > 0
    ? requestedAmount
    : state.pendingEscrow[taskId]?.price ?? cover.premium;
  const claim = payClaim(
    state.reserve,
    { taskId, personaId: cover.personaId, amount },
    resolveInsurancePolicy(getConfig(ctx).insurancePolicy),
  );
  ctx.ledger.record('claim_paid', {
    taskId,
    personaId: cover.personaId,
    paid: claim.paid,
    deductible: claim.deductible,
    shortfall: claim.shortfall,
    reserveBalance: state.reserve.balance,
    rationale: claim.rationale,
  });
}

/**
 * Heuristic: does this TestResult look like the test command itself failed to spawn/run (infra
 * unavailable) rather than the tests genuinely failing? Node's execFile('npm', ...) without
 * shell:true throws ENOENT on Windows since npm is a .cmd shim — a known quirk of the shared
 * engine's RepoWorktree.runAllowListedCommand (out of scope for this strategy to fix). Treating
 * that as a real test failure would reject every contract on an affected machine regardless of
 * code correctness, so we sniff the output for common "couldn't run the command at all" signatures.
 */
function looksLikeTestInfraFailure(test: TestResult): boolean {
  const text = `${test.output ?? ''} ${test.command ?? ''}`.toLowerCase();
  return (
    text.includes('enoent') ||
    text.includes('spawn npm') ||
    text.includes('is not recognized as an internal or external command') ||
    text.includes('command not found')
  );
}

/**
 * Runs a dispatch on a contract's account, metering what it consumed.
 *
 * Article 5 needs consumption measured rather than estimated, and the only honest place to measure
 * it is around the call that spends it. Tokens come from the delta in runState.tokensUsed, which
 * BudgetGuard maintains for every dispatch; cost comes back on the DispatchResult. Both are real
 * figures rather than a bidder's projection, which is the whole point — the exchange can now
 * compare what a firm quoted against what it actually burned.
 *
 * `attribution` separates the contractor's own calls from an assessor's, because section 6 prices
 * "reviewer attention" as its own scarce input and at a higher rate than an ordinary dispatch.
 */
async function meteredDispatch<T>(
  ctx: EngineContext,
  taskId: string,
  attribution: 'contractor' | 'assessor',
  opts: Parameters<EngineContext['dispatcher']['dispatch']>[0],
): Promise<DispatchResult<T>> {
  const state = getState(ctx);
  const consumption = consumptionFor(ctx, taskId);
  const terms = state.contractTerms[taskId];
  const quotedPrice = state.pendingEscrow[taskId]?.price ?? 0;
  if (attribution === 'contractor' && terms?.type === 'time-and-materials' && quotedPrice > 0 &&
    priceConsumption(consumption, resolvePriceList(getConfig(ctx).priceList)).total >=
      quotedPrice * (terms.spendCapMultiple ?? 1)) {
    throw new Error(`Time-and-materials spending authority exhausted for ${taskId}.`);
  }
  const before = { ...ctx.runState.tokensUsed };
  let ownUsage: { prompt: number; completion: number } | undefined;

  try {
    const result = (await ctx.dispatcher.dispatch({ ...opts, taskId })) as DispatchResult<T>;
    consumption.modelSpendUsd += result.costUsd ?? 0;
    if (result.promptTokens !== undefined && result.completionTokens !== undefined) {
      ownUsage = { prompt: result.promptTokens, completion: result.completionTokens };
    }
    return result;
  } finally {
    // In the finally block deliberately: a failed dispatch still burned tokens and still held a
    // context window. Charging only for calls that succeeded would make failure free, which is
    // exactly the incentive section 6 sets out to remove. A completed call reports its own usage;
    // the run-wide delta is the fallback for a failed one, and over-counts when calls overlap.
    consumption.promptTokens += ownUsage?.prompt ?? Math.max(0, ctx.runState.tokensUsed.prompt - before.prompt);
    consumption.completionTokens += ownUsage?.completion ?? Math.max(0, ctx.runState.tokensUsed.completion - before.completion);
    consumption.dispatches += 1;
    if (attribution === 'assessor') consumption.assessorDispatches += 1;
    state.consumption[taskId] = consumption;
  }
}

/** The consumption record for a contract, created on first use with the listing's risk class. */
function consumptionFor(ctx: EngineContext, taskId: string): ResourceConsumption & { awardedAtMs?: number; deliveredAtMs?: number } {
  const state = getState(ctx);
  const existing = state.consumption[taskId];
  if (existing) return existing;

  const node = ctx.runState.graph?.nodes[taskId];
  const created = {
    ...emptyConsumption(taskId, node?.riskClass ?? 'low'),
    dependants: countDependants(ctx, taskId),
    awardedAtMs: Date.now(),
  };
  state.consumption[taskId] = created;
  return created;
}

/**
 * Open contracts this bidder already holds — section 8's queue length, as opportunity cost.
 *
 * Counted from the register against nodes that have not reached a terminal phase, so a firm that
 * has already delivered three contracts is not treated as busy. Taking a contract means declining
 * whatever it displaces, and a bidder with a full queue is a more expensive choice than an idle one
 * of equal skill.
 */
function openContractsHeldBy(ctx: EngineContext, state: CapitalistStrategyState, personaId: string): number {
  const graph = ctx.runState.graph;
  if (!graph) return 0;
  return Object.entries(state.register.contractors).filter(
    ([taskId, holder]) => {
      const phase = graph.nodes[taskId]?.phase;
      return holder === personaId && phase !== 'settled' && phase !== 'abandoned';
    },
  ).length;
}

/**
 * How many firms could still take a contract.
 *
 * The test for whether a failure is systemic rather than ordinary. Section 6 lets a treasury act to
 * "prevent systemic collapse" and nothing weaker, so the question is not whether this firm is in
 * trouble but whether the market has anyone left — a firm that can be allowed to fail is allowed to.
 */
function solventBidders(state: CapitalistStrategyState, initialCapital: number): number {
  const accounts = Object.values(state.capitalAccounts ?? {});
  if (accounts.length === 0) return 0;
  return accounts.filter((a) => !a.bankrupt && a.capital > 0).length;
}

/** How many other contracts depend on this one — section 6's merge risk, as a count. */
function countDependants(ctx: EngineContext, taskId: string): number {
  const graph = ctx.runState.graph;
  if (!graph) return 0;
  return graph.order.filter((id) => graph.nodes[id]?.dependsOn.includes(taskId)).length;
}

/**
 * Findings per contract, for article 7's comparison against what each bid disclosed at tender.
 *
 * Findings with no taskId are delivery-level rather than contractual — an integration or
 * verification finding belongs to the assembled product, not to any one bidder — so they are not
 * counted against anybody's disclosure.
 */
function countFindingsByTask(findings: readonly Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    if (!finding.taskId) continue;
    counts[finding.taskId] = (counts[finding.taskId] ?? 0) + 1;
  }
  return counts;
}

/**
 * Informational-only collusion watch: if the same small set of personas keeps winning listings
 * back to back, log a ledger note. This is a logged statistical flag, NOT an enforced block —
 * real collusion/monopoly detection would need cross-run history and game-theoretic analysis,
 * which is out of scope for v1 (see class-level doc comment).
 */
function trackCollusionWatch(ctx: EngineContext, state: CapitalistStrategyState, winnerPersonaId: string): void {
  state.recentWinners.push(winnerPersonaId);
  const window = state.recentWinners.slice(-4);
  const distinct = new Set(window);
  if (window.length >= 4 && distinct.size <= 2) {
    ctx.ledger.record('collusion_watch', {
      note: 'Statistical flag only, not enforced (out of scope for v1): a small set of personas has won the last several listings.',
      recentWinners: window,
    });
  }
}

function slugify(s: string): string {
  const slug = s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return slug || 'task';
}

function dedupeSlugs(slugs: string[]): string[] {
  const used = new Set<string>();
  const result: string[] = [];
  for (const base of slugs) {
    let id = base;
    let n = 2;
    while (used.has(id)) {
      id = `${base}-${n}`;
      n += 1;
    }
    used.add(id);
    result.push(id);
  }
  return result;
}

function fallbackGraph(task: TaskSpec, config: CapitalistConfig): TaskGraph {
  const graph = emptyGraph();
  const targetGlobs = ['**/*'];
  const riskClass = classifyRiskByPaths(targetGlobs, { securityPathGlobs: config.riskClassification.securityPathGlobs });
  addNode(graph, {
    id: 'main',
    title: task.goal.slice(0, 80),
    description: task.goal,
    acceptanceCriteria: task.acceptanceCriteria,
    dependsOn: [],
    targetGlobs,
    riskTags: [],
    riskClass,
    phase: 'queued',
    attempts: [],
  });
  return graph;
}
