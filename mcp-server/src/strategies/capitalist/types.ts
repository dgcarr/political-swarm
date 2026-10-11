// Types local to the capitalist strategy: its config shape, its internal task-exchange
// vocabulary (listings/bids/capital accounts), and the JSON contracts each dispatcher role
// must satisfy. Kept separate from mcp-server/src/engine/types.ts because these are governance
// mechanics specific to this strategy, not shared engine concepts.
import { z } from 'zod';
import type { Assignment, Decision, FileOp, RiskClass } from '../../engine/types.js';
import type { CheckRunRecord } from '../../engine/packets.js';
import type { PriceList, ResourceConsumption } from './prices.js';
import type { ListingTerms } from './exchange.js';
import type { ContractPolicy, ContractTerms } from './contracts.js';
import type { DiligenceReport } from './diligence.js';
import type { CapitalPolicy } from './capital.js';
import type { InsurancePolicy, Reserve } from './insurance.js';
import type { CreditBook, CreditPolicy } from './credit.js';
import type { Treasury, TreasuryPolicy } from './treasury.js';

/** The `capitalist:` block of config/strategies.yaml, as constitution/schema.ts validates it. */
export type { CapitalistConfig } from '../../constitution/schema.js';

/** A TaskNode as offered on the internal task exchange for bidding. */
export interface TaskListing {
  taskId: string;
  title: string;
  description: string;
  riskClass: RiskClass;
  targetGlobs: string[];
}

/** One domain's standing, with the settlement it was last updated at so decay can be applied. */
export interface DomainReputation {
  domain: string;
  score: number; // 0..1
  samples: number;
  lastUpdatedAtSettlement: number;
}

/** Per-persona ledger tracked in ctx.strategyState.capitalAccounts. */
export interface CapitalAccount {
  personaId: string;
  capital: number;
  /** A summary of the domain records below, not a competing opinion. 0..1, starts at 0.5. */
  reputationScore: number;
  defects: number; // total rejected contracts
  cleanTasksInARow: number; // consecutive approved contracts since the last defect
  heldEscrow: number; // accumulated escrow not yet released back to capital
  escrowLots?: Array<{ taskId: string; amount: number; maturesAfterSettlement: number; claimed: boolean;
    attemptKey?: string; artifactDigest?: string }>;
  bankrupt: boolean;
  /**
   * Section 6: "Reputation should be domain-specific and decay over time." A firm with an excellent
   * security record is not thereby a good documentation supplier.
   */
  reputationByDomain?: Record<string, DomainReputation>;
  /** Obligations left for others to carry. Section 11 tests these against capital, not capital alone. */
  liabilities?: number;
  /** Section 11's second ground for insolvency: repeated contract failure. */
  consecutiveFailures?: number;
  /** How many settlements this firm has been through, which is the only clock a run has. */
  settlements?: number;
}

export interface WarrantyRepairOrder {
  /** The original award, including its bid, listing, firm and contract terms. */
  assignment: Assignment;
  requiredChanges: string[];
  /** The engine attempt whose failure ordered the repair. */
  attempt?: number;
}

/** One failed contract's required changes on a listing, labelled by the engine attempt it came from. */
export interface RetenderRound {
  attempt: number;
  requiredChanges: string[];
}

export interface CapitalistStrategyState {
  capitalAccounts: Record<string, CapitalAccount>;
  /** Virtual starting claims minted by the run charter, never mistaken for treasury revenue. */
  capitalIssuances?: Array<{ personaId: string; amount: number; source: 'run-charter' }>;
  /** taskId -> escrow withheld from the winning bid's contract price, resolved at decide() time. */
  pendingEscrow: Record<string, { personaId: string; amount: number; price: number }>;
  /** taskId -> PendingApproval id, for high-risk listings gated on human spend approval. */
  approvals: Record<string, string>;
  /** Repairs still owed under the original award, consumed by assign() without opening an auction. */
  warrantyRepairs: Record<string, WarrantyRepairOrder>;
  /**
   * taskId -> what the last few failed contracts on a relisted task were required to change, oldest
   * first. The failed firms keep their liability; the next bidders and the next award are told what
   * needed fixing — every recent round, not only the last, so a fix one firm made is not undone by
   * the next firm, which never heard of it.
   */
  retenderRequiredChanges: Record<string, RetenderRound[]>;
  /** Suppliers barred from a task's next tender after a liable warranty failure. */
  excludedContractors: Record<string, string[]>;
  /** Completed decisions by engine-visible attempt slot, preventing replayed settlement charges. */
  settlementDecisions: Record<string, Decision>;
  /**
   * Who held which office, for article 4. Built as the run goes rather than reconstructed at the
   * gate, because by acceptance time the assignments have been overwritten by remediation and the
   * question "did the firm that was paid also certify the work" would no longer be answerable.
   */
  register: {
    /** taskId -> the lead contractor paid for it. */
    contractors: Record<string, string>;
    /** taskId -> the reviewer who assessed it. */
    assessors: Record<string, string>;
    /** Lead contractor -> subcontractors engaged, so a firm cannot review its own subcontract. */
    subcontractors: Record<string, string[]>;
  };
  /**
   * Every block the regulator laid down, with the ground it cited. Article 10 binds the regulator to
   * published rules, which is only checkable if its rulings are recorded as they are made.
   */
  regulatorActions: Array<{ taskId: string; ground: string; rationale: string }>;
  /** What each bid disclosed at tender, kept for article 7's comparison against the delivery. */
  bidRecords: Record<string, { personaId: string; declaredRisks: string[]; quotedPrice: number; estimatedResourceCost?: number; successProbability?: number }>;
  /**
   * What each contract consumed, accumulated as it runs rather than estimated afterwards.
   * Article 5 wants scarcity visible, and a consumption figure reconstructed at settlement would be
   * a guess dressed as a price.
   */
  consumption: Record<string, ResourceConsumption & { awardedAtMs?: number; deliveredAtMs?: number }>;
  /** Section 9's pre-bid inspection of the repository, shared by every listing in the run. */
  diligence?: DiligenceReport;
  /** The shape each contract was let on — what is withheld, for how long, and any cap. */
  contractTerms: Record<string, ContractTerms>;
  /** Settled contracts, for articles 5 and 9. */
  settled: Array<{ taskId: string; personaId: string; price: number; resourceCost?: number }>;
  /** The pooled reserve premiums build and claims draw on (section 6's insurance). */
  reserve: Reserve;
  /** What each firm has borrowed against its record, and what the market as a whole owes. */
  creditBook: CreditBook;
  /** The levy, the public-goods fund, the venture pool and every rescue refused or granted. */
  treasury: Treasury;
  /** How many disputes this run has already sent to arbitration. */
  arbitrations: number;
  /** Disputes that went unheard against the cap. Unheard is not the same as unfounded. */
  arbitrationsDeclined: number;
  /** The assembled checks, kept at verification so the market report can disclose the skips. */
  finalChecks?: CheckRunRecord[];
  /** Listings that cleared no bid at any price, for the market report. */
  unfilledListings: Array<{ taskId: string; reason: string }>;
  /** The doctrine-neutral channel engine/delivery.ts reads when assembling the manifest. */
  deliveryNotes?: { limitations: string[]; residualRisks: string[]; rollbackNotes: string[] };
  /** The treasury's balance, which together with the reserve is what backs the credit book. */
  treasuryBalance: number;
  /** taskId -> the premium charged and who paid it. */
  insured: Record<string, { personaId: string; premium: number }>;
  /** Task ids from which the treasury collected its levy (article 9). */
  levied: string[];
  /**
   * Informational-only collusion watch (see CapitalistStrategy.trackCollusionWatch): the last
   * few listing winners, used purely to log a statistical flag. Never enforced/blocking — real
   * collusion/monopoly detection is out of scope for v1.
   */
  recentWinners: string[];
}

// ---------------------------------------------------------------------------------------------
// Dispatcher I/O contracts. `validate` on WorkerDispatcher.dispatch is (value: unknown) => void,
// so these zod schemas are used purely for their throwing behavior (opts.validate = (v) =>
// schema.parse(v)); the raw parsed JSON — not the zod-defaulted object — is what dispatch<T>
// actually returns, so every optional field is read defensively (`?? []` etc.) at the call site.
// ---------------------------------------------------------------------------------------------

export const PlannedTaskSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string()).optional(),
  targetGlobs: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
});
export const PlannerOutputSchema = z.object({
  tasks: z.array(PlannedTaskSchema).min(1),
});
export interface PlannedTaskRaw {
  id?: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  targetGlobs?: string[];
  dependsOn?: string[];
}
export interface PlannerOutput {
  tasks: PlannedTaskRaw[];
}

export const BidSchema = z.object({
  priceTokens: z.number().finite().nonnegative(),
  estTime: z.number().finite().nonnegative(),
  confidence: z.number().min(0).max(1),
  approach: z.string().min(1),
  warranties: z.array(z.string()).optional(),
  /** Article 7's disclosure duty at tender. Silence here is what undisclosedRisk() prices. */
  knownRisks: z.array(z.string()).optional(),
  /** Section 6: a bid states its expected token and compute use, not only its price. */
  expectedTokens: z.number().finite().nonnegative().optional(),
  estimatedResourceCost: z.number().finite().nonnegative().optional(),
  /** Section 6: a bid names its subcontractors. Section 5 lets the winner engage them. */
  subcontractors: z.array(z.string()).optional(),
});
export interface Bid {
  priceTokens: number;
  estTime: number;
  confidence: number;
  approach: string;
  warranties?: string[];
  knownRisks?: string[];
  expectedTokens?: number;
  estimatedResourceCost?: number;
  subcontractors?: string[];
}

const FileOpSchema = z.union([
  z.object({ op: z.literal('write'), path: z.string().min(1), content: z.string() }),
  z.object({ op: z.literal('edit'), path: z.string().min(1), find: z.string().min(1), replace: z.string() }),
  z.object({ op: z.literal('delete'), path: z.string().min(1) }),
]);
export const ImplementerOutputSchema = z.object({
  fileOps: z.array(FileOpSchema),
  rationale: z.string().min(1),
  unresolvedUncertainty: z.string().optional(),
});
export interface ImplementerOutput {
  fileOps: FileOp[];
  rationale: string;
  unresolvedUncertainty?: string;
}

export const ReviewerOutputSchema = z.object({
  verdict: z.enum(['approve', 'reject', 'flag']),
  rationale: z.string().min(1),
});
export interface ReviewerOutput {
  verdict: 'approve' | 'reject' | 'flag';
  rationale: string;
}
