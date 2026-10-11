import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { CatalogModel, OpenRouterClient } from '../engine/OpenRouterClient.js';
import {
  SpendLedger,
  HARD_SHAPE,
  benchTools,
  scoreElection,
  benchFailure,
  benchFile,
  canAffordNextCall,
  needsHardRun,
  isReusable,
  matchesInclude,
  planModelBudget,
  rankScores,
  renderMarkdown,
  scoreModel,
  scoreTools,
  selectCandidates,
  type CaseRecord,
  type ModelRecord,
} from './modelBench.js';
import {
  BENCH_CASES,
  ELECTION_CASES,
  ELECTION_SUITE_VERSION,
  HARD_CASES,
  HARD_SUITE_VERSION,
  MIN_TOOL_CALL_RATE,
  OPERATIONS_MODULE,
  STATS_PY,
  SUITE_VERSION,
  TOOL_CASES,
  TOOL_SUITE_VERSION,
  applyFileOps,
  detectSandbox,
  gradePlan,
  gradeTestRun,
  inventedRefs,
  pythonRunner,
  type PythonRunner,
} from './modelBenchCases.js';

const NOW = Date.parse('2026-09-30T00:00:00Z');
const DAY_S = 86_400;

function catalogModel(id: string, input: number, output: number, ageDays = 30): CatalogModel {
  return {
    id,
    name: id,
    contextLength: 128_000,
    inputPricePerMTok: input,
    outputPricePerMTok: output,
    supportsJsonMode: true,
    supportsToolCalls: true,
    createdAt: NOW / 1000 - ageDays * DAY_S,
  };
}

function benchCase(id: string) {
  const found = BENCH_CASES.find((c) => c.id === id);
  if (!found) throw new Error(`no case ${id}`);
  return found;
}

const PASS: CaseRecord = { ok: true, firstAttemptPass: true, attempts: 1, latencyMs: 1000, costUsd: 0.001 };

function record(id: string, overrides: Partial<Record<string, CaseRecord>>, price = 1): ModelRecord {
  const cases = Object.fromEntries(BENCH_CASES.map((c) => [c.id, overrides[c.id] ?? PASS]));
  return {
    id,
    suiteVersion: SUITE_VERSION,
    free: price === 0,
    inputPricePerMTok: price,
    outputPricePerMTok: price,
    createdAt: null,
    maxTokens: 4000,
    worstCaseUsd: 0.1,
    cases,
    costUsd: Object.values(cases).reduce((sum, c) => sum + c.costUsd, 0),
    testedAt: new Date(NOW).toISOString(),
  };
}

describe('selectCandidates', () => {
  it('puts free models first, then orders by price, and drops old, undated, router and batch ids', () => {
    const undated = { ...catalogModel('x/undated', 0.1, 0.1), createdAt: undefined };
    const { eligible, tooOld } = selectCandidates(
      [
        catalogModel('x/pricey', 5, 15),
        catalogModel('x/cheap', 0.1, 0.2),
        catalogModel('x/free:free', 0, 0),
        catalogModel('x/ancient', 0.01, 0.01, 400),
        catalogModel('openrouter/free', 0, 0),
        catalogModel('x/cheap:batch', 0.05, 0.1),
        undated,
      ],
      NOW,
      365,
    );
    expect(eligible.map((m) => m.id)).toEqual(['x/free:free', 'x/cheap', 'x/pricey']);
    expect(tooOld.map((m) => m.id).sort()).toEqual(['x/ancient', 'x/undated']);
  });

  it('matches --include globs against the whole id', () => {
    expect(matchesInclude('google/gemini-3.1-flash-lite', ['google/*'])).toBe(true);
    expect(matchesInclude('google/gemini-3.1-flash-lite', ['gemini'])).toBe(false);
    expect(matchesInclude('anything', [])).toBe(true);
  });
});

describe('benchFailure', () => {
  it('treats an upstream overload as transport, not as a schema failure of the model', () => {
    const err = new Error('OpenRouter returned an error for model x: Upstream error from Nvidia: ResourceExhausted');
    expect(benchFailure(err, false).kind).toBe('transport');
  });

  it('treats a 4xx refusal as unavailable, not as a transient fault to re-test', () => {
    const ageGate = new Error('OpenRouter 403 for model meta/muse-spark-1.1: requires 18+ age confirmation');
    expect(benchFailure(ageGate, false).kind).toBe('unavailable');
    expect(benchFailure(new Error('OpenRouter 429 for model x: rate limit'), false).kind).toBe('rate-limited');
    expect(benchFailure(new Error('OpenRouter 503 for model x: overloaded'), false).kind).toBe('transport');
  });

  it('calls an answer with no JSON in it unparseable', () => {
    expect(benchFailure(new Error('No parseable JSON: empty response after 4000 completion tokens'), false).kind).toBe('unparseable');
  });
});

describe('planModelBudget', () => {
  it('gives free models the full token ceiling at zero worst-case cost', () => {
    expect(planModelBudget({ inputPricePerMTok: 0, outputPricePerMTok: 0 }, 0.1)).toEqual({ maxTokens: 4000, worstCaseUsd: 0 });
  });

  it('keeps the worst case under the per-model cap by shrinking max_tokens', () => {
    const plan = planModelBudget({ inputPricePerMTok: 1, outputPricePerMTok: 3 }, 0.1)!;
    expect(plan.maxTokens).toBeLessThan(4000);
    expect(plan.maxTokens).toBeGreaterThanOrEqual(800);
    expect(plan.worstCaseUsd).toBeLessThanOrEqual(0.1);
  });

  it('skips a model that cannot run the suite in a useful number of tokens under the cap', () => {
    expect(planModelBudget({ inputPricePerMTok: 15, outputPricePerMTok: 75 }, 0.1)).toBeNull();
  });
});

describe('canAffordNextCall', () => {
  it('refuses a call the cap cannot cover at the dearest call price seen so far', () => {
    // grok-4.20-multi-agent's real figures: three calls, $0.0988 spent, the dearest $0.0511.
    expect(canAffordNextCall({ capUsd: 0.1, spentUsd: 0.0988, maxCallUsd: 0.0511 })).toBe(false);
    expect(canAffordNextCall({ capUsd: 0.1, spentUsd: 0.01, maxCallUsd: 0.002 })).toBe(true);
    expect(canAffordNextCall({ capUsd: 0.1, spentUsd: 0, maxCallUsd: 0 })).toBe(true);
  });
});

describe('SpendLedger', () => {
  it('refuses a reservation that would pass the cap, counting other in-flight reservations', () => {
    const ledger = new SpendLedger(5);
    expect(ledger.tryReserve(2)).toBe(true);
    expect(ledger.tryReserve(2)).toBe(true);
    expect(ledger.tryReserve(1.5)).toBe(false);
  });

  it('releases the unspent part of a reservation once the model settles', () => {
    const ledger = new SpendLedger(5);
    ledger.tryReserve(4);
    ledger.settle(4, 0.5);
    expect(ledger.spentUsd).toBe(0.5);
    expect(ledger.tryReserve(4.5)).toBe(true);
  });
});

describe('suite grading', () => {
  let runPython: PythonRunner;
  beforeAll(async () => {
    runPython = pythonRunner(await detectSandbox());
  });

  it('passes a correct parse_ranges implementation against the hidden tests', async () => {
    const content =
      'def parse_ranges(spec):\n' +
      '    out = set()\n' +
      '    if not spec.strip():\n        return []\n' +
      '    for item in spec.split(","):\n' +
      '        item = item.strip()\n' +
      '        if "-" in item:\n' +
      '            lo, hi = (int(p) for p in item.split("-"))\n' +
      '            if lo > hi:\n                raise ValueError(item)\n' +
      '            out.update(range(lo, hi + 1))\n' +
      '        else:\n            out.add(int(item))\n' +
      '    return sorted(out)\n';
    const grade = await benchCase('implement-write').grade({ fileOps: [{ op: 'write', path: 'ranges.py', content }], rationale: 'r' }, runPython);
    expect(grade).toEqual({ ok: true });
  });

  it('calls a stub body a hallucination, not a partial answer', async () => {
    const grade = await benchCase('implement-write').grade({ fileOps: [{ op: 'write', path: 'ranges.py', content: 'pass' }], rationale: 'r' }, runPython);
    expect(grade.kind).toBe('hallucination');
  });

  it('calls an import of a module that does not exist a hallucination', async () => {
    const content = 'from rangeparse import parse\n\ndef parse_ranges(spec):\n    return parse(spec)\n';
    const grade = await benchCase('implement-write').grade({ fileOps: [{ op: 'write', path: 'ranges.py', content }], rationale: 'r' }, runPython);
    expect(grade.kind).toBe('hallucination');
  });

  it('passes the minimal median fix applied as an exact edit', async () => {
    const fix = { op: 'edit', path: 'stats.py', find: 'ordered[mid] + ordered[mid + 1]', replace: 'ordered[mid - 1] + ordered[mid]' };
    expect(await benchCase('implement-edit').grade({ fileOps: [fix], rationale: 'r' }, runPython)).toEqual({ ok: true });
  });

  it('calls an edit whose find text is not in the file a hallucination', async () => {
    const fix = { op: 'edit', path: 'stats.py', find: 'return (ordered[mid] + ordered[mid+1]) / 2.0', replace: 'x' };
    expect((await benchCase('implement-edit').grade({ fileOps: [fix], rationale: 'r' }, runPython)).kind).toBe('hallucination');
  });

  it('marks a whole-file rewrite as wrong when an edit was asked for', async () => {
    const write = { op: 'write', path: 'stats.py', content: STATS_PY };
    expect((await benchCase('implement-edit').grade({ fileOps: [write], rationale: 'r' }, runPython)).kind).toBe('wrong');
  });

  it('requires the reviewer to reject the defective diff and to say why', async () => {
    const review = benchCase('review-defective');
    expect(await review.grade({ verdict: 'reject', rationale: 'range stops at len(items) - 1, so the last element is dropped' }, runPython)).toEqual({ ok: true });
    expect((await review.grade({ verdict: 'approve', rationale: 'tests pass' }, runPython)).kind).toBe('wrong');
    expect((await review.grade({ verdict: 'reject', rationale: 'needs docstrings' }, runPython)).kind).toBe('wrong');
  });

  it('calls a review citing a file that was never shown a hallucination', async () => {
    const grade = await benchCase('review-sound').grade({ verdict: 'approve', rationale: 'fine', evidenceRefs: ['src/chunker.py:4'] }, runPython);
    expect(grade.kind).toBe('hallucination');
    expect(inventedRefs(['chunks.py:4', 'tests/test_chunks.py::test_even_split'], ['chunks.py', 'tests/test_chunks.py'])).toEqual([]);
  });

  it('counts an abstention on a sound motion as wrong', async () => {
    const ballot = benchCase('ballot');
    expect(await ballot.grade({ verdict: 'approve', rationale: 'clear' }, runPython)).toEqual({ ok: true });
    expect((await ballot.grade({ verdict: 'abstain', rationale: 'unsure' }, runPython)).kind).toBe('wrong');
  });

  it('calls a plan that depends on undefined task ids a hallucination', () => {
    const task = (id: string, dependsOn: string[]) => ({ id, dependsOn, targetGlobs: ['a.py'] });
    expect(gradePlan({ tasks: [task('a', []), task('b', ['a']), task('c', ['b'])] })).toEqual({ ok: true });
    expect(gradePlan({ tasks: [task('a', []), task('b', ['a']), task('c', ['setup'])] }).kind).toBe('hallucination');
    expect(gradePlan({ tasks: [task('a', ['c']), task('b', ['a']), task('c', ['b'])] }).kind).toBe('wrong');
  });

  it('treats a missing own module as a wrong path rather than an invented dependency', () => {
    expect(gradeTestRun({ ok: false, output: "ModuleNotFoundError: No module named 'ranges'" }, ['ranges']).kind).toBe('wrong');
  });

  it('reports an ambiguous edit as wrong', () => {
    expect(applyFileOps({ 'a.py': 'x\nx\n' }, [{ op: 'edit', path: 'a.py', find: 'x', replace: 'y' }])).toMatchObject({ kind: 'wrong' });
  });
});

describe('scoring and ranking', () => {
  const failedImpl: CaseRecord = { ok: false, firstAttemptPass: false, failureKind: 'wrong', attempts: 2, latencyMs: 500, costUsd: 0.0001 };
  const stub: CaseRecord = { ...failedImpl, failureKind: 'hallucination' };

  it('ranks an expensive model that works above a cheap model that qualifies for nothing', () => {
    const cheapRubbish = record('cheap/rubbish', {
      'implement-write': failedImpl,
      'implement-edit': failedImpl,
      'review-defective': failedImpl,
      ballot: failedImpl,
      planner: failedImpl,
    }, 0.01);
    const pricey = record('pricey/good', {}, 10);
    const ranked = rankScores([scoreModel(cheapRubbish), scoreModel(pricey)]);
    expect(ranked.map((s) => s.record.id)).toEqual(['pricey/good', 'cheap/rubbish']);
    expect(ranked[1]!.tier).toBe('FAIL');
  });

  it('ranks a model that writes wrong code and approves everything below every code-capable model', () => {
    const approver = record('cheap/approver', {
      'implement-write': failedImpl,
      'implement-edit': failedImpl,
      'review-defective': failedImpl,
    }, 0.01);
    const score = scoreModel(approver);
    expect(score.roles).not.toContain('voter');
    expect(score.tier).toBe('C');
    const reviewerOnly = scoreModel(record('dear/reviewer', { 'implement-write': failedImpl, 'implement-edit': failedImpl }, 10));
    expect(reviewerOnly.tier).toBe('B');
    expect(rankScores([score, reviewerOnly]).map((s) => s.record.id)).toEqual(['dear/reviewer', 'cheap/approver']);
  });

  it('fails a model that hallucinates even when its other roles qualify', () => {
    const score = scoreModel(record('x/stubber', { 'implement-write': stub }));
    expect(score.tier).toBe('FAIL');
    expect(score.quality.implementer).toBe(0);
    expect(score.roles).toContain('reviewer');
  });

  it('puts a model that needed a corrective retry in tier B, still qualified as implementer', () => {
    const retried: CaseRecord = { ...PASS, firstAttemptPass: false, attempts: 2, retriedFrom: 'wrong' };
    const score = scoreModel(record('x/retry', { 'implement-edit': retried }));
    expect(score.tier).toBe('B');
    expect(score.quality.implementer).toBeCloseTo(0.8);
    expect(score.roles).toEqual(expect.arrayContaining(['implementer', 'generalist']));
    expect(score.failures).toEqual(['implement-edit:retried-after-wrong']);
  });

  it('sorts within a tier from cheapest to most expensive measured suite cost', () => {
    const cheap = record('b/cheap', { planner: { ...PASS, costUsd: 0 } });
    const dear = record('a/dear', { planner: { ...PASS, costUsd: 0.05 } });
    expect(rankScores([scoreModel(dear), scoreModel(cheap)]).map((s) => s.record.id)).toEqual(['b/cheap', 'a/dear']);
  });

  describe('election abstention', () => {
    const ABSTAINED: CaseRecord = { ...PASS, ok: false, firstAttemptPass: false, failureKind: 'wrong', detail: 'abstained' };
    const withElection = (base: ModelRecord, abstentions: number) => ({
      ...base,
      election: {
        suiteVersion: ELECTION_SUITE_VERSION,
        cases: Object.fromEntries(ELECTION_CASES.map((c, i) => [c.id, i < abstentions ? ABSTAINED : PASS])),
        costUsd: 0.001,
        testedAt: new Date(NOW).toISOString(),
      },
    });

    it('replays the real Prime Coordinator ballot once per constituency', () => {
      expect(ELECTION_CASES).toHaveLength(8);
      expect(new Set(ELECTION_CASES.map((c) => c.systemPrompt)).size).toBe(8);
      expect(ELECTION_CASES[0]!.systemPrompt).toContain('abstain only if you hold a specific objection');
    });

    it('tolerates up to a quarter of abstentions', () => {
      const score = scoreModel(withElection(record('x/ok', {}), 2));
      expect(score.election).toMatchObject({ status: 'tested', abstentionRate: 0.25, overAbstains: false, label: '2/8 abstained' });
      expect(score.tier).toBe('A');
      expect(score.roles).toContain('voter');
    });

    // From solar-mini4: 18 of 24 replays of the real ballot abstained, and a democratic run failed
    // to form a government.
    it('drops a model that abstains on most ballots one tier and out of the voter role', () => {
      const score = scoreModel(withElection(record('x/abstainer', {}), 6));
      expect(score.election.overAbstains).toBe(true);
      expect(score.tier).toBe('B');
      expect(score.roles).not.toContain('voter');
      expect(score.failures).toContain('election:6/8 abstained');
    });

    it('does not penalise a model whose election was never run', () => {
      expect(scoreElection(undefined).status).toBe('not-run');
      expect(scoreModel(record('x/untested', {})).tier).toBe('A');
    });
  });

  describe('repository tool use', () => {
    const NOT_CALLED: CaseRecord = { ...PASS, ok: false, firstAttemptPass: false, failureKind: 'wrong', detail: 'tool call written as text' };
    const withTools = (base: ModelRecord, called: number) => ({
      ...base,
      tools: {
        suiteVersion: TOOL_SUITE_VERSION,
        cases: Object.fromEntries(TOOL_CASES.map((toolCase, index) => [toolCase.id, index < called ? PASS : NOT_CALLED])),
        costUsd: 0.001,
        testedAt: new Date(NOW).toISOString(),
      },
    });

    it('requires repository reads in varied implementer and reviewer cases', () => {
      expect(TOOL_CASES.length).toBeGreaterThanOrEqual(3);
      expect(new Set(TOOL_CASES.map((toolCase) => toolCase.id)).size).toBe(TOOL_CASES.length);
      for (const toolCase of TOOL_CASES) {
        expect(toolCase.userPrompt).toContain(toolCase.expectedPath);
        expect(['implementer', 'reviewer']).toContain(toolCase.role);
      }
    });

    it('tolerates the configured minimum call rate', () => {
      const called = Math.ceil(TOOL_CASES.length * MIN_TOOL_CALL_RATE);
      const score = scoreModel(withTools(record('x/tools-ok', {}), called));
      expect(score.tools).toMatchObject({ status: 'tested', noToolUse: false, label: `${called}/${TOOL_CASES.length} called` });
      expect(score.tier).toBe('A');
      expect(score.roles).toContain('implementer');
    });

    it('drops a model that writes tool calls as text one tier and out of tool-using roles', () => {
      const score = scoreModel(withTools(record('x/no-tools', {}), 0));
      expect(score.tools).toMatchObject({ status: 'tested', callRate: 0, noToolUse: true });
      expect(score.tier).toBe('B');
      expect(score.roles).toEqual(expect.arrayContaining(['voter', 'planner']));
      for (const role of ['implementer', 'reviewer', 'verifier', 'opposition', 'regulator', 'generalist']) {
        expect(score.roles).not.toContain(role);
      }
      expect(score.failures).toContain(`tools:0/${TOOL_CASES.length} called`);
    });

    it('does not penalise a model whose tool suite was never run or was inconclusive', () => {
      expect(scoreTools(undefined)).toMatchObject({ status: 'not-run', noToolUse: false });
      const limited = withTools(record('x/limited-tools', {}), TOOL_CASES.length);
      limited.tools.cases[TOOL_CASES[0]!.id] = { ...NOT_CALLED, failureKind: 'rate-limited' };
      expect(scoreModel(limited)).toMatchObject({ tier: 'A', tools: { status: 'inconclusive', noToolUse: false } });
    });
  });

  it('writes the JSON file as a ranking, by tier and then cheapest first', () => {
    const cheap = record('b/cheap', { planner: { ...PASS, costUsd: 0 } });
    const dear = record('a/dear', { planner: { ...PASS, costUsd: 0.05 } });
    const retried = record('0/retried', { 'implement-edit': { ...PASS, firstAttemptPass: false, attempts: 2, retriedFrom: 'wrong' } });
    const file = benchFile(rankScores([dear, retried, cheap].map(scoreModel)), {
      generatedAt: 'now',
      spentThisRunUsd: 0,
      budgetUsd: 5,
      perModelUsd: 0.1,
      stoppedReason: null,
      sandbox: 'bwrap',
      skippedOverBudget: [],
      tooOldCount: 0,
    });
    expect(file.ranking?.map(({ rank, id, tier }) => ({ rank, id, tier }))).toEqual([
      { rank: 1, id: 'b/cheap', tier: 'A' },
      { rank: 2, id: 'a/dear', tier: 'A' },
      { rank: 3, id: '0/retried', tier: 'B' },
    ]);
    expect(Object.keys(file.results ?? {})).toEqual(['b/cheap', 'a/dear', '0/retried']);
  });

  it('holds rate-limited models out of the ranking as inconclusive and re-tests them', () => {
    const limited = record('x/limited', { ballot: { ...failedImpl, failureKind: 'rate-limited' } });
    expect(scoreModel(limited).tier).toBe('INCONCLUSIVE');
    expect(isReusable(limited, catalogModel('x/limited', 1, 1), NOW, 30)).toBe(false);
    expect(isReusable(record('x/ok', {}), catalogModel('x/ok', 1, 1), NOW, 30)).toBe(true);
    expect(isReusable(record('x/ok', {}), catalogModel('x/ok', 2, 1), NOW, 30)).toBe(false);
  });

  it('renders ranked rows and a per-role table', () => {
    const md = renderMarkdown(rankScores([scoreModel(record('a/one', {}))]), {
      generatedAt: 'now',
      spentThisRunUsd: 0.01,
      budgetUsd: 5,
      perModelUsd: 0.1,
      stoppedReason: null,
      sandbox: 'bwrap',
      skippedOverBudget: ['big/model'],
      tooOldCount: 3,
    });
    expect(md).toContain('| 1 | A | `a/one` |');
    expect(md).toContain('## Best implementer');
    expect(md).toContain('`big/model`');
  });
});

describe('tool-use runner', () => {
  it('uses the production tool request shape and accepts a real call', async () => {
    const chatCompletion = vi.fn(async (_options: unknown) => ({
      text: '',
      promptTokens: 100,
      completionTokens: 20,
      costUsd: 0.0001,
      costMetered: true,
      model: 'x/model',
      attempts: 1,
      timedOut: false,
      toolCalls: [{ id: 'call-1', type: 'function' as const, function: { name: 'read_repository_file', arguments: '{"path":"src/a.ts"}' } }],
    }));
    const result = await benchTools(
      { chatCompletion } as unknown as OpenRouterClient,
      catalogModel('x/model', 1, 1),
      { maxTokens: 2000, worstCaseUsd: 0.01 },
      0.1,
    );
    expect(chatCompletion).toHaveBeenCalledTimes(TOOL_CASES.length);
    expect(chatCompletion.mock.calls[0]![0]).toMatchObject({ jsonMode: false, toolChoice: 'auto' });
    expect(Object.values(result.cases).every((caseRecord) => caseRecord.ok)).toBe(true);
  });

  it('rejects a tool call written as text without retrying', async () => {
    const chatCompletion = vi.fn(async (_options: unknown) => ({
      text: '{"call":{"name":"read_repository_file","path":"src/a.ts"}}',
      promptTokens: 100,
      completionTokens: 20,
      costUsd: 0.0001,
      costMetered: true,
      model: 'x/model',
      attempts: 1,
      timedOut: false,
      toolCalls: [],
    }));
    const result = await benchTools(
      { chatCompletion } as unknown as OpenRouterClient,
      catalogModel('x/model', 1, 1),
      { maxTokens: 2000, worstCaseUsd: 0.01 },
      0.1,
    );
    expect(chatCompletion).toHaveBeenCalledTimes(TOOL_CASES.length);
    expect(Object.values(result.cases)).toEqual(
      expect.arrayContaining([expect.objectContaining({ ok: false, attempts: 1, failureKind: 'wrong', detail: 'tool call written as text' })]),
    );
  });
});

describe('hard tier', () => {
  let runPython: PythonRunner;
  beforeAll(async () => {
    runPython = pythonRunner(await detectSandbox());
  });
  const hardCase = (id: string) => HARD_CASES.find((c) => c.id === id)!;

  const reference = {
    'unitconv/data.py':
      'import csv\nfrom pathlib import Path\n\ndef load_units():\n' +
      '    with open(Path(__file__).with_name("units.csv"), newline="") as f:\n' +
      '        return {r["unit"]: (r["dimension"], float(r["factor"])) for r in csv.DictReader(f)}\n',
    'unitconv/__init__.py':
      'from .data import load_units\n\ndef convert(value, from_unit, to_unit):\n    units = load_units()\n' +
      '    for u in (from_unit, to_unit):\n        if u not in units:\n            raise ValueError(f"unknown unit: {u}")\n' +
      '    (da, fa), (db, fb) = units[from_unit], units[to_unit]\n' +
      '    if da != db:\n        raise ValueError(f"incompatible units: {from_unit} and {to_unit}")\n' +
      '    return float(value) * fa / fb\n',
    'unitconv/cli.py':
      'import argparse, sys\nfrom . import convert\nfrom .data import load_units\n\ndef main(argv=None):\n' +
      '    parser = argparse.ArgumentParser(prog="unitconv")\n    sub = parser.add_subparsers(dest="command")\n' +
      '    c = sub.add_parser("convert"); c.add_argument("value", type=float); c.add_argument("src"); c.add_argument("dst")\n' +
      '    l = sub.add_parser("list"); l.add_argument("--dimension")\n    args = parser.parse_args(argv)\n' +
      '    if args.command is None:\n        parser.print_usage(sys.stderr)\n        sys.exit(2)\n' +
      '    if args.command == "convert":\n        try:\n            print("{:g}".format(convert(args.value, args.src, args.dst)))\n' +
      '        except ValueError as e:\n            print(e, file=sys.stderr)\n            sys.exit(2)\n' +
      '    else:\n        for u in sorted(k for k, (d, _) in load_units().items() if args.dimension in (None, d)):\n            print(u)\n',
    'unitconv/__main__.py': 'from .cli import main\n\nmain()\n',
  };
  const writes = Object.entries(reference).map(([path, content]) => ({ op: 'write', path, content }));

  it('passes a correct multi-file unitconv package', async () => {
    expect(await hardCase('hard-cli').grade({ fileOps: writes, rationale: 'r' }, runPython)).toEqual({ ok: true });
  });

  it('fails the package when __main__.py is missing — the benchmark blocker it mirrors', async () => {
    const grade = await hardCase('hard-cli').grade({ fileOps: writes.filter((w) => !w.path.endsWith('__main__.py')), rationale: 'r' }, runPython);
    expect(grade).toMatchObject({ ok: false, kind: 'wrong' });
  });

  it('calls a stubbed module in the package a hallucination', async () => {
    const stubbed = writes.map((w) => (w.path.endsWith('cli.py') ? { ...w, content: 'pass' } : w));
    expect((await hardCase('hard-cli').grade({ fileOps: stubbed, rationale: 'r' }, runPython)).kind).toBe('hallucination');
  });

  it('builds a ~10k-token module whose bug is quoted exactly once', () => {
    expect(OPERATIONS_MODULE.source.length).toBeGreaterThan(30_000);
    expect(OPERATIONS_MODULE.source.split('hours * 360 ').length - 1).toBe(1);
  });

  it('passes the exact one-line fix in the long file, with every spot-checked helper intact', async () => {
    const fix = { op: 'edit', path: 'operations.py', find: 'hours * 360 + minutes', replace: 'hours * 3600 + minutes' };
    expect(await hardCase('hard-long-edit').grade({ fileOps: [fix], rationale: 'r' }, runPython)).toEqual({ ok: true });
  });

  it('calls a misquoted find in the long file a hallucination', async () => {
    const fix = { op: 'edit', path: 'operations.py', find: 'return hours*360 + minutes*60 + seconds', replace: 'x' };
    expect((await hardCase('hard-long-edit').grade({ fileOps: [fix], rationale: 'r' }, runPython)).kind).toBe('hallucination');
  });

  it('fails an edit that also breaks an unrelated helper', async () => {
    const ops = [
      { op: 'edit', path: 'operations.py', find: 'hours * 360 + minutes', replace: 'hours * 3600 + minutes' },
      { op: 'edit', path: 'operations.py', find: 'def clamp_invoice_quantity(quantity, maximum=', replace: 'def clamp_invoice_qty(quantity, maximum=' },
    ];
    expect((await hardCase('hard-long-edit').grade({ fileOps: ops, rationale: 'r' }, runPython)).ok).toBe(false);
  });

  const hardRecord = (cases: Record<string, CaseRecord>) => ({
    suiteVersion: HARD_SUITE_VERSION, status: 'tested' as const, maxTokens: 6000, cases, costUsd: 0.004, testedAt: new Date(NOW).toISOString(),
  });

  it('lifts tier A to A+ on a hard pass and ranks it above every plain A', () => {
    const passed = scoreModel({ ...record('dear/hard', {}, 5), hard: hardRecord({ 'hard-cli': PASS, 'hard-long-edit': PASS }) });
    const cheap = scoreModel(record('cheap/easy-only', {}, 0.01));
    expect(passed.tier).toBe('A+');
    expect(passed.hard.label).toBe('2/2');
    expect(rankScores([cheap, passed]).map((s) => s.record.id)).toEqual(['dear/hard', 'cheap/easy-only']);
  });

  it('drops a tier for a hallucination on the hard tier', () => {
    const stub: CaseRecord = { ok: false, firstAttemptPass: false, failureKind: 'hallucination', attempts: 2, latencyMs: 1, costUsd: 0.001 };
    const score = scoreModel({ ...record('x/stubber', {}), hard: hardRecord({ 'hard-cli': stub, 'hard-long-edit': PASS }) });
    expect(score.tier).toBe('B');
    expect(score.hard.hallucinated).toBe(true);
  });

  it('re-runs the hard tier only when missing or inconclusive', () => {
    const limited: CaseRecord = { ok: false, firstAttemptPass: false, failureKind: 'rate-limited', attempts: 1, latencyMs: 1, costUsd: 0 };
    expect(needsHardRun(undefined)).toBe(true);
    expect(needsHardRun(hardRecord({ 'hard-cli': limited, 'hard-long-edit': PASS }))).toBe(true);
    expect(needsHardRun(hardRecord({ 'hard-cli': PASS, 'hard-long-edit': PASS }))).toBe(false);
  });

  it('keeps the hard suite under the per-model cap for a mid-priced model', () => {
    const plan = planModelBudget({ inputPricePerMTok: 1, outputPricePerMTok: 5 }, 0.1, HARD_SHAPE)!;
    expect(plan.worstCaseUsd).toBeLessThanOrEqual(0.1);
    expect(plan.maxTokens).toBeGreaterThanOrEqual(1500);
  });
});
