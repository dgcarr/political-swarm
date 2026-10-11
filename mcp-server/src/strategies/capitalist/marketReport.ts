// The run's account of itself to its own market — the capitalist analogue of the socialist commons
// report, and the point at which the reported articles stop being private bookkeeping.
//
// Section 9 sets out what the record owes: "exact commands, material execution context, outcomes and
// relevant output, environmental limitations, skipped or inapplicable checks and their contractual
// reasons, and unresolved failures." Section 6 adds the market's own disclosures — what the levy
// collected, what the reserve covered and failed to cover, what credit is outstanding, which
// listings cleared no bid. And the constitution's reported articles land here rather than blocking:
// concentration, unpriced consumption, disclosure gaps, unpriced externalities and free-riding are
// all things a reader must be able to see even though refusing the delivery over them would be
// worse than shipping it.
//
// Two things about where this runs, and they are the same two the socialist report warns about.
//
// It writes into strategyState.deliveryNotes, the doctrine-neutral channel engine/delivery.ts reads.
// Without it a market has no way to disclose anything that is neither a check result nor a finding,
// and almost everything above is exactly that.
//
// And it must run at the end of disposeFindings(), not in accept(). assembleDelivery reads those
// notes before accept() is called, so a report filed there is silently dropped — which is worse than
// filing none, because the run would then look as though it had accounted for itself.

import type { CheckRunRecord, Finding } from '../../engine/packets.js';
import type { Concentration, DisclosureBreach } from './constitution.js';
import type { Reserve } from './insurance.js';
import type { CreditBook } from './credit.js';
import type { Treasury } from './treasury.js';
import type { CapitalAccount } from './types.js';

export interface MarketReport {
  /** The closing position of every firm that traded. */
  positions: string[];
  /** What the market could not fund, could not cover, or could not fill. */
  unmet: string[];
  /** Findings going out of the door unresolved. */
  unresolved: string[];
  /** Section 9's "skipped or inapplicable checks and their contractual reasons". */
  skippedChecks: string[];
  /** Obligations carried forward, with who owns them. */
  carried: string[];
  limitations: string[];
}

export interface MarketReportInput {
  accounts: Readonly<Record<string, CapitalAccount>>;
  capitalIssuances?: readonly { personaId: string; amount: number; source: 'run-charter' }[];
  treasury: Treasury;
  reserve: Reserve;
  creditBook: CreditBook;
  findings: readonly Finding[];
  finalChecks: readonly CheckRunRecord[];
  /** Listings that cleared no bid at any price. */
  unfilledListings: readonly { taskId: string; reason: string }[];
  /** Article 4, reported rather than blocking. */
  concentration: readonly Concentration[];
  /** Article 5: contracts settled with no recorded resource price. */
  unpricedContracts: readonly string[];
  /** Article 7: bids whose disclosure did not match what the delivery carried. */
  disclosureBreaches: readonly DisclosureBreach[];
  /** Article 9: settled contracts that paid no levy. */
  freeRiders: readonly string[];
  /** How many disputes were heard, and how many went unheard against the cap. */
  arbitrationsHeld: number;
  arbitrationsDeclined: number;
}

export function buildMarketReport(input: MarketReportInput): MarketReport {
  const positions: string[] = [];
  const unmet: string[] = [];
  const limitations: string[] = [];

  for (const account of Object.values(input.accounts)) {
    positions.push(
      `${account.personaId}: capital ${account.capital.toFixed(2)}, liabilities ` +
        `${(account.liabilities ?? 0).toFixed(2)}, retention held ${account.heldEscrow.toFixed(2)}, standing ` +
        `${account.reputationScore.toFixed(2)} over ${account.settlements ?? 0} settlement(s)` +
        (account.bankrupt ? ' — insolvent, its contracts moved on' : ''),
    );
  }

  positions.push(
    `Treasury: ${input.treasury.publicGoodsFund.toFixed(2)} in the public-goods fund and ` +
      `${input.treasury.venturePool.toFixed(2)} in the venture pool, from ` +
      `${input.treasury.levies.length} levy/levies.`,
  );
  if (input.capitalIssuances?.length) {
    positions.push(`Run charter issued ${input.capitalIssuances.reduce((sum, issuance) => sum + issuance.amount, 0).toFixed(2)} ` +
      `in virtual starting claims to ${input.capitalIssuances.length} firm(s). These claims are not levy revenue or cash backing.`);
  }
  positions.push(
    `Insurance: ${input.reserve.premiumsCollected.toFixed(2)} collected, ${input.reserve.claimsPaid.toFixed(2)} paid ` +
      `on ${input.reserve.claims.length} claim(s), ${input.reserve.balance.toFixed(2)} held.`,
  );
  for (const grant of input.treasury.grants) {
    positions.push(`Grant ${grant.amount.toFixed(2)} for ${grant.good}` +
      `${grant.taskId ? ` on "${grant.taskId}"` : ''}: ${grant.rationale}`);
  }

  const outstanding = Object.entries(input.creditBook.outstanding);
  if (outstanding.length > 0) {
    positions.push(
      `Credit outstanding at close: ${outstanding.map(([id, n]) => `${id} ${n.toFixed(2)}`).join(', ')}. ` +
        'A run ending with debt outstanding has been funded partly by a promise nobody has yet kept.',
    );
  }

  // ------------------------------------------------------------- what the market could not do

  for (const listing of input.unfilledListings) {
    unmet.push(`"${listing.taskId}" cleared no bid: ${listing.reason}`);
  }
  for (const refusal of input.creditBook.refusals) {
    unmet.push(`${refusal.personaId} was refused credit: ${refusal.reason}`);
  }
  for (const claim of input.reserve.claims.filter((c) => c.shortfall > 0)) {
    unmet.push(
      `The reserve could not cover ${claim.shortfall.toFixed(2)} of the claim on "${claim.taskId}". ` +
        'An uncovered loss is risk that was priced and then not carried.',
    );
  }
  for (const refused of input.treasury.bailoutsRefused) {
    unmet.push(`${refused.personaId} was not rescued: ${refused.reason}`);
  }

  // A rescue is the treasury acting against its own default, so it is disclosed as prominently as a
  // refusal rather than being left as a line in the accounts.
  for (const bailout of input.treasury.bailouts) {
    limitations.push(
      `${bailout.personaId} was rescued with ${bailout.amount.toFixed(2)} of public money against a shortfall of ` +
        `${bailout.shortfall.toFixed(2)}. ${bailout.rationale}`,
    );
  }

  // ------------------------------------------------------------ the reported articles

  for (const concentration of input.concentration) {
    limitations.push(concentration.remedy);
  }
  if (input.unpricedContracts.length > 0) {
    limitations.push(
      `Article 5: ${input.unpricedContracts.length} contract(s) settled with no recorded resource price ` +
        `(${input.unpricedContracts.join(', ')}), so what they consumed is not on any book.`,
    );
  }
  for (const breach of input.disclosureBreaches) {
    limitations.push(`Article 7: ${breach.remedy}`);
  }
  if (input.freeRiders.length > 0) {
    limitations.push(
      `Article 9: ${input.freeRiders.length} settled contract(s) paid no levy (${input.freeRiders.join(', ')}), ` +
        'free-riding on the shared infrastructure they were delivered against.',
    );
  }
  if (input.arbitrationsDeclined > 0) {
    limitations.push(
      `${input.arbitrationsDeclined} dispute(s) went unheard against this run's arbitration limit. Unheard is not ` +
        'the same as unfounded, and each fell against the party carrying the burden of proof.',
    );
  }

  // ------------------------------------------------------------------- findings and checks

  const unresolved = input.findings
    .filter((f) => f.disposition === 'unresolved')
    .map((f) => `${f.summary}${f.minority ? ' (recorded as a disclosed liability the parties did not agree on)' : ''}`);

  const carried = input.findings
    .filter((f) => f.disposition === 'deferred')
    .map((f) => `${f.summary}${f.owner ? ` — owned by ${f.owner}` : ' — nobody named as owner'}`);
  for (const account of Object.values(input.accounts)) {
    for (const lot of account.escrowLots ?? []) {
      carried.push(
        `Warranty on "${lot.taskId}" remains with ${account.personaId}: ${lot.amount.toFixed(2)} held until ` +
        `the firm's settlement ${lot.maturesAfterSettlement}` +
        `${lot.attemptKey ? ` (attempt ${lot.attemptKey})` : ''}` +
        `${lot.artifactDigest ? `, artifact ${lot.artifactDigest.slice(0, 12)}` : ''}. ` +
        `No claim monitoring occurs after this run closes.`,
      );
    }
  }

  const skippedChecks = input.finalChecks
    .filter((c) => !c.ran)
    .map((c) => `${c.categoryId}: ${c.skippedReason ?? 'no contractual reason recorded, which is itself a gap in the record'}`);

  return { positions, unmet, unresolved, skippedChecks, carried, limitations };
}

/**
 * The report as the doctrine-neutral notes engine/delivery.ts appends to the manifest.
 *
 * Additive by construction: nothing here can remove a limitation the engine found. That is what
 * keeps a market's own account of itself from being able to quiet the evidence against it — which
 * matters more here than under the other doctrines, since this is the one where the party writing
 * the report is also the party being paid.
 */
export function toDeliveryNotes(report: MarketReport): {
  limitations: string[];
  residualRisks: string[];
  rollbackNotes: string[];
} {
  return {
    limitations: [
      ...report.limitations,
      ...report.unmet.map((u) => `The market did not clear this: ${u}`),
      ...report.skippedChecks.map((c) => `Check not run — ${c}`),
    ],
    residualRisks: [
      ...report.unresolved.map((u) => `[market] ${u}`),
      ...report.carried.map((c) => `[carried forward] ${c}`),
    ],
    rollbackNotes:
      report.positions.length > 0
        ? [`Closing positions at settlement: ${report.positions.join(' | ')}`]
        : [],
  };
}
