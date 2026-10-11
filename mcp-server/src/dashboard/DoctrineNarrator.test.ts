import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMON_TEMPLATES,
  SILENT_TYPES,
  TEMPLATES,
  knownTypes,
  narrate,
  templateFor,
  titleResolverFor,
  type Template,
} from './DoctrineNarrator.js';
import type { LedgerEntry } from '../engine/Ledger.js';
import type { StrategyId } from '../engine/types.js';

const STRATEGIES: StrategyId[] = ['democratic', 'socialist', 'capitalist', 'noop'];
const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Static extraction of what the engine actually records.
//
// This is the heart of the gate: rather than trusting a hand-maintained list, it parses the
// object literals passed to ledger.record() out of the real source at test time. If a call site
// drops or renames a field, a template that reads it fails here instead of rendering `undefined`
// into a live page.
// ---------------------------------------------------------------------------

/**
 * Payloads the literal parser cannot see through — a spread, or a whole object passed by
 * variable. Rather than hand-listing the keys (which would rot silently), each is resolved from
 * the interface that types the value at the call site, so renaming a field there fails the gate.
 */
const INDIRECT_PAYLOADS: Record<string, { file: string; interfaceName: string }> = {
  // ledger.record('approval_opened', { ...full }) where full is a PendingApproval.
  approval_opened: { file: 'engine/types.ts', interfaceName: 'PendingApproval' },
  // ledger.record('verification_result', { taskId, ...testResult }) where testResult is a TestResult.
  verification_result: { file: 'engine/types.ts', interfaceName: 'TestResult' },
  // ledger.record('question_time', summary) where summary is a QuestionTimeSummary.
  question_time: { file: 'strategies/democratic/types.ts', interfaceName: 'QuestionTimeSummary' },
  // ledger.record('finding_raised', { ...full }) where full is a Finding.
  finding_raised: { file: 'engine/packets.ts', interfaceName: 'Finding' },
  governance_decision: { file: 'engine/governance.ts', interfaceName: 'GovernanceDecision' },
  governance_mandate_granted: { file: 'engine/governance.ts', interfaceName: 'GovernanceMandate' },
};

/** Top-level property names of an exported interface. */
function interfaceFields(relPath: string, name: string): string[] {
  const src = readFileSync(path.join(srcRoot, relPath), 'utf8');
  const start = new RegExp(`export interface ${name}\\s*\\{`).exec(src);
  if (!start) throw new Error(`interface ${name} not found in ${relPath}`);
  const openIdx = start.index + start[0].length - 1;

  let depth = 0;
  let body = '';
  for (let i = openIdx; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        body = src.slice(openIdx + 1, i);
        break;
      }
    }
  }

  const fields: string[] = [];
  let depthInBody = 0;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\/\/[^\n]*/g, '').trim();
    if (!line || line.startsWith('*') || line.startsWith('/*')) continue;
    if (depthInBody === 0) {
      const m = /^([A-Za-z_$][\w$]*)\??\s*:/.exec(line);
      if (m) fields.push(m[1]);
    }
    depthInBody += (line.match(/[{[]/g) ?? []).length - (line.match(/[}\]]/g) ?? []).length;
  }
  return fields;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.includes('.test.')) out.push(p);
  }
  return out;
}

/** Top-level keys of the object literal whose opening brace is at openIdx. */
function topLevelKeys(src: string, openIdx: number): string[] {
  const segments: string[] = [];
  let depth = 0;
  let segStart = openIdx + 1;

  for (let i = openIdx; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{' || c === '[' || c === '(') depth += 1;
    else if (c === '}' || c === ']' || c === ')') {
      depth -= 1;
      if (depth === 0) {
        segments.push(src.slice(segStart, i));
        break;
      }
    } else if (c === ',' && depth === 1) {
      segments.push(src.slice(segStart, i));
      segStart = i + 1;
    }
  }

  const keys: string[] = [];
  for (const segment of segments) {
    // Strip line comments so a commented-out field is not mistaken for one.
    const s = segment.replace(/\/\/[^\n]*/g, '').trim();
    if (!s) continue;
    const explicit = /^([A-Za-z_$][\w$]*)\s*:/.exec(s);
    if (explicit) {
      keys.push(explicit[1]);
      continue;
    }
    const shorthand = /^([A-Za-z_$][\w$]*)$/.exec(s);
    if (shorthand) keys.push(shorthand[1]);
    // Spreads are handled by SPREAD_FIELDS; anything else is not a plain key.
  }
  return keys;
}

function emittedFields(): Map<string, Set<string>> {
  const files = walk(srcRoot).filter((f) => !f.includes(`${path.sep}dashboard${path.sep}`) && !f.includes(`${path.sep}smoke${path.sep}`));
  const found = new Map<string, Set<string>>();

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const re = /ledger\.record\(\s*'([a-z_]+)'\s*,\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const type = m[1];
      const braceIdx = m.index + m[0].length - 1;
      if (!found.has(type)) found.set(type, new Set());
      for (const key of topLevelKeys(src, braceIdx)) found.get(type)!.add(key);
    }
  }

  for (const [type, { file, interfaceName }] of Object.entries(INDIRECT_PAYLOADS)) {
    if (!found.has(type)) found.set(type, new Set());
    for (const key of interfaceFields(file, interfaceName)) found.get(type)!.add(key);
  }
  return found;
}

const EMITTED = emittedFields();

/** Every (strategy, type, template) triple the narrator can reach. */
function allTemplates(): { strategy: StrategyId; type: string; template: Template }[] {
  const out: { strategy: StrategyId; type: string; template: Template }[] = [];
  for (const [type, template] of Object.entries(COMMON_TEMPLATES)) {
    out.push({ strategy: 'noop', type, template });
  }
  for (const strategy of STRATEGIES) {
    for (const [type, template] of Object.entries(TEMPLATES[strategy])) {
      out.push({ strategy, type, template });
    }
  }
  return out;
}

describe('the emitter scan itself', () => {
  it('finds the engine call sites, so an empty scan cannot silently pass the gate', () => {
    expect(EMITTED.size).toBeGreaterThan(25);
    expect([...(EMITTED.get('worker_call') ?? [])].sort()).toEqual([
      'attempt',
      'completionTokens',
      'costMetered',
      'costUsd',
      'durationMs',
      'fallbackIndex',
      'model',
      'networkRetries',
      'personaId',
      'phase',
      'promptDigest',
      'promptTokens',
      'responseDigest',
      'role',
      'timedOut',
      'toolRound',
    ]);
    expect(EMITTED.get('task_decided')).toContain('outcome');
  });

  it('resolves indirect payloads from their interfaces, not a hand-written list', () => {
    // question_time records a whole QuestionTimeSummary by variable; verification_result spreads
    // a TestResult. Neither is visible to the literal parser.
    expect(interfaceFields('strategies/democratic/types.ts', 'QuestionTimeSummary')).toContain('asOfCompletedTasks');
    expect(EMITTED.get('question_time')).toContain('whatChanged');
    expect(EMITTED.get('verification_result')).toContain('passed');
    expect(EMITTED.get('approval_opened')).toContain('description');
  });
});

describe('gate: no template reads a field its call site does not set', () => {
  for (const { strategy, type, template } of allTemplates()) {
    it(`${strategy}/${type} declares only emitted fields`, () => {
      const emitted = EMITTED.get(type);
      expect(emitted, `no ledger.record('${type}', {...}) found in source`).toBeDefined();

      const missing = template.fields.filter((f) => !emitted!.has(f));
      expect(missing, `${strategy}/${type} declares fields the engine never sets: ${missing.join(', ')}`).toEqual([]);
    });
  }
});

describe('gate: render() touches nothing it did not declare', () => {
  // A template could declare the right fields and still read an undeclared one. A recording
  // proxy closes that gap, giving: accessed ⊆ declared ⊆ emitted.
  for (const { strategy, type, template } of allTemplates()) {
    it(`${strategy}/${type} reads only declared fields`, () => {
      const accessed = new Set<string>();

      // Several templates branch on a value, so one pass would only cover one arm. Running a
      // truthy and a falsy world reaches both.
      for (const truthy of [true, false]) {
        const target: Record<string, unknown> = {};
        for (const field of template.fields) {
          target[field] = truthy ? sampleValue(field) : falsySample(field);
        }
        const proxy = new Proxy(target, {
          get(t, prop: string | symbol) {
            if (typeof prop === 'string') accessed.add(prop);
            return t[prop as string];
          },
        });
        expect(() => template.render(proxy, (id) => String(id ?? ''))).not.toThrow();
      }

      const undeclared = [...accessed].filter((f) => !template.fields.includes(f));
      expect(undeclared, `${strategy}/${type} reads undeclared fields: ${undeclared.join(', ')}`).toEqual([]);
    });
  }
});

function sampleValue(field: string): unknown {
  if (/Count$|^count$|Tokens$|^before$|^after$|^delta$|^score$|^capital$|Score$|elapsedMin/.test(field)) return 3;
  if (/^costUsd$/.test(field)) return 0.1234;
  if (/s$/.test(field) && !/status|Class|address/.test(field)) return ['alpha', 'beta'];
  if (/^ran$|^passed$|^coordinated$|^test(Ran|Passed)$/.test(field)) return true;
  return `${field}-value`;
}

function falsySample(field: string): unknown {
  if (/^ran$|^passed$|^coordinated$|^test(Ran|Passed)$/.test(field)) return false;
  if (/s$/.test(field) && !/status|Class|address/.test(field)) return [];
  return sampleValue(field);
}

describe('narrate', () => {
  const entry = (type: string, data: Record<string, unknown> = {}): LedgerEntry => ({
    ts: '2026-01-01T00:00:00.000Z',
    runId: 'run-1',
    strategy: 'democratic',
    type,
    data,
  });

  it('produces a line for every known type under every strategy, with no undefined or NaN', () => {
    for (const strategy of STRATEGIES) {
      for (const type of knownTypes()) {
        const template = templateFor(strategy, type);
        const data: Record<string, unknown> = {};
        for (const field of template?.fields ?? []) data[field] = sampleValue(field);

        const line = narrate(strategy, entry(type, data));
        expect(line, `${strategy}/${type} produced no line`).not.toBeNull();
        expect(line!.text.length, `${strategy}/${type} produced an empty line`).toBeGreaterThan(0);
        expect(line!.text, `${strategy}/${type}`).not.toMatch(/undefined|NaN|\[object Object\]/);
      }
    }
  });

  it('stays silent on entries recorded for audit tidiness alone', () => {
    for (const type of SILENT_TYPES) {
      for (const strategy of STRATEGIES) {
        expect(narrate(strategy, entry(type, { taskId: 't1', paths: [] }))).toBeNull();
      }
    }
  });

  it('degrades an unmapped type to a plain statement rather than dropping it', () => {
    const line = narrate('democratic', entry('some_future_event', { taskId: 't1' }));
    expect(line).not.toBeNull();
    expect(line!.text).toBe('some future event recorded.');
    expect(line!.taskId).toBe('t1');
  });

  it('never throws, whatever it is handed', () => {
    const hostile = [
      entry('worker_call', {}),
      entry('vote_computed', { taskId: null, committeeApproveScore: 'not a number' }),
      entry('task_decided', { outcome: { nested: true } }),
      { ts: '', runId: '', type: 'plan_created', data: undefined } as unknown as LedgerEntry,
    ];
    for (const e of hostile) {
      for (const strategy of STRATEGIES) {
        expect(() => narrate(strategy, e)).not.toThrow();
      }
    }
  });

  it('speaks in each strategy\'s own register for the same event', () => {
    const decided = entry('task_decided', { taskId: 't1', outcome: 'approved' });
    const resolve = () => 'the drainage bill';

    expect(narrate('democratic', decided, resolve)!.text).toBe('The ayes have it. the drainage bill is carried.');
    expect(narrate('socialist', decided, resolve)!.text).toContain('common stock');
    expect(narrate('capitalist', decided, resolve)!.text).toContain('contract performed');

    // Three genuinely different sentences, not one sentence with the nouns swapped.
    const texts = new Set(
      (['democratic', 'socialist', 'capitalist'] as StrategyId[]).map((s) => narrate(s, decided, resolve)!.text),
    );
    expect(texts.size).toBe(3);
  });

  it('carries tone, taskId and actor for the ticker to key off', () => {
    const line = narrate('capitalist', entry('bankruptcy', { personaId: 'bidder-2', capital: -1.5 }));
    expect(line).toMatchObject({ tone: 'alarm', actor: 'bidder-2' });

    const routine = narrate('democratic', entry('worker_call', { role: 'planner', model: 'x', costUsd: 0.01 }));
    expect(routine).toMatchObject({ tone: 'routine', actor: 'planner' });
  });

  it('rejected and approved outcomes read differently in every strategy', () => {
    for (const strategy of ['democratic', 'socialist', 'capitalist'] as StrategyId[]) {
      const approved = narrate(strategy, entry('task_decided', { taskId: 't', outcome: 'approved' }))!.text;
      const rejected = narrate(strategy, entry('task_decided', { taskId: 't', outcome: 'rejected' }))!.text;
      expect(approved).not.toBe(rejected);
    }
  });
});

describe('empty optional fields', () => {
  // Real runs record plan_source with no model on the capitalist side and no source on the
  // socialist side, and work_executed with an empty riskClass. Naive interpolation produced
  // lines like "planner-1 (, glm-5.2, $0.0079)" and "( risk, $0.0436)" — cosmetic, but the sort
  // of thing that makes a live page look broken.
  const entry = (type: string, data: Record<string, unknown>): LedgerEntry => ({
    ts: '2026-01-01T00:00:00.000Z',
    runId: 'run-1',
    strategy: 'democratic',
    type,
    data,
  });

  const cases: [StrategyId, string, Record<string, unknown>][] = [
    ['capitalist', 'plan_source', { source: 'planner-llm', nodeCount: 3, plannerPersonaId: '', model: '', costUsd: 0 }],
    ['socialist', 'plan_source', { source: '', nodeCount: 6, plannerPersonaId: 'planner-1', model: 'glm', costUsd: 0.01 }],
    ['capitalist', 'work_executed', { taskId: 't1', personaId: 'bidder-3', assigneeId: '', fileOpCount: 5, riskClass: '', costUsd: 0.04 }],
    ['socialist', 'work_executed', { taskId: 't1', personaId: '', assigneeId: 'backend-1', fileOpCount: 2, guilds: [], riskClass: '', costUsd: 0 }],
    ['socialist', 'guilds_inferred', { taskId: 't1', guilds: [], primaryGuilds: [], riskClass: '', targetGlobs: [] }],
  ];

  for (const [strategy, type, data] of cases) {
    it(`${strategy}/${type} leaves no stray punctuation when optional fields are empty`, () => {
      const text = narrate(strategy, entry(type, data))!.text;
      expect(text, text).not.toMatch(/\(\s*,|,\s*\)|\(\s*\)|\s,|\s{2,}/);
      expect(text, text).not.toMatch(/undefined|NaN/);
    });
  }

  it('agrees subject and verb, and picks the right indefinite article', () => {
    expect(narrate('democratic', entry('plan_created', { nodeCount: 1 }))!.text).toContain('1 motion stands');
    expect(narrate('democratic', entry('plan_created', { nodeCount: 3 }))!.text).toContain('3 motions stand');
    expect(
      narrate('socialist', entry('capability_updated', { taskId: 't', assigneeId: 'a', guild: 'g', outcome: 'approved', before: 0.5, after: 0.55, delta: 0.05 }))!
        .text,
    ).toContain('on an approved outcome');
  });
});

describe('titleResolverFor', () => {
  const graph = { nodes: { t1: { title: 'Survey the culvert' } } };

  it('resolves a known task id to its title', () => {
    expect(titleResolverFor(graph)('t1')).toBe('Survey the culvert');
  });

  it('falls back to the raw id before a plan exists', () => {
    expect(titleResolverFor(null)('t1')).toBe('t1');
    expect(titleResolverFor(graph)('t-unknown')).toBe('t-unknown');
  });

  it('handles a missing task id without producing the word undefined', () => {
    expect(titleResolverFor(graph)(undefined)).toBe('an unnamed matter');
    expect(titleResolverFor(graph)(null)).toBe('an unnamed matter');
  });
});

describe('coverage of the real event vocabulary', () => {
  it('narrates every type the engine emits, or is deliberately silent about it', () => {
    const unhandled: string[] = [];
    for (const type of EMITTED.keys()) {
      if (SILENT_TYPES.has(type)) continue;
      const covered = STRATEGIES.some((s) => templateFor(s, type) !== undefined);
      if (!covered) unhandled.push(type);
    }
    expect(unhandled, `event types with no template: ${unhandled.join(', ')}`).toEqual([]);
  });
});
