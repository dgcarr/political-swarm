import { describe, expect, it } from 'vitest';
import {
  committeeSchemaDescription,
  committeeSystemPrompt,
  committeeUserPrompt,
  commonsVerifierUserPrompt,
  commonsVerifierSystemPrompt,
  houseOfReviewSystemPrompt,
  houseOfReviewUserPrompt,
  implementerUserPrompt,
  integrationCommitteeUserPrompt,
  oppositionSystemPrompt,
  oppositionUserPrompt,
  plannerUserPrompt,
  dispositionUserPrompt,
  governmentReplyUserPrompt,
} from './prompts.js';

/**
 * A committee member choosing a verdict is operating an instrument whose arithmetic decides the
 * motion: flag is scored as half a vote in favour (commons.committeeSignal), so a motion every
 * member flags scores 0.50 and fails a three_fifths threshold with nobody having opposed it. That
 * is exactly what happened to `damage_calc` and `nuclear_data` in a real benchmark run, while the
 * prompt was asking members to flag concerns without telling them what flagging costs.
 *
 * The scoring is deliberate and stays as it is. What these pin is that the instrument is disclosed
 * to the member using it, and that approving is presented as a normal outcome rather than a lapse
 * in scrutiny.
 */
describe('committee verdict instructions', () => {
  it('tells the member that a flag weighs against the motion', () => {
    expect(committeeSchemaDescription).toMatch(/half a vote/i);
  });

  it('warns that a unanimously flagged motion fails unopposed', () => {
    expect(committeeSchemaDescription).toMatch(/every member flags/i);
  });

  it('still explains abstention as declining to vote rather than voting maybe', () => {
    expect(committeeSchemaDescription).toMatch(/not a way of voting "maybe"/i);
  });

  it('presents approval as a normal outcome for the specialist seat', () => {
    expect(committeeSystemPrompt('elected', 'backend')).toMatch(/normal and expected/i);
  });

  it('tells the lay seat that deferring means approving, not flagging', () => {
    expect(committeeSystemPrompt('sortition', 'backend')).toMatch(/deferring means approving/i);
  });

  it('keeps both seats scrutinising rather than rubber-stamping', () => {
    expect(committeeSystemPrompt('elected', 'backend')).toMatch(/not a rubber stamp/i);
    expect(committeeSystemPrompt('sortition', 'backend')).toMatch(/flag things that/i);
  });
});

/**
 * recover() records required changes and leaves the motion exactly as tabled. The recommittal text
 * used to tell the committee it was reading a "revised motion", so it looked for an amendment that
 * was never made, found the original drafting intact, and refused on that ground on every attempt.
 * A real run lost `composition` and `nuclear-data` to this: three rejections apiece, each citing
 * the same unamendable wording, while the implementation was being repaired underneath it.
 */
describe('recommittal framing', () => {
  const directive = {
    requiredChanges: ['fix the atomic-fraction reference value'],
    attemptNumber: 2,
    maxAttempts: 3,
    repeated: false,
    appealGranted: false,
  };

  it('does not tell the committee the motion was revised', () => {
    const prompt = committeeUserPrompt({
      motionTitle: 'T',
      motionDescription: 'D',
      acceptanceCriteria: [],
      targetGlobs: [],
      recommittal: directive,
    });

    expect(prompt).not.toMatch(/revised motion/i);
    expect(prompt).toMatch(/stands as tabled/i);
  });

  it('tells the committee why a carried motion was reopened, and that its files already existing is expected', () => {
    const prompt = committeeUserPrompt({
      motionTitle: 'T',
      motionDescription: 'D',
      acceptanceCriteria: [],
      targetGlobs: ['alloydamage/nuclear_data.py'],
      remediation: '1. [high] Required final check unit failed.\nEvidence:\nE   ValueError: missing nuclear data file',
    });

    expect(prompt).toContain('E   ValueError: missing nuclear data file');
    expect(prompt).toMatch(/reopened/i);
    expect(prompt).toMatch(/already exist/i);
  });

  it('tells the committee a drafting objection is not curable by an implementer', () => {
    const prompt = committeeUserPrompt({
      motionTitle: 'T',
      motionDescription: 'D',
      acceptanceCriteria: [],
      targetGlobs: [],
      recommittal: directive,
    });

    expect(prompt).toMatch(/cannot be cured by an implementer/i);
    expect(prompt).toContain('fix the atomic-fraction reference value');
  });

  it('shows a recommitted committee what the last attempt showed, and forbids refusing on the earlier refusal', () => {
    const prompt = committeeUserPrompt({
      motionTitle: 'T',
      motionDescription: 'D',
      acceptanceCriteria: [],
      targetGlobs: [],
      recommittal: { ...directive, lastAttempt: { checksPassed: true, oppositionVerdict: 'approve' as const } },
    });

    expect(prompt).toContain('required checks passed; the Opposition, which read the diff, approved it.');
    expect(prompt).toMatch(/earlier refusal, vote or objection is not itself a ground to refuse/);
  });

  it('keeps the attempt evidence off the implementer prompt', () => {
    const prompt = implementerUserPrompt({ goal: 'Build pkg.',
      motionTitle: 'T',
      motionDescription: 'D',
      acceptanceCriteria: [],
      targetGlobs: [],
      recommittal: { ...directive, lastAttempt: { checksPassed: false, oppositionVerdict: 'reject' as const } },
    });

    expect(prompt).not.toContain('What the last attempt showed');
  });

  it('tells the committee that the files a motion will create need not exist yet', () => {
    const prompt = committeeUserPrompt({
      motionTitle: 'Nuclear data loader',
      motionDescription: 'Add the loader.',
      acceptanceCriteria: [],
      targetGlobs: ['pkg/nuclear_data.py', 'tests/test_nuclear_data.py'],
    });

    expect(prompt).toContain('Files this motion will create or change: pkg/nuclear_data.py, tests/test_nuclear_data.py');
    expect(prompt).toMatch(/their absence is not a reason to refuse it/);
  });

  it('still requires the implementer to address every required change', () => {
    const prompt = implementerUserPrompt({ goal: 'Build pkg.',
      motionTitle: 'T',
      motionDescription: 'D',
      acceptanceCriteria: [],
      targetGlobs: [],
      recommittal: directive,
    });

    expect(prompt).toMatch(/concretely address every required change/i);
  });
});

describe('CLI entry point reminder', () => {
  it('reminds the implementer that __main__.py is required for a motion touching the CLI', () => {
    const prompt = implementerUserPrompt({ goal: 'Build pkg.',
      motionTitle: 'Command-line interface',
      motionDescription: 'Wire up python -m alloydamage.',
      acceptanceCriteria: [],
      targetGlobs: ['alloydamage/cli.py', 'alloydamage/__main__.py'],
    });

    expect(prompt).toContain('__main__.py');
  });

  it('does not add the CLI reminder to an unrelated motion', () => {
    const prompt = implementerUserPrompt({ goal: 'Build pkg.',
      motionTitle: 'Damage calculation',
      motionDescription: 'Implement interpolation.',
      acceptanceCriteria: [],
      targetGlobs: ['alloydamage/damage.py'],
    });

    expect(prompt).not.toContain('__main__.py');
  });
});

describe('extrapolation reminder', () => {
  it('reminds the implementer not to silently extrapolate on an interpolation/damage motion', () => {
    const prompt = implementerUserPrompt({ goal: 'Build pkg.',
      motionTitle: 'Damage calculation',
      motionDescription: 'Implement interpolation onto a common energy grid.',
      acceptanceCriteria: [],
      targetGlobs: ['alloydamage/damage.py'],
    });

    expect(prompt).toMatch(/extrapolat/i);
  });

  it('does not add the reminder to an unrelated motion', () => {
    const prompt = implementerUserPrompt({ goal: 'Build pkg.',
      motionTitle: 'Write the README',
      motionDescription: 'Document how to run the program.',
      acceptanceCriteria: [],
      targetGlobs: ['README.md'],
    });

    expect(prompt).not.toMatch(/extrapolat/i);
  });
});

describe('provenance key reminder', () => {
  it('reminds the implementer to parse the real key names on a provenance motion', () => {
    const prompt = implementerUserPrompt({ goal: 'Build pkg.',
      motionTitle: 'Nuclear data loader',
      motionDescription: 'Load and expose nuclear-data provenance.',
      acceptanceCriteria: [],
      targetGlobs: ['alloydamage/nuclear_data.py'],
    });

    expect(prompt).toMatch(/real input files/);
  });

  it('does not add the reminder to an unrelated motion', () => {
    const prompt = implementerUserPrompt({ goal: 'Build pkg.',
      motionTitle: 'Write the README',
      motionDescription: 'Document how to run the program.',
      acceptanceCriteria: [],
      targetGlobs: ['README.md'],
    });

    expect(prompt).not.toMatch(/real input files/);
  });
});

const ALLOY_GOAL =
  'Develop alloydamage that calculates neutron displacement-damage cross-section from IAEA Nuclear Data Section data.';
const ALLOY_CRITERIA = ['python -m pytest passes'];

// The benchmark's §14 forbids one arm receiving engineering guidance the others do not. These pin
// that a benchmark-shaped goal gets no more in any democratic prompt than the goal text itself.
describe('benchmark neutrality of democratic prompts', () => {
  const hints = /dpa-barn|Neutron energy \[MeV\]|DXS-2018|26Fe0|NRT-dpa|30 MeV|_log_interp|independent oracle/;

  it('adds nothing task-specific to any prompt for a benchmark-shaped goal', () => {
    const prompts = [
      plannerUserPrompt({ goal: 'add an isEven helper', acceptanceCriteria: ['isEven exists'], repoPath: '/tmp', baseBranch: 'main' }),
      implementerUserPrompt({ goal: 'Build pkg.', motionTitle: 'CLI', motionDescription: 'Wire the command.', acceptanceCriteria: ['CLI runs'], targetGlobs: ['pkg/cli.py'] }),
      oppositionUserPrompt('CLI', 'wired', [{ op: 'write', path: 'pkg/cli.py', content: 'print("hi")\n' }], ['CLI runs'], { ran: true, passed: true }),
      integrationCommitteeUserPrompt('add an isEven helper', ALLOY_CRITERIA, ['CLI'], 'diff'),
      commonsVerifierUserPrompt('add an isEven helper', ALLOY_CRITERIA, [], 'unit passed', 'diff'),
      houseOfReviewUserPrompt('add an isEven helper', ALLOY_CRITERIA, 'unit passed', [], 'diff'),
      oppositionSystemPrompt('backend'),
      houseOfReviewSystemPrompt(),
      commonsVerifierSystemPrompt(),
    ];
    for (const prompt of prompts) expect(prompt).not.toMatch(hints);

    const planner = plannerUserPrompt({ goal: ALLOY_GOAL, acceptanceCriteria: ALLOY_CRITERIA, repoPath: '/tmp', baseBranch: 'main' });
    expect(planner.replace(ALLOY_GOAL, '')).not.toMatch(/alloydamage|dpa-barn|MeV|IAEA/);
  });

  it('keeps the parliamentary register compact in the second chamber', () => {
    const nested = houseOfReviewUserPrompt(
      ALLOY_GOAL,
      ALLOY_CRITERIA,
      'unit passed',
      [{
        id: 'f-ab12',
        source: 'engine:regression-rule',
        summary: `Finding 1 [high]: ${'historical nested prose '.repeat(30)}changed no test`,
        evidenceRefs: ['pkg/cli.py', 'remediation-origin:cli:f-00aa'],
      }],
      'diff',
    );
    expect(nested).toMatch(/Parliamentary register/);
    expect(nested).not.toContain('historical nested prose');
  });

  it('cites disposition findings from the parliamentary register rather than dumping nested packets', () => {
    const prompt = dispositionUserPrompt(
      [{
        id: 'f-ab12',
        source: 'engine:regression-rule',
        summary: `Remediation of "${'historical nested prose '.repeat(40)}" changed no test`,
        evidenceRefs: ['pkg/cli.py', 'remediation-origin:cli:f-00aa'],
      }],
      'diff',
    );
    expect(prompt).toMatch(/Parliamentary register/);
    expect(prompt).toContain('f-ab12');
    expect(prompt).not.toContain('historical nested prose');
  });

  it('does not import socialist, guild, council, or common-stock language into democratic prompts', () => {
    const prompts = [
      plannerUserPrompt({ goal: ALLOY_GOAL, acceptanceCriteria: ALLOY_CRITERIA, repoPath: '/tmp', baseBranch: 'main' }),
      oppositionSystemPrompt('backend'),
      houseOfReviewSystemPrompt(),
      commonsVerifierSystemPrompt(),
    ].join('\n');
    expect(prompts).not.toMatch(/\bguild\b/i);
    expect(prompts).not.toMatch(/\bcouncil\b/i);
    expect(prompts).not.toMatch(/common-stock/i);
    expect(prompts).not.toMatch(/socialist/i);
  });
});

// pytest prints its session header and source listing first and the `E   …` lines last, so a cut
// that keeps the head shows the reviewers a header with the error trimmed off.
describe('check output shown to the debate', () => {
  const error = 'E   ValueError: DATA_DIR at nuclear_data.py:36 points to the wrong directory';
  const test = { ran: true, passed: false, output: `${'tests/test_data.py::test_load PASSED\n'.repeat(60)}${error}` };

  it('shows the Opposition the end of a long check output', () => {
    const prompt = oppositionUserPrompt('Loader', 'adds it', [], [], test);
    expect(prompt).toContain(error);
  });

  it('shows the minister the end of a long check output', () => {
    const prompt = governmentReplyUserPrompt('Loader', 'adds it', 'flag', 'wrong directory', test, []);
    expect(prompt).toContain(error);
  });
});

describe('remediation directive for a reopened motion', () => {
  it('puts the remediation directive before the implementer', () => {
    const prompt = implementerUserPrompt({ goal: 'Build pkg.',
      motionTitle: 'T',
      motionDescription: 'D',
      acceptanceCriteria: [],
      targetGlobs: [],
      remediation: '1. [high] Required final check unit failed\nEvidence:\nE   AssertionError',
    });

    expect(prompt).toContain('E   AssertionError');
  });
});
