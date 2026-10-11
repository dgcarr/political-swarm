import { describe, expect, it } from 'vitest';
import {
  councilsToSend,
  delegatePersonaFor,
  distinctiveWords,
  pathsNamedIn,
  planTextOf,
  renderPublishedFindings,
  surveyRepository,
  unaddressedRisks,
  type CouncilFindings,
} from './reconnaissance.js';
import type { SocialistConfig } from './types.js';
import type { TaskSpec } from '../../engine/types.js';

const cfg = {
  guilds: ['frontend', 'backend', 'testing', 'security', 'docs', 'architecture'],
  initialCapabilityScore: 0.5,
  recall: { consecutivePlannerFailuresBeforeSwap: 3 },
  escalateToHuman: { securityPathGlobs: [] },
} as unknown as SocialistConfig;

const task = (over: Partial<TaskSpec> = {}): TaskSpec => ({
  goal: 'Add a login form and the API endpoint behind it',
  acceptanceCriteria: ['A user can log in'],
  repoPath: '/repo',
  baseBranch: 'main',
  ...over,
});

const findings = (over: Partial<CouncilFindings> = {}): CouncilFindings => ({
  council: 'security',
  personaId: 'security-delegate',
  scopes: ['the session cookie'],
  risks: [],
  dependencies: [],
  proposedCriteria: [],
  ...over,
});

describe('which councils go out', () => {
  it('sends the disciplines the goal actually touches', () => {
    expect(councilsToSend(task(), cfg)).toEqual(['frontend', 'backend']);
  });

  // Section 14: universal deliberation may consume more effort than the implementation.
  it('time-boxes to the configured number of councils', () => {
    const wide = task({ goal: 'Rework the frontend, the backend API, the security model, the tests and the docs' });
    expect(councilsToSend(wide, cfg)).toHaveLength(2);
    expect(councilsToSend(wide, { ...cfg, reconnaissance: { ...cfg.reconnaissance, maxCouncils: 4 } })).toHaveLength(4);
  });

  it('can be switched off entirely', () => {
    expect(councilsToSend(task(), { ...cfg, reconnaissance: { ...cfg.reconnaissance, maxCouncils: 0 } })).toEqual([]);
  });

  // Ordered by the roster, so the time-box cuts the same councils every time rather than whichever
  // regex happened to match first.
  it('cuts deterministically, in roster order', () => {
    const reordered = { ...cfg, guilds: ['backend', 'frontend', 'testing', 'security', 'docs', 'architecture'] };
    expect(councilsToSend(task(), cfg)).toEqual(['frontend', 'backend']);
    expect(councilsToSend(task(), reordered)).toEqual(['backend', 'frontend']);
  });

  it('still sends someone when the goal names a discipline the roster omits', () => {
    const narrow = { ...cfg, guilds: ['docs'] };
    expect(councilsToSend(task({ goal: 'Fix the backend route' }), narrow)).toEqual(['backend']);
  });

  it('routes by the paths the task names, not only its prose', () => {
    expect(pathsNamedIn('Update src/auth/session.ts and client/App.tsx')).toEqual([
      'src/auth/session.ts',
      'client/App.tsx',
    ]);
    expect(councilsToSend(task({ goal: 'Update src/auth/session.ts' }), cfg)).toContain('security');
  });

  it('names each council\'s delegate predictably', () => {
    expect(delegatePersonaFor('security')).toBe('security-delegate');
  });
});

describe('the councils\' right to challenge the plan', () => {
  const planned = planTextOf([
    { title: 'Add the login form', description: 'A React component posting to the API', targetGlobs: ['client/Login.tsx'] },
  ]);

  it('is silent when the plan engages what a council named', () => {
    const report = findings({ risks: ['The login form must not submit twice'] });
    expect(unaddressedRisks([report], planned)).toEqual([]);
  });

  // Deliberately set at *no* overlap: a plan engaging a risk in different words is engaging it, and
  // a stricter test would bury the real signal under quibbles about phrasing.
  it('leaves a partially-covered risk alone', () => {
    const report = findings({ risks: ['The login form needs rate limiting against credential stuffing'] });
    expect(unaddressedRisks([report], planned)).toEqual([]);
  });

  it('challenges a risk the plan says nothing whatever about', () => {
    const report = findings({ risks: ['Rotating the signing secret invalidates every issued token'] });
    expect(unaddressedRisks([report], planned)).toEqual([
      { council: 'security', challenge: 'Rotating the signing secret invalidates every issued token' },
    ]);
  });

  // "Risks: none" makes no claim, so there is nothing to have ignored.
  it('does not treat a contentless risk as a challenge', () => {
    expect(unaddressedRisks([findings({ risks: ['none', 'N/A', ''] })], planned)).toEqual([]);
  });

  it('drops filler when deciding what a risk is about', () => {
    expect(distinctiveWords('There will be a risk that these changes break the session')).toEqual(['break', 'session']);
  });
});

describe('the survey handed to every council', () => {
  const worktree = (files: Record<string, string>) => ({
    readFileIfExists: (p: string) => files[p] ?? null,
  });

  it('reads the instructions and manifests section 9 sends workers to', () => {
    const survey = surveyRepository(worktree({ 'README.md': 'A scratch repo', 'package.json': '{"name":"x"}' }));
    expect(survey).toContain('### README.md');
    expect(survey).toContain('### package.json');
  });

  it('truncates a long file rather than flooding every delegate\'s context', () => {
    const survey = surveyRepository(worktree({ 'README.md': 'x'.repeat(5_000) }));
    expect(survey).toContain('(truncated)');
    expect(survey.length).toBeLessThan(2_000);
  });

  // Section 9: share baseline failures "so no worker unknowingly duplicates or conceals them".
  it('names what already fails, so no council plans work nobody asked for', () => {
    const survey = surveyRepository(worktree({}), [
      { categoryId: 'lint', command: 'npm', args: ['run', 'lint'], ran: true, passed: false },
      { categoryId: 'unit', command: 'npm', args: ['test'], ran: true, passed: true },
      { categoryId: 'types', command: 'tsc', args: [], ran: false, passed: false, skippedReason: 'no tsconfig' },
    ]);
    expect(survey).toContain('lint');
    expect(survey).not.toContain('unit,');
    expect(survey).toContain('types (no tsconfig)');
  });

  it('survives a file it cannot read', () => {
    const hostile = {
      readFileIfExists: (p: string) => {
        if (p === 'README.md') throw new Error('EACCES');
        return p === 'package.json' ? '{}' : null;
      },
    };
    expect(surveyRepository(hostile)).toContain('### package.json');
  });

  it('returns an empty survey rather than throwing on a bare repository', () => {
    expect(surveyRepository(worktree({}))).toBe('');
  });
});

describe('what the planner is given to synthesise', () => {
  it('renders only the sections a council actually filled in', () => {
    const rendered = renderPublishedFindings([findings({ risks: ['Token rotation'], scopes: [] })]);
    expect(rendered).toContain('Published by the security council');
    expect(rendered).toContain('Risks it names: Token rotation');
    expect(rendered).not.toContain('Scope it proposes');
  });

  it('is empty when no council reported, so the prompt says nothing rather than nothing-shaped', () => {
    expect(renderPublishedFindings([])).toBe('');
  });
});
