export type CapabilityTag = 'frontend' | 'backend' | 'test' | 'docs' | 'infra' | 'general';

export interface RosterMember {
  id: string;
  capabilities: CapabilityTag[];
}

export interface MemberLoad {
  inFlight: number;
  completed: number;
}

export const MANAGERIAL_ROSTER: readonly RosterMember[] = [
  { id: 'application-engineer', capabilities: ['frontend', 'backend', 'general'] },
  { id: 'quality-engineer', capabilities: ['test', 'backend', 'general'] },
  { id: 'platform-engineer', capabilities: ['infra', 'backend', 'general'] },
  { id: 'documentation-engineer', capabilities: ['docs', 'frontend', 'general'] },
];

const TEST_PATH = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/;
const DOCS_PATH = /(?:^|\/)(?:docs?|documentation)(?:\/|$)|(?:^|\/)(?:readme|changelog)(?:\.[^/]*)?$|\.(?:md|mdx|rst)$/;
const INFRA_PATH =
  /(?:^|\/)(?:\.github|infra|infrastructure|deploy|deployment|terraform|k8s|kubernetes|scripts)(?:\/|$)|(?:^|\/)(?:dockerfile|compose\.ya?ml)$|\.(?:tf|ya?ml|toml)$/;
const FRONTEND_PATH =
  /(?:^|\/)(?:client|frontend|components|pages|views|ui|styles)(?:\/|$)|\.(?:tsx|jsx|css|scss|sass|less|html)$/;
const BACKEND_PATH =
  /(?:^|\/)(?:server|backend|api|routes|controllers|services|database|db)(?:\/|$)|\.(?:ts|js|mjs|cjs|py|go|rs|java|kt|rb|php)$/;

/**
 * Classifies declared paths by recognizable repository conventions. More specific concerns are
 * checked before language extensions so, for example, `api/user.test.ts` is treated as test work.
 */
export function deriveDomainTag(targetGlobs: string[]): CapabilityTag {
  const normalized = targetGlobs.map((path) => path.replace(/\\/g, '/').toLowerCase());
  const matches = (pattern: RegExp): boolean => normalized.some((path) => pattern.test(path));

  if (matches(TEST_PATH)) return 'test';
  if (matches(DOCS_PATH)) return 'docs';
  if (matches(INFRA_PATH)) return 'infra';
  if (matches(FRONTEND_PATH)) return 'frontend';
  if (matches(BACKEND_PATH)) return 'backend';
  return 'general';
}

export function emptyMemberLoad(): MemberLoad {
  return { inFlight: 0, completed: 0 };
}

function totalLoad(member: RosterMember, loads: Record<string, MemberLoad>): number {
  const load = loads[member.id] ?? emptyMemberLoad();
  return load.inFlight + load.completed;
}

function capabilityScore(member: RosterMember, domain: CapabilityTag): number {
  if (member.capabilities.includes(domain)) return 2;
  if (member.capabilities.includes('general')) return 1;
  return 0;
}

export function selectAssignee(
  domain: CapabilityTag,
  loads: Record<string, MemberLoad>,
  excludedIds: ReadonlySet<string> = new Set(),
): RosterMember {
  const candidates = MANAGERIAL_ROSTER.filter((member) => !excludedIds.has(member.id));
  const available = candidates.length > 0 ? candidates : [...MANAGERIAL_ROSTER];

  return [...available].sort((left, right) => {
    const scoreDifference = capabilityScore(right, domain) - capabilityScore(left, domain);
    if (scoreDifference !== 0) return scoreDifference;
    return totalLoad(left, loads) - totalLoad(right, loads);
  })[0];
}

export function selectAlternativeAssignee(
  domain: CapabilityTag,
  currentAssigneeId: string,
  loads: Record<string, MemberLoad>,
): RosterMember | undefined {
  const capableAlternatives = MANAGERIAL_ROSTER.filter(
    (member) => member.id !== currentAssigneeId && member.capabilities.includes(domain),
  );
  if (capableAlternatives.length === 0) return undefined;

  return [...capableAlternatives].sort((left, right) => totalLoad(left, loads) - totalLoad(right, loads))[0];
}
