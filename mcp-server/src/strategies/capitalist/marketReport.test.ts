import { describe, expect, it } from 'vitest';
import { buildMarketReport, toDeliveryNotes, type MarketReportInput } from './marketReport.js';
import { openAccount } from './capital.js';
import { openReserve } from './insurance.js';
import { openCreditBook } from './credit.js';
import { openTreasury } from './treasury.js';
import type { Finding } from '../../engine/packets.js';

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    source: 'assessor',
    summary: 'A summary.',
    evidenceRefs: [],
    disposition: 'accepted',
    dispositionRationale: 'r',
    ...over,
  } as Finding;
}

function input(over: Partial<MarketReportInput> = {}): MarketReportInput {
  return {
    accounts: { 'firm-a': { ...openAccount('firm-a'), settlements: 2 } },
    treasury: openTreasury(),
    reserve: openReserve(),
    creditBook: openCreditBook(),
    findings: [],
    finalChecks: [],
    unfilledListings: [],
    concentration: [],
    unpricedContracts: [],
    disclosureBreaches: [],
    freeRiders: [],
    arbitrationsHeld: 0,
    arbitrationsDeclined: 0,
    ...over,
  };
}

describe('the closing position', () => {
  it('reports every firm that traded', () => {
    const report = buildMarketReport(input());
    expect(report.positions.join(' ')).toContain('firm-a: capital');
    expect(report.positions.join(' ')).toContain('standing');
  });

  it('says when a firm went insolvent and its contracts moved', () => {
    const report = buildMarketReport(
      input({ accounts: { 'firm-a': { ...openAccount('firm-a'), bankrupt: true } } }),
    );
    expect(report.positions.join(' ')).toContain('insolvent, its contracts moved on');
  });

  it('reports the treasury and the reserve even when nothing moved through them', () => {
    const report = buildMarketReport(input());
    expect(report.positions.join(' ')).toContain('Treasury:');
    expect(report.positions.join(' ')).toContain('Insurance:');
  });

  it('discloses that entrant capital is charter issuance rather than treasury backing', () => {
    const report = buildMarketReport(input({
      capitalIssuances: [{ personaId: 'firm-a', amount: 500, source: 'run-charter' }],
    }));
    expect(report.positions.join(' ')).toContain('500.00 in virtual starting claims');
    expect(report.positions.join(' ')).toContain('not levy revenue or cash backing');
  });

  // A run ending with debt outstanding was funded partly by a promise nobody has yet kept, and that
  // is a fact about the delivery rather than about the firm.
  it('discloses credit still outstanding at close', () => {
    const creditBook = { ...openCreditBook(), outstanding: { 'firm-a': 40 } };
    const report = buildMarketReport(input({ creditBook }));
    expect(report.positions.join(' ')).toContain('Credit outstanding');
    expect(report.positions.join(' ')).toContain('a promise nobody has yet kept');
  });
});

describe('what the market could not do', () => {
  it('reports a listing that cleared no bid', () => {
    const report = buildMarketReport(
      input({ unfilledListings: [{ taskId: 't1', reason: 'no eligible bidders' }] }),
    );
    expect(report.unmet.join(' ')).toContain('cleared no bid');
  });

  it('reports credit the market refused to extend', () => {
    const creditBook = { ...openCreditBook(), refusals: [{ personaId: 'firm-a', requested: 50, reason: 'at the ceiling' }] };
    const report = buildMarketReport(input({ creditBook }));
    expect(report.unmet.join(' ')).toContain('refused credit');
  });

  it('reports a claim the reserve could not cover', () => {
    const reserve = {
      ...openReserve(),
      claims: [{ taskId: 't1', personaId: 'firm-a', requested: 100, paid: 10, deductible: 25, shortfall: 65 }],
    };
    const report = buildMarketReport(input({ reserve }));
    expect(report.unmet.join(' ')).toContain('could not cover');
    expect(report.unmet.join(' ')).toContain('priced and then not carried');
  });

  it('reports a rescue the treasury refused', () => {
    const treasury = { ...openTreasury(), bailoutsRefused: [{ personaId: 'firm-a', reason: 'not systemic' }] };
    const report = buildMarketReport(input({ treasury }));
    expect(report.unmet.join(' ')).toContain('was not rescued');
  });

  // A rescue is the treasury acting against its own default, so it is disclosed as prominently as a
  // refusal rather than left as a line in the accounts.
  it('discloses a rescue that was granted, not only ones refused', () => {
    const treasury = {
      ...openTreasury(),
      bailouts: [{ personaId: 'firm-a', shortfall: 100, amount: 50, rationale: 'systemic' }],
    };
    const report = buildMarketReport(input({ treasury }));
    expect(report.limitations.join(' ')).toContain('rescued with 50.00 of public money');
  });
});

describe('the articles that report rather than block', () => {
  it('carries a concentration remedy through to the record', () => {
    const report = buildMarketReport(
      input({ concentration: [{ personaId: 'firm-a', awards: ['t1', 't2'], share: 0.67, remedy: 'Preserve entry.' }] }),
    );
    expect(report.limitations).toContain('Preserve entry.');
  });

  it('names contracts whose consumption nobody priced', () => {
    const report = buildMarketReport(input({ unpricedContracts: ['t1', 't2'] }));
    expect(report.limitations.join(' ')).toContain('Article 5');
    expect(report.limitations.join(' ')).toContain('not on any book');
  });

  it('carries a disclosure breach', () => {
    const report = buildMarketReport(
      input({
        disclosureBreaches: [
          { taskId: 't1', personaId: 'firm-a', kind: 'undisclosed-risk', article: 'article-7', remedy: 'Silence at tender.' },
        ],
      }),
    );
    expect(report.limitations.join(' ')).toContain('Article 7: Silence at tender.');
  });

  it('names contracts that paid no levy', () => {
    const report = buildMarketReport(input({ freeRiders: ['t3'] }));
    expect(report.limitations.join(' ')).toContain('free-riding');
  });

  // Unheard is not the same as unfounded, and each unheard dispute fell against a party.
  it('discloses disputes that went unheard against the cap', () => {
    const report = buildMarketReport(input({ arbitrationsDeclined: 2 }));
    expect(report.limitations.join(' ')).toContain('went unheard');
    expect(report.limitations.join(' ')).toContain('not the same as unfounded');
  });

  it('says nothing at all when the market kept to its constitution', () => {
    expect(buildMarketReport(input()).limitations).toEqual([]);
  });
});

describe('findings and checks', () => {
  it('carries unresolved findings out of the door as unresolved', () => {
    const report = buildMarketReport(
      input({ findings: [finding({ disposition: 'unresolved', summary: 'A race condition remains.' })] }),
    );
    expect(report.unresolved).toEqual(['A race condition remains.']);
  });

  it('marks a disclosed liability the parties did not agree on', () => {
    const report = buildMarketReport(
      input({ findings: [finding({ disposition: 'unresolved', minority: true })] }),
    );
    expect(report.unresolved[0]).toContain('did not agree on');
  });

  it('names who owns a deferred obligation, or that nobody does', () => {
    const report = buildMarketReport(
      input({
        findings: [
          finding({ id: 'f1', disposition: 'deferred', summary: 'Debt.', owner: 'firm-a' }),
          finding({ id: 'f2', disposition: 'deferred', summary: 'More debt.' }),
        ],
      }),
    );
    expect(report.carried[0]).toContain('owned by firm-a');
    expect(report.carried[1]).toContain('nobody named as owner');
  });

  it('records a skipped check and its reason', () => {
    const report = buildMarketReport(
      input({
        finalChecks: [{ categoryId: 'lint', command: 'npm', args: [], ran: false, passed: false, skippedReason: 'no linter' }],
      }),
    );
    expect(report.skippedChecks).toEqual(['lint: no linter']);
  });

  it('says so when a skip recorded no reason — the silence is the finding', () => {
    const report = buildMarketReport(
      input({ finalChecks: [{ categoryId: 'lint', command: 'npm', args: [], ran: false, passed: false }] }),
    );
    expect(report.skippedChecks[0]).toContain('no contractual reason recorded');
  });
});

describe('what reaches the delivery packet', () => {
  it('routes limitations, unmet demand and skipped checks into limitations', () => {
    const notes = toDeliveryNotes(
      buildMarketReport(
        input({
          freeRiders: ['t1'],
          unfilledListings: [{ taskId: 't2', reason: 'no bids' }],
          finalChecks: [{ categoryId: 'lint', command: 'npm', args: [], ran: false, passed: false, skippedReason: 'x' }],
        }),
      ),
    );
    expect(notes.limitations.join(' ')).toContain('free-riding');
    expect(notes.limitations.join(' ')).toContain('The market did not clear this');
    expect(notes.limitations.join(' ')).toContain('Check not run');
  });

  it('routes unresolved and carried findings into residual risks', () => {
    const notes = toDeliveryNotes(
      buildMarketReport(
        input({
          findings: [
            finding({ id: 'f1', disposition: 'unresolved', summary: 'Open.' }),
            finding({ id: 'f2', disposition: 'deferred', summary: 'Later.', owner: 'firm-a' }),
          ],
        }),
      ),
    );
    expect(notes.residualRisks.join(' ')).toContain('[market] Open.');
    expect(notes.residualRisks.join(' ')).toContain('[carried forward] Later.');
  });

  it('puts the closing positions where a rollback reader will see them', () => {
    const notes = toDeliveryNotes(buildMarketReport(input()));
    expect(notes.rollbackNotes.join(' ')).toContain('Closing positions at settlement');
  });
});
