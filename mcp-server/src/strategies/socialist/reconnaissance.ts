// Section 7, stage 2: "Affected councils inspect the repository and foundational evidence in
// parallel, then publish findings to the commons. Workers propose scopes, risks, dependencies and
// acceptance tests. The coordinating council synthesises — not privately invents — a collective
// plan, and affected councils may amend or challenge it."
//
// The word doing the work there is *synthesises*. A single planner call producing a plan out of its
// own head is exactly the private invention the sentence rules out, however good the plan is. So
// the councils go out first, in parallel, and publish; the planner is then given what they found
// and asked to synthesise over it.
//
// Two limits keep that from becoming section 14's "endless assembly", where "universal deliberation
// may consume more effort than implementation". Reconnaissance is time-boxed to a configured number
// of councils, and it happens once — there is no second round.
//
// And because a planner can be told to synthesise and simply not, the guarantee is not the
// instruction. It is unaddressedRisks(): a deterministic comparison of what the councils published
// against what the plan contains, so a report that was ignored is recorded as a challenge rather
// than quietly lost. Article 9: councils "may challenge plans, evidence and coordinators".

import type { CheckRunRecord } from '../../engine/packets.js';
import type { RepoWorktree } from '../../engine/RepoWorktree.js';
import type { TaskSpec } from '../../engine/types.js';
import { guildRoster, inferGuilds } from './guilds.js';
import type { SocialistConfig } from './types.js';
import { SOCIALIST_DEFAULTS } from '../../constitution/schema.js';

export interface CouncilFindings {
  /** The discipline this council answers for. */
  council: string;
  personaId: string;
  scopes: string[];
  risks: string[];
  dependencies: string[];
  proposedCriteria: string[];
}

export const DEFAULT_MAX_COUNCILS = SOCIALIST_DEFAULTS.reconnaissance.maxCouncils;

const PATH_LIKE = /[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+\.[a-zA-Z0-9]+/g;

/** Concrete file paths named in the goal, so reconnaissance is routed by what the task actually names. */
export function pathsNamedIn(text: string): string[] {
  return [...new Set(text.match(PATH_LIKE) ?? [])];
}

/**
 * Which councils go out, deterministically.
 *
 * No plan exists yet, so there are no units of production to form councils around — reconnaissance
 * is therefore organised by discipline, which is the only division of the swarm that exists before
 * the work is known. Worker councils form per unit once the plan lands (councils.ts).
 *
 * Ordered by the configured guild roster rather than by inference order, so the time-box cuts the
 * same councils on the same goal every time instead of whichever the regexes happened to match
 * first.
 */
export function councilsToSend(task: TaskSpec, cfg: SocialistConfig): string[] {
  const max = cfg.reconnaissance?.maxCouncils ?? DEFAULT_MAX_COUNCILS;
  if (max <= 0) return [];

  const criteria = (task.acceptanceCriteria ?? []).join(' ');
  const touched = new Set(
    inferGuilds({ title: task.goal ?? '', description: criteria, targetGlobs: pathsNamedIn(`${task.goal ?? ''} ${criteria}`) }),
  );
  const ordered = guildRoster(cfg).filter((g) => touched.has(g));
  // inferGuilds always returns something, but it may name a discipline the roster omits; sending
  // nobody would silently disable the stage rather than time-box it.
  const pool = ordered.length > 0 ? ordered : [...touched];
  return pool.slice(0, max);
}

export function delegatePersonaFor(council: string): string {
  return `${council}-delegate`;
}

// ------------------------------------------------- the councils' right to challenge

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'with', 'without', 'from', 'into', 'that', 'this',
  'these', 'those', 'will', 'may', 'must', 'should', 'could', 'have', 'has', 'been', 'being',
  'there', 'their', 'them', 'they', 'when', 'where', 'which', 'while', 'about', 'over', 'under',
  'risk', 'risks', 'change', 'changes', 'code', 'work', 'task', 'need', 'needs',
  // Ways of saying nothing. A council answering "none" has made no claim, and treating that as a
  // risk the plan ignored would put a spurious deferred finding into the delivery packet.
  'none', 'nothing', 'unknown', 'unclear', 'unsure',
]);

/** Distinctive words of a sentence — the ones a plan would have to mention to be about it. */
export function distinctiveWords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3 && !STOP_WORDS.has(w)),
    ),
  ];
}

export interface PlanChallenge {
  council: string;
  challenge: string;
}

/**
 * Risks a council published that the synthesised plan says nothing about.
 *
 * Deliberately set at *nothing*: a risk is unaddressed only when none of its distinctive words
 * appear anywhere in the plan. Partial coverage is left alone, because a plan that engages a risk
 * in different words is engaging it, and a stricter test would bury the real signal — a whole
 * council's report ignored — under quibbles about phrasing. A risk with no distinctive words at all
 * ("Risks: none") makes no claim and is not a challenge.
 */
export function unaddressedRisks(findings: readonly CouncilFindings[], planText: string): PlanChallenge[] {
  const haystack = planText.toLowerCase();
  const challenges: PlanChallenge[] = [];

  for (const report of findings) {
    for (const risk of report.risks) {
      const words = distinctiveWords(risk);
      if (words.length === 0) continue;
      if (!words.some((w) => haystack.includes(w))) {
        challenges.push({ council: report.council, challenge: risk });
      }
    }
  }
  return challenges;
}

/** The plan as one searchable body of text, for the comparison above. */
export function planTextOf(nodes: readonly { title: string; description: string; targetGlobs: string[] }[]): string {
  return nodes.map((n) => `${n.title} ${n.description} ${n.targetGlobs.join(' ')}`).join('\n');
}

/** What the councils published, rendered for the planner to synthesise over. */
export function renderPublishedFindings(findings: readonly CouncilFindings[]): string {
  if (findings.length === 0) return '';
  return findings
    .map((f) => {
      const lines = [`## Published by the ${f.council} council (${f.personaId})`];
      if (f.scopes.length) lines.push(`Scope it proposes: ${f.scopes.join('; ')}`);
      if (f.risks.length) lines.push(`Risks it names: ${f.risks.join('; ')}`);
      if (f.dependencies.length) lines.push(`Dependencies it found: ${f.dependencies.join('; ')}`);
      if (f.proposedCriteria.length) lines.push(`Acceptance tests it proposes: ${f.proposedCriteria.join('; ')}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

// ------------------------------------------------------------- the survey

/**
 * Files section 9 sends workers to before they edit anything: "repository instructions, manifests,
 * CI configuration and test organisation". Read directly rather than dispatched for, because
 * reading a file is not a judgment and paying a model to do it would be paying for a `cat`.
 */
const SURVEY_FILES = [
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'package.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
];

const SURVEY_FILE_CHARS = 1_200;

/**
 * The shared starting picture every council goes out with.
 *
 * Article 2: the repository and its records are a commons, and no council may hold back what
 * another needs. Handing every delegate the same survey is that rule at the smallest scale — the
 * councils differ in what they *notice*, which is the point of sending several, not in what they
 * were allowed to see.
 *
 * Baseline failures are included deliberately. Section 9 requires the commons to "share baseline
 * failures so no worker unknowingly duplicates or conceals them", and a council that mistakes a
 * pre-existing failure for one it must fix will plan work nobody asked for.
 */
export function surveyRepository(worktree: Pick<RepoWorktree, 'readFileIfExists'>, baseline: readonly CheckRunRecord[] = []): string {
  const sections: string[] = [];

  for (const name of SURVEY_FILES) {
    let body: string | null = null;
    try {
      body = worktree.readFileIfExists(name);
    } catch {
      // An unreadable file is not a reason to abandon the survey; the rest still informs the councils.
      body = null;
    }
    if (!body) continue;
    const trimmed = body.length > SURVEY_FILE_CHARS ? `${body.slice(0, SURVEY_FILE_CHARS)}\n… (truncated)` : body;
    sections.push(`### ${name}\n${trimmed}`);
  }

  const failing = baseline.filter((b) => b.ran && !b.passed).map((b) => b.categoryId);
  const skipped = baseline.filter((b) => !b.ran).map((b) => `${b.categoryId} (${b.skippedReason ?? 'no reason recorded'})`);
  if (failing.length > 0) {
    sections.push(`### Already failing before any of this work\n${failing.join(', ')} — these are not yours to fix unless the task says so.`);
  }
  if (skipped.length > 0) {
    sections.push(`### Checks unavailable in this repository\n${skipped.join(', ')}`);
  }

  return sections.join('\n\n');
}
