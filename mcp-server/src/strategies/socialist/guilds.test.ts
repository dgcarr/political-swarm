import { describe, expect, it } from 'vitest';
import { guildMembers, guildRoster, inferGuilds, nominatingGuild, primaryGuilds, titleKeywords, unrotatedReviewers } from './guilds.js';
import type { SocialistConfig } from './types.js';

const node = (over: Partial<{ title: string; description: string; targetGlobs: string[] }> = {}) => ({
  title: 'Add a helper',
  description: 'A small change.',
  targetGlobs: ['src/helper.ts'],
  ...over,
});

describe('guild membership', () => {
  it('is deterministic and needs no model call', () => {
    expect(guildMembers('frontend')).toEqual(['frontend-1', 'frontend-2']);
    expect(guildMembers('frontend')).toEqual(guildMembers('frontend'));
  });

  it('honours a configured guild size', () => {
    expect(guildMembers('backend', 3)).toEqual(['backend-1', 'backend-2', 'backend-3']);
  });

  it('falls back to the default rather than producing an empty guild', () => {
    expect(guildMembers('backend', 0)).toEqual(['backend-1', 'backend-2']);
    expect(guildMembers('backend', Number.NaN)).toEqual(['backend-1', 'backend-2']);
  });

  it('supplies the doctrine roster when the config is silent', () => {
    expect(guildRoster({ guilds: [] } as unknown as SocialistConfig)).toContain('security');
    expect(guildRoster({ guilds: ['data'] } as unknown as SocialistConfig)).toEqual(['data']);
  });
});

describe('which disciplines a work unit touches', () => {
  it('reads paths', () => {
    expect(inferGuilds(node({ targetGlobs: ['src/auth/session.ts'] }))).toContain('security');
    expect(inferGuilds(node({ targetGlobs: ['tests/thing.test.ts'] }))).toContain('testing');
    expect(inferGuilds(node({ targetGlobs: ['client/components/Form.tsx'] }))).toContain('frontend');
  });

  it('reads the title and description too', () => {
    expect(inferGuilds(node({ title: 'Update the README for the API endpoint' }))).toEqual(expect.arrayContaining(['docs', 'backend']));
  });

  it('never returns nothing — unattributed work still has an owner', () => {
    expect(inferGuilds(node({ title: 'x', description: 'y', targetGlobs: ['a.txt'] }))).toEqual(['backend']);
    expect(inferGuilds(node({ title: 'x', description: 'y', targetGlobs: ['a', 'b', 'c', 'd'] }))).toEqual(['architecture']);
  });
});

describe('the single-vs-cross-council decision', () => {
  // A function plus its unit test is one council's work with a test attached, not two councils
  // colliding over the same module — article 6 keeps that decision local.
  it('does not let an auxiliary discipline manufacture a cross-council dependency', () => {
    expect(primaryGuilds(['backend', 'testing'])).toEqual(['backend']);
    expect(primaryGuilds(['backend', 'docs', 'testing'])).toEqual(['backend']);
  });

  it('reports a genuine collision between production domains', () => {
    expect(primaryGuilds(['frontend', 'backend'])).toEqual(['frontend', 'backend']);
  });

  it('falls back to what it has when no domain guild is involved', () => {
    expect(primaryGuilds(['testing', 'docs'])).toEqual(['testing', 'docs']);
  });
});

describe('nominating a guild for high-risk work', () => {
  // Section 6 gives guilds the power to nominate for high-risk work — and only that. Ordinary work
  // needs any peer outside the authorship chain, not a specialist.
  it('nominates nobody on ordinary work', () => {
    expect(nominatingGuild({ riskClass: 'low' }, ['security'])).toBeNull();
    expect(nominatingGuild({ riskClass: 'medium' }, ['security'])).toBeNull();
  });

  it('nominates by risk, not by the order the disciplines happened to be inferred in', () => {
    expect(nominatingGuild({ riskClass: 'high' }, ['frontend', 'security'])).toBe('security');
    expect(nominatingGuild({ riskClass: 'high' }, ['frontend', 'architecture'])).toBe('architecture');
  });

  it('nominates a discipline rather than a person, so no guild owns a domain', () => {
    const nominated = nominatingGuild({ riskClass: 'high' }, ['security']);
    expect(nominated).toBe('security');
    expect(guildMembers(nominated!)).toHaveLength(2);
  });

  it('has nothing to nominate when the work touches no discipline at all', () => {
    expect(nominatingGuild({ riskClass: 'high' }, [])).toBeNull();
  });
});

describe('rotation back through implementation', () => {
  it('is content when every reviewer also produced work', () => {
    expect(unrotatedReviewers(['backend-1', 'frontend-2'], ['frontend-2'])).toEqual([]);
  });

  // Section 9: "independence for a change must never create a permanent QA caste."
  it('names a persona that only ever reviewed', () => {
    expect(unrotatedReviewers(['backend-1'], ['frontend-2', 'frontend-2', 'backend-1'])).toEqual(['frontend-2']);
  });
});

describe('titleKeywords', () => {
  it('drops filler so a lesson query keys off the substance', () => {
    expect(titleKeywords('Add the login form to the page')).toEqual(['login', 'form', 'page']);
  });
});
