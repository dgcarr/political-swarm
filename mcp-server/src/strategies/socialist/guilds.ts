// Section 6's specialist guilds: "federations of workers who share a discipline such as
// architecture, security, testing, accessibility, documentation, data or operations."
//
// A guild is not a worker council. Councils are units of *production*, organised around a module,
// service, feature or bounded user outcome, and they own the work (councils.ts). Guilds cut across
// them by *discipline*: they maintain standards, advise, nominate qualified specialists for
// high-risk work, and rotate their members back through implementation so expertise stays connected
// to production. "A guild has advisory and review authority within its charter, not permanent
// ownership of a domain."
//
// The routing rules below moved here unchanged from SocialistStrategy: they were always answering
// the question "which disciplines does this work touch", which is a guild question.

import type { TaskNode } from '../../engine/types.js';
import type { SocialistConfig } from './types.js';
import { SOCIALIST_DEFAULTS } from '../../constitution/schema.js';

export const DEFAULT_MEMBERS_PER_GUILD = SOCIALIST_DEFAULTS.councils.membersPerGuild;

/** Deterministic guild membership: e.g. "frontend" -> ["frontend-1", "frontend-2"]. No model call. */
export function guildMembers(guild: string, membersPerGuild = DEFAULT_MEMBERS_PER_GUILD): string[] {
  const size = Number.isFinite(membersPerGuild) && membersPerGuild > 0 ? Math.floor(membersPerGuild) : DEFAULT_MEMBERS_PER_GUILD;
  return Array.from({ length: size }, (_, i) => `${guild}-${i + 1}`);
}

// ---- Guild inference (deterministic, no model call) ----
//
// "Domain" guilds (frontend/backend/security/architecture) represent structurally distinct
// modules — touching two of them is a genuine cross-council dependency that needs coordination.
// "Auxiliary" guilds (testing/docs) are recorded for knowledge-store tagging and reviewer
// selection, but do NOT by themselves force cross-council arbitration: a task that adds a function
// plus its unit test is still "one council's work with a test attached", not two councils colliding
// over the same module. This mirrors article 6's subsidiarity — tests and docs aren't a separate
// production unit in that sense.
const DOMAIN_GUILDS = new Set(['frontend', 'backend', 'security', 'architecture']);

const PATH_RULES: { guild: string; test: (p: string) => boolean }[] = [
  { guild: 'testing', test: (p) => /(^|[/\\])(test|tests|spec|specs|__tests__)([/\\]|$)/i.test(p) || /\.(test|spec)\.[jt]sx?$/i.test(p) },
  { guild: 'security', test: (p) => /(^|[/\\])(auth|security)([/\\]|$)/i.test(p) || /secret|credential/i.test(p) },
  { guild: 'docs', test: (p) => /(^|[/\\])docs?([/\\]|$)/i.test(p) || /\.md$/i.test(p) },
  {
    guild: 'frontend',
    test: (p) => /(^|[/\\])(frontend|client|ui|components?|pages|views)([/\\]|$)/i.test(p) || /\.(tsx|jsx|css|scss|html|vue)$/i.test(p),
  },
  {
    guild: 'backend',
    test: (p) => /(^|[/\\])(backend|server|api|routes?|controllers?|services?|models?)([/\\]|$)/i.test(p) || /\.(py|go|java)$/i.test(p),
  },
];

const KEYWORD_RULES: { guild: string; re: RegExp }[] = [
  { guild: 'testing', re: /\b(unit test|test suite|test case|jest|vitest|mocha)\b/i },
  { guild: 'security', re: /\b(auth\w*|security|permission|credential|secret|vulnerab\w*)\b/i },
  { guild: 'docs', re: /\b(documentation|readme|docs?)\b/i },
  { guild: 'frontend', re: /\b(frontend|front-end|ui|form|component|page|button|css|react|view)\b/i },
  { guild: 'backend', re: /\b(backend|back-end|\bapi\b|endpoint|server|route|database|\bdb\b)\b/i },
];

/** Every guild whose domain a node touches, from its target paths and title/description text. */
export function inferGuilds(node: { title: string; description: string; targetGlobs: string[] }): string[] {
  const guilds = new Set<string>();
  for (const p of node.targetGlobs) {
    for (const rule of PATH_RULES) if (rule.test(p)) guilds.add(rule.guild);
  }
  const text = `${node.title} ${node.description}`;
  for (const rule of KEYWORD_RULES) if (rule.re.test(text)) guilds.add(rule.guild);
  if (guilds.size === 0) {
    guilds.add(node.targetGlobs.length > 3 ? 'architecture' : 'backend');
  }
  return [...guilds];
}

/** The subset of a node's guilds that count toward the single-vs-cross-council decision. */
export function primaryGuilds(allGuilds: string[]): string[] {
  const domain = allGuilds.filter((g) => DOMAIN_GUILDS.has(g));
  return domain.length > 0 ? domain : allGuilds;
}

export function titleKeywords(title: string): string[] {
  const stop = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'or', 'for', 'with', 'in', 'on', 'add', 'create', 'implement', 'build']);
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !stop.has(w));
}

// ------------------------------------------------------- the guilds' own role

/**
 * Section 6: guilds "nominate qualified specialists for high-risk work".
 *
 * Deterministic, and deliberately narrow. The nomination names a *discipline*, not a person — which
 * guild's standards the work has to answer to — because a guild that could name the individual
 * reviewer for every high-risk change would hold exactly the unchallengeable ownership of a domain
 * the same paragraph denies it. Returns null on ordinary work, where any peer outside the
 * authorship chain will do.
 */
export function nominatingGuild(node: Pick<TaskNode, 'riskClass'>, nodeGuilds: readonly string[]): string | null {
  if (node.riskClass !== 'high') return null;
  // Risk ordering, not alphabetical: a high-risk node touching auth is the security guild's
  // business even when it also touches the frontend.
  for (const guild of ['security', 'architecture', 'backend', 'frontend', 'testing', 'docs']) {
    if (nodeGuilds.includes(guild)) return guild;
  }
  return nodeGuilds[0] ?? null;
}

/**
 * Section 6: guilds "rotate members through practical implementation so expertise remains connected
 * to production", and section 9 adds that "independence for a change must never create a permanent
 * QA caste".
 *
 * Checked rather than trusted: any persona that only ever reviewed in this run is named. The caller
 * discloses it — nothing here blocks a delivery, because a short run can end with a reviewer that
 * legitimately never got an implementation turn.
 */
export function unrotatedReviewers(implementers: readonly string[], reviewers: readonly string[]): string[] {
  const implemented = new Set(implementers);
  return [...new Set(reviewers)].filter((r) => !implemented.has(r));
}

/** The configured guild roster, with the doctrine's default when the config is silent. */
export function guildRoster(cfg: SocialistConfig): string[] {
  return cfg.guilds?.length ? cfg.guilds : [...SOCIALIST_DEFAULTS.guilds];
}
