import { describe, expect, it } from 'vitest';
import {
  prepareAlternativeProgramme,
  replyCitesEvidence,
  replyIsDue,
  severityAfterReply,
  shadowMinisterFor,
  type GovernmentReply,
} from './opposition.js';
import { constituteOffices } from './offices.js';
import type { Finding } from '../../engine/packets.js';
import type { DemocraticConfig } from './types.js';
import { oppositionSystemPrompt, oppositionUserPrompt } from './prompts.js';

const cfg = {
  voteThresholds: {
    routine: 'simple_majority',
    cross_module: 'three_fifths',
    security_boundary: 'two_thirds_plus_security_committee',
    constitutional_amendment: 'two_thirds_both_chambers',
    test_waiver: 'human_required',
  },
  riskClassification: { securityPathGlobs: [], crossModuleThreshold: 2 },
  committee: { electedSpecialistCalls: 2, sortitionCalls: 1 },
  confidenceVote: { consecutiveFailuresBeforeSwap: 3 },
  questionTimeEveryNTasks: 5,
  shadowCabinet: { security: 'shadow-security-reviewer', default: 'shadow-general-reviewer' },
} as unknown as DemocraticConfig;

function reply(overrides: Partial<GovernmentReply> = {}): GovernmentReply {
  return { conceded: false, objectionsAnswered: ['Answered.'], citations: ['src/a.ts'], rationale: 'It holds.', ...overrides };
}

describe('the shadow cabinet', () => {
  it('sends the shadow who has been watching that portfolio', () => {
    const register = constituteOffices({ seed: 'r', cfg, constitutedAt: 'now' });
    expect(shadowMinisterFor(register, cfg, 'security')).toBe('shadow-security-reviewer');
  });

  it('falls back to the general shadow for an unmirrored portfolio', () => {
    expect(shadowMinisterFor(undefined, cfg, 'frontend')).toBe('shadow-general-reviewer');
  });
});

describe('when a reply is owed', () => {
  it('is owed on an objection', () => {
    expect(replyIsDue('reject', cfg)).toBe(true);
    expect(replyIsDue('flag', cfg)).toBe(true);
  });

  it('is not owed when the Opposition approved', () => {
    expect(replyIsDue('approve', cfg)).toBe(false);
  });

  it('is not owed when the convention is switched off', () => {
    expect(replyIsDue('reject', { ...cfg, debate: { ...cfg.debate, governmentReplyOnObjection: false } })).toBe(false);
  });

  it('is not owed when the motion is allowed no round of debate', () => {
    expect(replyIsDue('reject', { ...cfg, debate: { ...cfg.debate, maxRoundsPerMotion: 0 } })).toBe(false);
    expect(replyIsDue('reject', { ...cfg, debate: { ...cfg.debate, maxRoundsPerMotion: 1 } })).toBe(true);
  });
});

describe('what a reply is worth', () => {
  it('counts a rebuttal that cites something', () => {
    expect(replyCitesEvidence(reply())).toBe(true);
  });

  it('counts an uncited rebuttal for nothing — it is a repeated conclusion', () => {
    expect(replyCitesEvidence(reply({ citations: [] }))).toBe(false);
    expect(replyCitesEvidence(reply({ citations: ['  '] }))).toBe(false);
  });

  it('counts a concession for nothing, because it is agreement rather than an answer', () => {
    expect(replyCitesEvidence(reply({ conceded: true }))).toBe(false);
  });
});

describe('how a reply bears on the division', () => {
  it('softens a flag the government answered with evidence', () => {
    expect(severityAfterReply('flag', 'high', reply())).toBe('medium');
    expect(severityAfterReply('flag', 'medium', reply())).toBe('low');
  });

  // The Opposition saw the diff. A minister's account of why it is fine is not evidence that it is.
  it('never softens a reject', () => {
    expect(severityAfterReply('reject', 'high', reply())).toBe('high');
  });

  it('leaves an uncited reply changing nothing', () => {
    expect(severityAfterReply('flag', 'high', reply({ citations: [] }))).toBe('high');
  });

  it('leaves a conceded objection at full weight', () => {
    expect(severityAfterReply('flag', 'high', reply({ conceded: true }))).toBe('high');
  });

  it('leaves an unanswered objection at full weight', () => {
    expect(severityAfterReply('flag', 'high', null)).toBe('high');
  });
});

describe('the alternative programme', () => {
  function finding(overrides: Partial<Finding> = {}): Finding {
    return {
      id: 'f1',
      source: 'shadow-security-reviewer',
      summary: 'The boundary is unchecked.',
      evidenceRefs: [],
      disposition: 'unresolved',
      dispositionRationale: 'raised',
      ...overrides,
    };
  }

  it('is assembled from what the Opposition already argued', () => {
    const programme = prepareAlternativeProgramme(
      'shadow-general-reviewer',
      [{ id: 'm1', title: 'Rotate the keys' }],
      [finding()],
    );
    expect(programme.motions).toHaveLength(2);
    expect(programme.motions[0]).toContain('Rotate the keys');
    expect(programme.motions[1]).toContain('The boundary is unchecked.');
  });

  it('ignores findings nobody from the Opposition raised', () => {
    const programme = prepareAlternativeProgramme('shadow-general-reviewer', [], [finding({ source: 'engine:checks' })]);
    expect(programme.motions).toEqual([]);
  });

  it('drops an objection the House already accepted', () => {
    const programme = prepareAlternativeProgramme('shadow-general-reviewer', [], [finding({ disposition: 'accepted' })]);
    expect(programme.motions).toEqual([]);
  });

  // An Opposition that produced no alternative should be seen to have produced none.
  it('says so plainly when it has nothing on the record', () => {
    const programme = prepareAlternativeProgramme('shadow-general-reviewer', [], []);
    expect(programme.motions).toEqual([]);
    expect(programme.rationale).toContain('no alternative programme on the record');
  });
});

// The Opposition's reject overrides even a unanimous division (vote.ts), yet its prompt used to
// give no criteria for choosing reject over flag — the only blocking role in the file lacking
// them, while houseOfReviewSystemPrompt constrains "veto" at length. Benchmarking showed the
// cost: test-passing work, carried unanimously by committee, killed on one opposition verdict.
describe('the Opposition brief', () => {
  it('reserves reject for concrete defects rather than disagreement about design', () => {
    const prompt = oppositionSystemPrompt();

    expect(prompt).toContain('"reject"');
    expect(prompt).toMatch(/do not reach for it to express a strong opinion about design/i);
  });

  it('says approving a sound change is a normal outcome', () => {
    expect(oppositionSystemPrompt()).toMatch(/approving is a normal outcome/i);
  });

  // The reviewer sees an extract, not the repository. Without this it objects to absent code.
  it('forbids rejecting for something outside the extract shown', () => {
    const prompt = oppositionSystemPrompt();

    expect(prompt).toMatch(/do not reject a change for something you merely cannot see/i);
    expect(prompt).toMatch(/flag it rather than rejecting/i);
  });

  it('names the portfolio so shadow ministers are not interchangeable', () => {
    expect(oppositionSystemPrompt('security')).toContain('security portfolio');
    expect(oppositionSystemPrompt()).not.toContain('portfolio in the shadow cabinet');
  });

  // An edit was rendered as find=<300 chars> replace=<300 chars>: far too little to judge.
  it('shows an edit in full rather than a keyhole fragment', () => {
    const find = 'a'.repeat(1200);
    const replace = 'b'.repeat(1200);

    const prompt = oppositionUserPrompt(
      'Motion',
      'rationale',
      [{ op: 'edit', path: 'src/x.py', find, replace }],
      ['criterion'],
      { ran: true, passed: true },
    );

    expect(prompt).toContain(find);
    expect(prompt).toContain(replace);
  });

  it('marks a truncated extract so an objection is never founded on the cut', () => {
    const prompt = oppositionUserPrompt(
      'Motion',
      'rationale',
      [{ op: 'write', path: 'src/x.py', content: 'x'.repeat(25_000) }],
      [],
      { ran: true, passed: true },
    );

    expect(prompt).toContain('do not treat what follows as absent');
  });

  it('asks the Opposition to name a remedy for every objection', () => {
    expect(oppositionSystemPrompt()).toMatch(/name the remedy/i);
  });
});
