// Benches recent OpenRouter models on a short, strategy-shaped suite and ranks them by what a
// useful answer actually costs.
//
// modelProbe.ts answers "can this model emit the schema?". This answers "should the swarm use it,
// and for which role?": it runs the implementer's code against hidden tests, checks reviewer and
// committee judgement, and treats invented content (a stub body, an edit against text that is not
// in the file, a citation of a file that was never shown) as disqualifying. Cost is ranked as
// spend divided by quality, so a nearly free model that needs retries and still fails does not
// outrank a pricier one that is right first time.
//
// Spend is hard-capped twice: each model's worst case is sized under --per-model before its first
// call (by capping max_tokens), and that worst case is reserved against --budget before the model
// is dispatched, so concurrent models cannot jointly overshoot. Free models run first.
// Use --hard for real-sized implementation cases, --election for ballot replay, and --tools for
// the production repository-tool request shape. --render-only never calls a model.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { OpenRouterClient, type CatalogModel, type ChatMessage, type ToolCall } from '../engine/OpenRouterClient.js';
import { REPOSITORY_TOOL_DEFINITIONS } from '../engine/repositoryTools.js';
import { extractJson } from '../util/jsonSchema.js';
import { buildProbeMessages, classifyFailure, mapWithConcurrency, type FailureKind } from './modelProbe.js';
import {
  BENCH_CASES,
  ELECTION_CASES,
  ELECTION_SUITE_VERSION,
  HARD_CASES,
  MAX_ELECTION_ABSTENTION,
  MIN_TOOL_CALL_RATE,
  HARD_SUITE_VERSION,
  SUITE_VERSION,
  TOOL_CASES,
  TOOL_SUITE_VERSION,
  detectSandbox,
  pythonRunner,
  type BenchCase,
  type BenchRole,
  type PythonRunner,
} from './modelBenchCases.js';
import { log as createLog } from './harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '../../..');
const jsonPath = path.join(pluginRoot, 'config', 'model-bench.json');
const markdownPath = path.join(pluginRoot, 'config', 'model-bench.md');
// Append-only: model-bench.json is a cache whose verdicts are replaced when re-tested, so this is
// the permanent record of every test and run. Never rewritten, only appended to.
const historyPath = path.join(pluginRoot, 'config', 'model-bench-history.jsonl');

const log = createLog('model-bench');

const CALL_TIMEOUT_MS = 60_000;
const TEMPERATURE = 0;
const SLOW_MEDIAN_MS = 30_000;
const RETRY_CREDIT = 0.6;
const IMPLEMENTER_QUALIFIES_AT = 0.8;
const MIN_QUALITY_FOR_COST = 0.05;
const MS_PER_DAY = 86_400_000;
const DEFAULTS = { budget: 5, perModel: 0.1, maxAgeDays: 365, cacheDays: 30, freeConcurrency: 2, paidConcurrency: 6 };
const REPOSITORY_TOOL_NAMES = new Set(REPOSITORY_TOOL_DEFINITIONS.map((tool) => tool.function.name));

export type BenchFailureKind =
  | FailureKind
  | 'rate-limited'
  | 'unavailable'
  | 'hallucination'
  | 'wrong'
  | 'budget-exhausted';
// A statement about the provider that hour rather than about the model: re-tested next run and
// never counted against the model.
const INCONCLUSIVE_KINDS: ReadonlySet<BenchFailureKind> = new Set(['transport', 'rate-limited']);
// Only a wrong or malformed answer is worth a corrective retry; any of these would just be paid
// for, or refused, twice.
const NOT_WORTH_CORRECTING: ReadonlySet<BenchFailureKind> = new Set([
  ...INCONCLUSIVE_KINDS,
  'timeout',
  'capability-mismatch',
  'unavailable',
]);

export interface CaseRecord {
  ok: boolean;
  firstAttemptPass: boolean;
  failureKind?: BenchFailureKind;
  detail?: string;
  /** What the first attempt got wrong when a corrective retry then passed. */
  retriedFrom?: BenchFailureKind;
  attempts: number;
  /** First attempt only — a retry's latency is a cost, not a measure of responsiveness. */
  latencyMs: number;
  costUsd: number;
}

export interface ModelRecord {
  id: string;
  suiteVersion: number;
  free: boolean;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  createdAt: number | null;
  maxTokens: number;
  worstCaseUsd: number;
  cases: Record<string, CaseRecord>;
  costUsd: number;
  testedAt: string;
  /** The hard tier, run only on models that clear the easy suite. */
  hard?: HardRecord;
  /** The Prime Coordinator ballot replayed per constituency, to measure abstention. */
  election?: ElectionRecord;
  /** Whether the model makes real repository tool calls with the dispatcher's request shape. */
  tools?: ToolsRecord;
}

export interface ElectionRecord {
  suiteVersion: number;
  cases: Record<string, CaseRecord>;
  costUsd: number;
  testedAt: string;
}

export interface ToolsRecord {
  suiteVersion: number;
  cases: Record<string, CaseRecord>;
  costUsd: number;
  testedAt: string;
}

export interface HardRecord {
  suiteVersion: number;
  /** over-cap: the hard suite cannot fit under the per-model cap at a useful max_tokens. */
  status: 'tested' | 'over-cap';
  maxTokens: number;
  cases: Record<string, CaseRecord>;
  costUsd: number;
  testedAt: string;
}

// ---------- candidate selection ----------

export function isFree(model: CatalogModel): boolean {
  return model.id.endsWith(':free') || (model.inputPricePerMTok === 0 && model.outputPricePerMTok === 0);
}

function listPricePerCall(model: CatalogModel): number {
  return (model.inputPricePerMTok * 1.5 + model.outputPricePerMTok * 2) / 1000;
}

export interface Candidates {
  eligible: CatalogModel[];
  tooOld: CatalogModel[];
}

/** Drops what the dispatcher cannot use or that is over `maxAgeDays` old, then orders free models
 * first and the rest by list price. */
export function selectCandidates(catalog: readonly CatalogModel[], now: number, maxAgeDays: number): Candidates {
  const usable = catalog.filter(
    (m) =>
      m.inputPricePerMTok >= 0 &&
      m.outputPricePerMTok >= 0 &&
      // Routers resolve to a different model per call, so a verdict cannot attach to the id.
      !m.id.startsWith('openrouter/') &&
      !m.id.endsWith(':batch') &&
      (m.supportsJsonMode || m.supportsToolCalls),
  );
  const cutoff = now / 1000 - maxAgeDays * 86_400;
  const recent = (m: CatalogModel): boolean => m.createdAt !== undefined && m.createdAt >= cutoff;
  const eligible = usable
    .filter(recent)
    .sort((a, b) => Number(isFree(b)) - Number(isFree(a)) || listPricePerCall(a) - listPricePerCall(b) || a.id.localeCompare(b.id));
  return { eligible, tooOld: usable.filter((m) => !recent(m)) };
}

export function matchesInclude(id: string, patterns: readonly string[]): boolean {
  if (!patterns.length) return true;
  return patterns.some((p) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`).test(id));
}

// ---------- budget ----------

/** What one suite costs to run, for sizing max_tokens under a cap before any call is made. */
export interface SuiteShape {
  calls: number;
  retryCalls: number;
  /** Generous on purpose: underestimating is what would let metered cost pass the reserved worst case. */
  promptTokens: number;
  maxTokensCeiling: number;
  /** Below this a model cannot answer the suite's largest case, so capping harder than this to fit
   * the cap would only manufacture a failure. */
  minUsefulMaxTokens: number;
}

function shapeOf(cases: readonly BenchCase[], promptTokens: number, maxTokensCeiling: number, minUsefulMaxTokens: number): SuiteShape {
  const retryCalls = cases.filter((c) => c.retryable).length;
  return { calls: cases.length + retryCalls, retryCalls, promptTokens, maxTokensCeiling, minUsefulMaxTokens };
}

// The easy suite's prompts are 300-1000 tokens; the hard tier's long-context case is ~10k.
export const EASY_SHAPE = shapeOf(BENCH_CASES, 2000, 4000, 800);
export const HARD_SHAPE = shapeOf(HARD_CASES, 11_000, 6000, 1500);
// Eight ~300-token ballots whose answer is a one-line object; reasoning models still need room.
export const ELECTION_SHAPE = shapeOf(ELECTION_CASES, 600, 2000, 400);
export const TOOLS_SHAPE: SuiteShape = {
  calls: TOOL_CASES.length,
  retryCalls: 0,
  promptTokens: 600,
  maxTokensCeiling: 2000,
  minUsefulMaxTokens: 400,
};

/** Sizes max_tokens so that the whole suite, retries included, cannot cost more than `capUsd`. A
 * retry resends the previous answer, so its input carries up to maxTokens more. */
export function planModelBudget(
  model: Pick<CatalogModel, 'inputPricePerMTok' | 'outputPricePerMTok'>,
  capUsd: number,
  shape: SuiteShape = EASY_SHAPE,
): { maxTokens: number; worstCaseUsd: number } | null {
  const inPrice = model.inputPricePerMTok / 1_000_000;
  const outPrice = model.outputPricePerMTok / 1_000_000;
  const fixedInput = shape.calls * shape.promptTokens * inPrice;
  const perOutputToken = shape.retryCalls * inPrice + shape.calls * outPrice;
  const affordable = perOutputToken === 0 ? Infinity : Math.floor((capUsd - fixedInput) / perOutputToken);
  const maxTokens = Math.min(shape.maxTokensCeiling, affordable);
  if (maxTokens < shape.minUsefulMaxTokens) return null;
  return { maxTokens, worstCaseUsd: fixedInput + maxTokens * perOutputToken };
}

/** Reserve-then-settle ledger: a model's worst case is held against the cap before it runs, so
 * concurrent models cannot jointly pass the cap before any of them reports what it spent. */
export class SpendLedger {
  spentUsd = 0;
  private reservedUsd = 0;

  constructor(readonly capUsd: number) {}

  tryReserve(amountUsd: number): boolean {
    if (this.spentUsd + this.reservedUsd + amountUsd > this.capUsd) return false;
    this.reservedUsd += amountUsd;
    return true;
  }

  settle(reservedUsd: number, actualUsd: number): void {
    this.reservedUsd -= reservedUsd;
    this.spentUsd += actualUsd;
  }
}

// ---------- running one model ----------

export function benchFailure(error: unknown, timedOut: boolean): { kind: BenchFailureKind; detail: string } {
  const classified = classifyFailure(error, timedOut);
  if (/\b429\b|rate.?limit/i.test(classified.detail)) return { kind: 'rate-limited', detail: classified.detail };
  // An upstream error arrives as HTTP 200 with an error body, which classifyFailure files under
  // "schema" — a verdict about the model for what was the provider being overloaded.
  if (/OpenRouter returned an error|Upstream error|ResourceExhausted|overloaded|capacity/i.test(classified.detail)) {
    return { kind: 'transport', detail: classified.detail };
  }
  if (/No parseable JSON/i.test(classified.detail)) return { kind: 'unparseable', detail: classified.detail };
  // A 4xx other than a timeout or rate limit is a deterministic refusal (age gate, harness-only
  // access, a parameter the dispatcher always sends) — retrying it next run would fail identically.
  if (classified.kind === 'transport' && /OpenRouter 4(0[0-7]|09|1\d|2[0-8])\b/.test(classified.detail)) {
    return { kind: 'unavailable', detail: classified.detail };
  }
  return classified;
}

/** One model's running spend against its per-model cap. */
export interface ModelSpend {
  capUsd: number;
  spentUsd: number;
  /** The dearest call so far — the best available forecast of what the next one will cost. */
  maxCallUsd: number;
}

/** A call is made only if the cap still covers the dearest call seen so far. Checking merely for
 * budget left let x-ai/grok-4.20-multi-agent, which bills internal agent tokens that max_tokens does
 * not bound, make a $0.026 call with $0.001 remaining. The first call cannot be forecast and is
 * bounded only by planModelBudget's estimate. */
export function canAffordNextCall(spend: ModelSpend): boolean {
  return spend.spentUsd + spend.maxCallUsd <= spend.capUsd;
}

async function runCase(
  client: OpenRouterClient,
  model: CatalogModel,
  benchCase: BenchCase,
  maxTokens: number,
  runPython: PythonRunner,
  spend: ModelSpend,
): Promise<CaseRecord> {
  const messages: ChatMessage[] = buildProbeMessages(benchCase, benchCase.role);
  const record: CaseRecord = { ok: false, firstAttemptPass: false, attempts: 0, latencyMs: 0, costUsd: 0 };
  const maxAttempts = benchCase.retryable ? 2 : 1;

  while (record.attempts < maxAttempts) {
    if (!canAffordNextCall(spend)) {
      return { ...record, failureKind: 'budget-exhausted', detail: 'per-model cap cannot cover another call' };
    }
    record.attempts += 1;
    const startedAt = Date.now();
    let timedOut = false;
    let text = '';
    let failure: { kind: BenchFailureKind; detail: string } | undefined;
    try {
      const result = await client.chatCompletion({
        model: model.id,
        modelEntry: model,
        messages,
        jsonMode: model.supportsJsonMode,
        timeoutMs: CALL_TIMEOUT_MS,
        temperature: TEMPERATURE,
        maxTokens,
      });
      record.costUsd += result.costUsd;
      spend.spentUsd += result.costUsd;
      spend.maxCallUsd = Math.max(spend.maxCallUsd, result.costUsd);
      timedOut = result.timedOut;
      text = result.text;
      if (!text.trim()) {
        // Usually a reasoning model spending its whole max_tokens thinking; the token count says which.
        const capped = result.completionTokens >= maxTokens * 0.95 ? ' — hit max_tokens, likely all reasoning' : '';
        throw new Error(`No parseable JSON: empty response after ${result.completionTokens} completion tokens${capped}`);
      }
      const value = extractJson(text);
      benchCase.validate(value);
      const grade = await benchCase.grade(value, runPython);
      if (!grade.ok) failure = { kind: grade.kind ?? 'wrong', detail: grade.detail ?? '' };
    } catch (err) {
      failure = benchFailure(err, timedOut);
    }
    if (record.attempts === 1) record.latencyMs = Date.now() - startedAt;

    if (!failure) {
      const { failureKind, detail, ...rest } = record;
      return { ...rest, ok: true, firstAttemptPass: record.attempts === 1, ...(failureKind ? { retriedFrom: failureKind } : {}) };
    }
    Object.assign(record, { failureKind: failure.kind, detail: failure.detail.slice(0, 300) });
    if (NOT_WORTH_CORRECTING.has(failure.kind)) break;
    // Some providers (Cohere) reject an assistant turn with empty content, so an empty reply is
    // corrected with the feedback alone.
    if (text) messages.push({ role: 'assistant', content: text });
    messages.push({ role: 'user', content: `Your previous response was rejected: ${failure.detail.slice(0, 300)}\nReturn the corrected JSON only.` });
  }
  return record;
}

async function runSuite(
  client: OpenRouterClient,
  model: CatalogModel,
  cases: readonly BenchCase[],
  maxTokens: number,
  capUsd: number,
  runPython: PythonRunner,
): Promise<{ cases: Record<string, CaseRecord>; costUsd: number }> {
  const results: Record<string, CaseRecord> = {};
  const spend: ModelSpend = { capUsd, spentUsd: 0, maxCallUsd: 0 };
  for (const benchCase of cases) {
    results[benchCase.id] = await runCase(client, model, benchCase, maxTokens, runPython, spend);
  }
  return { cases: results, costUsd: spend.spentUsd };
}

async function benchModel(
  client: OpenRouterClient,
  model: CatalogModel,
  budget: { maxTokens: number; worstCaseUsd: number },
  perModelUsd: number,
  runPython: PythonRunner,
): Promise<ModelRecord> {
  const { cases, costUsd } = await runSuite(client, model, BENCH_CASES, budget.maxTokens, perModelUsd, runPython);
  return {
    id: model.id,
    suiteVersion: SUITE_VERSION,
    free: isFree(model),
    inputPricePerMTok: model.inputPricePerMTok,
    outputPricePerMTok: model.outputPricePerMTok,
    createdAt: model.createdAt ?? null,
    maxTokens: budget.maxTokens,
    worstCaseUsd: budget.worstCaseUsd,
    cases,
    costUsd,
    testedAt: new Date().toISOString(),
  };
}

async function benchHard(
  client: OpenRouterClient,
  model: CatalogModel,
  budget: { maxTokens: number; worstCaseUsd: number },
  perModelUsd: number,
  runPython: PythonRunner,
): Promise<HardRecord> {
  const { cases, costUsd } = await runSuite(client, model, HARD_CASES, budget.maxTokens, perModelUsd, runPython);
  return { suiteVersion: HARD_SUITE_VERSION, status: 'tested', maxTokens: budget.maxTokens, cases, costUsd, testedAt: new Date().toISOString() };
}

async function benchElection(
  client: OpenRouterClient,
  model: CatalogModel,
  budget: { maxTokens: number; worstCaseUsd: number },
  perModelUsd: number,
  runPython: PythonRunner,
): Promise<ElectionRecord> {
  const { cases, costUsd } = await runSuite(client, model, ELECTION_CASES, budget.maxTokens, perModelUsd, runPython);
  return { suiteVersion: ELECTION_SUITE_VERSION, cases, costUsd, testedAt: new Date().toISOString() };
}

function validToolCall(toolCalls: readonly ToolCall[] | undefined): boolean {
  return (toolCalls ?? []).some((call) => {
    if (!REPOSITORY_TOOL_NAMES.has(call.function.name)) return false;
    try {
      const args = JSON.parse(call.function.arguments) as unknown;
      return typeof args === 'object' && args !== null && !Array.isArray(args);
    } catch {
      return false;
    }
  });
}

function toolFailureDetail(text: string, toolCalls: readonly ToolCall[]): string {
  const unknown = toolCalls.find((call) => !REPOSITORY_TOOL_NAMES.has(call.function.name));
  if (unknown) return `unknown tool: ${unknown.function.name}`;
  if (toolCalls.length) return 'tool call arguments were not a JSON object';
  if (/read_repository_file|list_repository_files|search_repository|"call"|"name"/.test(text)) return 'tool call written as text';
  return 'no tool call made';
}

export async function benchTools(
  client: OpenRouterClient,
  model: CatalogModel,
  budget: { maxTokens: number; worstCaseUsd: number },
  perModelUsd: number,
): Promise<ToolsRecord> {
  const cases: Record<string, CaseRecord> = {};
  const spend: ModelSpend = { capUsd: perModelUsd, spentUsd: 0, maxCallUsd: 0 };
  for (const toolCase of TOOL_CASES) {
    const base: CaseRecord = { ok: false, firstAttemptPass: false, attempts: 0, latencyMs: 0, costUsd: 0 };
    if (!canAffordNextCall(spend)) {
      cases[toolCase.id] = { ...base, failureKind: 'budget-exhausted', detail: 'per-model cap cannot cover another call' };
      continue;
    }
    const startedAt = Date.now();
    try {
      const result = await client.chatCompletion({
        model: model.id,
        modelEntry: model,
        messages: [
          { role: 'system', content: toolCase.systemPrompt },
          { role: 'user', content: toolCase.userPrompt },
        ],
        jsonMode: false,
        timeoutMs: CALL_TIMEOUT_MS,
        temperature: TEMPERATURE,
        maxTokens: budget.maxTokens,
        tools: REPOSITORY_TOOL_DEFINITIONS,
        toolChoice: 'auto',
      });
      spend.spentUsd += result.costUsd;
      spend.maxCallUsd = Math.max(spend.maxCallUsd, result.costUsd);
      const ok = validToolCall(result.toolCalls);
      cases[toolCase.id] = {
        ok,
        firstAttemptPass: ok,
        attempts: 1,
        latencyMs: Date.now() - startedAt,
        costUsd: result.costUsd,
        ...(!ok ? { failureKind: 'wrong' as const, detail: toolFailureDetail(result.text, result.toolCalls ?? []) } : {}),
      };
    } catch (err) {
      const failure = benchFailure(err, false);
      cases[toolCase.id] = {
        ...base,
        attempts: 1,
        latencyMs: Date.now() - startedAt,
        failureKind: failure.kind,
        detail: failure.detail.slice(0, 300),
      };
    }
  }
  return { suiteVersion: TOOL_SUITE_VERSION, cases, costUsd: spend.spentUsd, testedAt: new Date().toISOString() };
}

// ---------- scoring ----------

export type Tier = 'A+' | 'A' | 'B' | 'C' | 'FAIL' | 'INCONCLUSIVE';

export interface ModelScore {
  record: ModelRecord;
  quality: Record<BenchRole, number>;
  effectiveCost: Record<BenchRole, number>;
  /** Suite cost divided by mean quality across roles. */
  overallEffectiveCost: number;
  roles: string[];
  hallucinated: boolean;
  slow: boolean;
  retried: boolean;
  medianLatencyMs: number;
  maxLatencyMs: number;
  failures: string[];
  hard: HardScore;
  election: ElectionScore;
  tools: ToolsScore;
  /** Easy plus optional-suite spend — what this model's verdict actually cost. */
  totalCostUsd: number;
  tier: Tier;
}

export interface HardScore {
  status: 'not-run' | 'over-cap' | 'inconclusive' | 'tested';
  /** Same credit as the easy suite: 1 first time, RETRY_CREDIT after one correction, else 0. */
  quality: number;
  hallucinated: boolean;
  label: string;
}

const ROLES: BenchRole[] = ['implementer', 'reviewer', 'voter', 'planner'];
// Bench roles mapped onto config/models.yaml role keys. Voter is the democratic committee seat,
// which models.yaml routes through reviewer; it is kept separate here because abstention is its
// own failure mode.
const ROLE_KEYS: Record<BenchRole, string[]> = {
  implementer: ['implementer'],
  reviewer: ['reviewer', 'verifier', 'opposition', 'regulator'],
  voter: ['voter'],
  planner: ['planner', 'speaker'],
};

function caseCredit(c: CaseRecord | undefined): number {
  if (!c?.ok) return 0;
  return c.firstAttemptPass ? 1 : RETRY_CREDIT;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface ElectionScore {
  status: 'not-run' | 'inconclusive' | 'tested';
  /** Abstentions over ballots answered; 0 when not tested. */
  abstentionRate: number;
  /** True when the rate is over MAX_ELECTION_ABSTENTION: the model loses the voter role and a tier. */
  overAbstains: boolean;
  label: string;
}

export interface ToolsScore {
  status: 'not-run' | 'inconclusive' | 'tested';
  callRate: number;
  noToolUse: boolean;
  label: string;
}

export function scoreTools(tools: ToolsRecord | undefined): ToolsScore {
  if (!tools || tools.suiteVersion !== TOOL_SUITE_VERSION) {
    return { status: 'not-run', callRate: 0, noToolUse: false, label: '—' };
  }
  const cases = TOOL_CASES.map((toolCase) => tools.cases[toolCase.id]);
  if (cases.some((record) => record?.failureKind !== undefined && INCONCLUSIVE_KINDS.has(record.failureKind))) {
    return { status: 'inconclusive', callRate: 0, noToolUse: false, label: 'inconclusive' };
  }
  const okCount = cases.filter((record) => record?.ok).length;
  const callRate = okCount / TOOL_CASES.length;
  return {
    status: 'tested',
    callRate,
    noToolUse: callRate < MIN_TOOL_CALL_RATE,
    label: `${okCount}/${TOOL_CASES.length} called`,
  };
}

export function scoreElection(election: ElectionRecord | undefined): ElectionScore {
  if (!election || election.suiteVersion !== ELECTION_SUITE_VERSION) {
    return { status: 'not-run', abstentionRate: 0, overAbstains: false, label: '—' };
  }
  const cases = ELECTION_CASES.map((c) => election.cases[c.id]);
  if (cases.some((c) => !c || (c.failureKind !== undefined && INCONCLUSIVE_KINDS.has(c.failureKind)))) {
    return { status: 'inconclusive', abstentionRate: 0, overAbstains: false, label: 'inconclusive' };
  }
  // Only an abstention counts against the rate; a ballot that was malformed or timed out is a
  // different failure the easy suite already measures.
  const abstained = cases.filter((c) => c?.failureKind === 'wrong').length;
  const abstentionRate = abstained / cases.length;
  return {
    status: 'tested',
    abstentionRate,
    overAbstains: abstentionRate > MAX_ELECTION_ABSTENTION,
    label: `${abstained}/${cases.length} abstained`,
  };
}

export function scoreHard(hard: HardRecord | undefined): HardScore {
  if (!hard || hard.suiteVersion !== HARD_SUITE_VERSION) return { status: 'not-run', quality: 0, hallucinated: false, label: '—' };
  if (hard.status === 'over-cap') return { status: 'over-cap', quality: 0, hallucinated: false, label: 'over cap' };
  const cases = HARD_CASES.map((c) => hard.cases[c.id]);
  if (cases.some((c) => c?.failureKind !== undefined && INCONCLUSIVE_KINDS.has(c.failureKind))) {
    return { status: 'inconclusive', quality: 0, hallucinated: false, label: 'inconclusive' };
  }
  const hallucinated = cases.some((c) => c?.failureKind === 'hallucination');
  const quality = hallucinated ? 0 : cases.reduce((sum, c) => sum + caseCredit(c), 0) / cases.length;
  const passed = cases.filter((c) => c?.ok).length;
  const retried = cases.some((c) => c?.ok && !c.firstAttemptPass);
  return {
    status: 'tested',
    quality,
    hallucinated,
    label: `${passed}/${cases.length}${retried ? ' (retry)' : ''}${hallucinated ? ' HALLUCINATED' : ''}`,
  };
}

export function scoreModel(record: ModelRecord): ModelScore {
  const quality = {} as Record<BenchRole, number>;
  const effectiveCost = {} as Record<BenchRole, number>;
  let hallucinated = false;

  for (const role of ROLES) {
    const roleCases = BENCH_CASES.filter((c) => c.role === role).map((c) => record.cases[c.id]);
    const roleHallucinated = roleCases.some((c) => c?.failureKind === 'hallucination');
    hallucinated ||= roleHallucinated;
    quality[role] = roleHallucinated ? 0 : roleCases.reduce((sum, c) => sum + caseCredit(c), 0) / roleCases.length;
    const roleCost = roleCases.reduce((sum, c) => sum + (c?.costUsd ?? 0), 0);
    effectiveCost[role] = roleCost / Math.max(quality[role], MIN_QUALITY_FOR_COST);
  }

  // The ballot's right answer is "approve", so on its own it rewards a model that always approves.
  // A voter must also have rejected the defective diff — proof that it can say no.
  const election = scoreElection(record.election);
  const tools = scoreTools(record.tools);
  const qualified: BenchRole[] = ROLES.filter((role) => {
    if (role === 'implementer') return quality[role] >= IMPLEMENTER_QUALIFIES_AT;
    if (role === 'voter') return quality[role] === 1 && record.cases['review-defective']?.ok === true && !election.overAbstains;
    return quality[role] === 1;
  });
  const codeRoles = qualified.filter((role) => role === 'implementer' || role === 'reviewer');
  let roles = qualified.flatMap((role) => ROLE_KEYS[role]);
  if (qualified.length === ROLES.length) roles.push('generalist');
  if (tools.noToolUse) {
    const toolRoleKeys = new Set([...ROLE_KEYS.implementer, ...ROLE_KEYS.reviewer, 'generalist']);
    roles = roles.filter((role) => !toolRoleKeys.has(role));
  }

  const cases = Object.values(record.cases);
  const latencies = cases.filter((c) => c.attempts > 0).map((c) => c.latencyMs);
  const medianLatencyMs = median(latencies);
  const slow = medianLatencyMs > SLOW_MEDIAN_MS || cases.some((c) => c.failureKind === 'timeout');
  const retried = cases.some((c) => c.ok && !c.firstAttemptPass);
  const failures = Object.entries(record.cases).flatMap(([id, c]) => {
    if (!c.ok) return [`${id}:${c.failureKind}`];
    return c.retriedFrom ? [`${id}:retried-after-${c.retriedFrom}`] : [];
  });
  if (election.overAbstains) failures.push(`election:${election.label}`);
  if (tools.noToolUse) failures.push(`tools:${tools.label}`);
  const inconclusive = cases.some((c) => c.failureKind && INCONCLUSIVE_KINDS.has(c.failureKind));
  const meanQuality = ROLES.reduce((sum, role) => sum + quality[role], 0) / ROLES.length;

  let tier: Tier;
  if (hallucinated) tier = 'FAIL';
  else if (inconclusive) tier = 'INCONCLUSIVE';
  else if (!qualified.length) tier = 'FAIL';
  // Code capability decides the tier, so a model that writes wrong code or misses a planted bug
  // sits below every model that can do either, however cheap it is.
  else if (codeRoles.length === 2 && !slow && !retried) tier = 'A';
  else if (codeRoles.length) tier = 'B';
  else tier = 'C';

  // The hard tier separates models the easy suite cannot: passing it lifts tier A to A+, and
  // inventing content on real-sized work costs a tier, because that is the failure that burns
  // revisions in a live run.
  const hard = scoreHard(record.hard);
  if (hard.hallucinated && (tier === 'A' || tier === 'B')) tier = tier === 'A' ? 'B' : 'C';
  else if (tier === 'A' && hard.status === 'tested' && hard.quality >= IMPLEMENTER_QUALIFIES_AT) tier = 'A+';
  // A model that abstains between interchangeable candidates stalls every election it sits in, which
  // in a democratic run means no government at all, so it costs a tier however good its code is.
  if (election.overAbstains) tier = ({ 'A+': 'A', A: 'B', B: 'C' } as Partial<Record<Tier, Tier>>)[tier] ?? tier;
  if (tools.noToolUse) tier = ({ 'A+': 'A', A: 'B', B: 'C' } as Partial<Record<Tier, Tier>>)[tier] ?? tier;
  if (hard.status === 'tested') {
    // Cost per useful implementation, now measured on real-sized work as well as the toy cases.
    const hardCost = record.hard!.costUsd;
    const implementerCost = BENCH_CASES.filter((c) => c.role === 'implementer').reduce((sum, c) => sum + (record.cases[c.id]?.costUsd ?? 0), 0);
    const combined = (quality.implementer + hard.quality) / 2;
    effectiveCost.implementer = (implementerCost + hardCost) / Math.max(combined, MIN_QUALITY_FOR_COST);
  }
  const totalCostUsd = record.costUsd + (record.hard?.costUsd ?? 0) + (record.election?.costUsd ?? 0) + (record.tools?.costUsd ?? 0);

  return {
    record,
    quality,
    effectiveCost,
    overallEffectiveCost: totalCostUsd / Math.max(meanQuality, MIN_QUALITY_FOR_COST),
    roles,
    hallucinated,
    slow,
    retried,
    medianLatencyMs,
    maxLatencyMs: latencies.length ? Math.max(...latencies) : 0,
    failures,
    hard,
    election,
    tools,
    totalCostUsd,
    tier,
  };
}

const TIER_ORDER: Record<Tier, number> = { 'A+': 0, A: 1, B: 2, C: 3, FAIL: 4, INCONCLUSIVE: 5 };

/** Tier first, so a model that hallucinates or qualifies for nothing always sits below every model
 * that works; within a tier, cheapest measured suite first. */
export function rankScores(scores: readonly ModelScore[]): ModelScore[] {
  return [...scores].sort(
    (a, b) =>
      TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
      a.totalCostUsd - b.totalCostUsd ||
      a.record.outputPricePerMTok - b.record.outputPricePerMTok ||
      a.record.id.localeCompare(b.record.id),
  );
}

// ---------- output ----------

export interface BenchSummary {
  generatedAt: string;
  spentThisRunUsd: number;
  budgetUsd: number;
  perModelUsd: number;
  stoppedReason: string | null;
  sandbox: string;
  skippedOverBudget: string[];
  tooOldCount: number;
}

function usd(value: number): string {
  if (value === 0) return '$0';
  return value < 0.001 ? `$${value.toFixed(6)}` : `$${value.toFixed(4)}`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function renderMarkdown(ranked: readonly ModelScore[], summary: BenchSummary): string {
  const lines: string[] = [
    '# OpenRouter model bench',
    '',
    `Generated ${summary.generatedAt} by \`npm run bench:models\`. Spent this run ${usd(summary.spentThisRunUsd)} of ` +
      `${usd(summary.budgetUsd)} (per-model cap ${usd(summary.perModelUsd)}); sandbox: ${summary.sandbox}.` +
      (summary.stoppedReason ? ` **Stopped: ${summary.stoppedReason}.**` : ''),
    '',
    'Tier A+ also passed the hard tier (a multi-file CLI package and an exact edit in a ~10k-token file). ' +
      'Tier A qualifies as both implementer and reviewer, first time, not slow, with no invented content; B ' +
      'qualifies for at least one of those two code roles; C qualifies only for judgement roles (planner, voter); ' +
      'FAIL hallucinated or qualified for nothing; INCONCLUSIVE hit rate limits or ' +
      'transport faults and is re-tested next run. Within a tier, rows run cheapest to most expensive by measured ' +
      'suite cost across every suite run. Eff. cost is that cost divided by mean role quality, so cheap-but-wrong models ' +
      'look expensive. A hallucination on the hard tier costs one tier, and so does abstaining on more than ' +
      `${Math.round(MAX_ELECTION_ABSTENTION * 100)}% of the Prime Coordinator ballot replayed per constituency (election column). ` +
      `Models that call repository tools in fewer than ${Math.round(MIN_TOOL_CALL_RATE * 100)}% of tool-use cases lose tool-using roles and one tier (tools column).`,
    '',
    '| # | tier | model | free | $/Mtok in/out | suite cost | eff. cost | latency med/max | hard | election | tools | roles | failures |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  ranked.forEach((s, i) => {
    const r = s.record;
    const hardFailures = Object.entries(r.hard?.cases ?? {})
      .filter(([, c]) => !c.ok)
      .map(([id, c]) => `${id}:${c.failureKind}`);
    const flags = [...s.failures, ...hardFailures, ...(s.slow ? ['slow'] : [])];
    lines.push(
      `| ${i + 1} | ${s.tier} | \`${r.id}\` | ${r.free ? 'yes' : ''} | ${r.inputPricePerMTok.toFixed(3)}/${r.outputPricePerMTok.toFixed(3)} | ` +
        `${usd(s.totalCostUsd)} | ${usd(s.overallEffectiveCost)} | ${seconds(s.medianLatencyMs)}/${seconds(s.maxLatencyMs)} | ` +
        `${s.hard.label} | ${s.election.label} | ${s.tools.label} | ${s.roles.join(', ') || '—'} | ${flags.join(', ') || '—'} |`,
    );
  });

  for (const role of ROLES) {
    const best = ranked
      .filter((s) => s.tier !== 'FAIL' && s.tier !== 'INCONCLUSIVE')
      .filter((s) => s.roles.includes(ROLE_KEYS[role][0]!))
      // Tier first, so an A+ model that handled real-sized work outranks a cheaper one only shown
      // to handle the toy cases.
      .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.effectiveCost[role] - b.effectiveCost[role])
      .slice(0, 5);
    lines.push('', `## Best ${role} (by tier, then effective cost)`, '');
    if (!best.length) {
      lines.push('No model qualified.');
      continue;
    }
    lines.push('| model | tier | quality | hard | eff. cost | latency med |', '|---|---|---|---|---|---|');
    for (const s of best) {
      lines.push(`| \`${s.record.id}\` | ${s.tier} | ${s.quality[role].toFixed(2)} | ${s.hard.label} | ${usd(s.effectiveCost[role])} | ${seconds(s.medianLatencyMs)} |`);
    }
  }

  const failed = ranked.filter((s) => s.tier === 'FAIL');
  if (failed.length) {
    lines.push('', '## Failure detail', '');
    for (const s of failed) {
      const details = Object.entries(s.record.cases)
        .filter(([, c]) => !c.ok)
        .map(([id, c]) => `${id} (${c.failureKind}): ${(c.detail ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 140)}`);
      lines.push(`- \`${s.record.id}\`${s.hallucinated ? ' **hallucinated**' : ''} — ${details.join('; ')}`);
    }
  }

  lines.push(
    '',
    '## Not tested',
    '',
    `- ${summary.tooOldCount} models older than the age limit (or undated) were excluded.`,
    `- ${summary.skippedOverBudget.length} models could not fit the suite under the per-model cap` +
      (summary.skippedOverBudget.length ? `: ${summary.skippedOverBudget.map((id) => `\`${id}\``).join(', ')}` : '.'),
    '',
  );
  return lines.join('\n');
}

// ---------- cache ----------

interface BenchFile {
  summary?: BenchSummary;
  /** Rank order: tier first, then cheapest measured suite first — rankScores' own order. */
  ranking?: RankingEntry[];
  /** Raw records, keyed by model id and listed in rank order. */
  results?: Record<string, ModelRecord>;
}

export interface RankingEntry {
  rank: number;
  id: string;
  tier: Tier;
  suiteCostUsd: number;
  effectiveCostUsd: number;
  roles: string[];
}

/** The JSON file, readable as a ranking without re-scoring the raw records. */
export function benchFile(ranked: readonly ModelScore[], summary: BenchSummary): BenchFile {
  return {
    summary,
    ranking: ranked.map((s, i) => ({
      rank: i + 1,
      id: s.record.id,
      tier: s.tier,
      suiteCostUsd: s.totalCostUsd,
      effectiveCostUsd: s.overallEffectiveCost,
      roles: s.roles,
    })),
    results: Object.fromEntries(ranked.map((s) => [s.record.id, s.record])),
  };
}

function loadCache(): Record<string, ModelRecord> {
  if (!existsSync(jsonPath)) return {};
  try {
    return (JSON.parse(readFileSync(jsonPath, 'utf8')) as BenchFile).results ?? {};
  } catch (err) {
    log(`Ignoring unreadable cache at ${jsonPath}: ${String(err)}`);
    return {};
  }
}

/** A cached verdict stands unless it is stale, from an older suite, priced differently now, or was
 * inconclusive. A budget-truncated run is settled — the model costs more per call than the cap
 * allows — and re-testing it would only overspend again. */
export function isReusable(previous: ModelRecord | undefined, model: CatalogModel, now: number, cacheDays: number): boolean {
  if (!previous || previous.suiteVersion !== SUITE_VERSION) return false;
  if (previous.inputPricePerMTok !== model.inputPricePerMTok || previous.outputPricePerMTok !== model.outputPricePerMTok) return false;
  if ((now - Date.parse(previous.testedAt)) / MS_PER_DAY >= cacheDays) return false;
  return !Object.values(previous.cases).some((c) => c.failureKind !== undefined && INCONCLUSIVE_KINDS.has(c.failureKind));
}

// ---------- permanent record ----------

export type HistoryEntry =
  | { type: 'run'; runId: string; startedAt: string; finishedAt: string; argv: string[]; spentUsd: number; budgetUsd: number; stoppedReason: string | null }
  | { type: 'easy'; runId: string; record: Omit<ModelRecord, 'hard' | 'election' | 'tools'> }
  | { type: 'hard'; runId: string; id: string; hard: HardRecord }
  | { type: 'election'; runId: string; id: string; election: ElectionRecord }
  | { type: 'tools'; runId: string; id: string; tools: ToolsRecord };

function appendHistory(entry: HistoryEntry): void {
  appendFileSync(historyPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

// ---------- hard tier selection ----------

const HARD_ELIGIBLE_TIERS: ReadonlySet<Tier> = new Set(['A+', 'A', 'B']);

/** A hard verdict is re-run when missing, from an older hard suite, or inconclusive. */
export function needsHardRun(hard: HardRecord | undefined): boolean {
  const status = scoreHard(hard).status;
  return status === 'not-run' || status === 'inconclusive';
}

function overCapHardRecord(): HardRecord {
  return { suiteVersion: HARD_SUITE_VERSION, status: 'over-cap', maxTokens: 0, cases: {}, costUsd: 0, testedAt: new Date().toISOString() };
}

// ---------- main ----------

interface Flags {
  budget: number;
  perModel: number;
  maxAgeDays: number;
  cacheDays: number;
  limit: number;
  include: string[];
  force: boolean;
  /** Re-score and re-render from the cache without making a single call. */
  renderOnly: boolean;
  /** Also run the hard tier on tier A, then B, models that lack a current hard verdict. */
  hard: boolean;
  forceHard: boolean;
  /** Also replay the Prime Coordinator ballot per constituency on models lacking a current verdict. */
  election: boolean;
  /** Also test the production repository-tool request shape on models lacking a current verdict. */
  tools: boolean;
  freeConcurrency: number;
  paidConcurrency: number;
}

function parseFlags(argv: readonly string[]): Flags {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (flag: string, fallback: number): number => Number(get(flag) ?? fallback);
  return {
    budget: num('--budget', DEFAULTS.budget),
    perModel: num('--per-model', DEFAULTS.perModel),
    maxAgeDays: num('--max-age-days', DEFAULTS.maxAgeDays),
    cacheDays: num('--cache-days', DEFAULTS.cacheDays),
    limit: num('--limit', Infinity),
    include: (get('--include') ?? '').split(',').filter(Boolean),
    force: argv.includes('--force'),
    renderOnly: argv.includes('--render-only'),
    hard: argv.includes('--hard') || argv.includes('--force-hard'),
    forceHard: argv.includes('--force-hard'),
    election: argv.includes('--election'),
    tools: argv.includes('--tools'),
    freeConcurrency: num('--free-concurrency', DEFAULTS.freeConcurrency),
    paidConcurrency: num('--concurrency', DEFAULTS.paidConcurrency),
  };
}

async function main(): Promise<void> {
  dotenv.config({ path: path.join(pluginRoot, '.env') });
  const flags = parseFlags(process.argv.slice(2));
  const client = new OpenRouterClient(process.env.OPENROUTER_API_KEY ?? '');
  const sandbox = await detectSandbox();
  const runPython = pythonRunner(sandbox);
  log(`Sandbox: ${sandbox}${sandbox === 'static' ? ' (bubblewrap unavailable — refusing unsafe APIs instead)' : ''}`);

  const now = Date.now();
  const catalog = await client.listModels();
  const { eligible, tooOld } = selectCandidates(catalog, now, flags.maxAgeDays);
  const included = eligible.filter((m) => matchesInclude(m.id, flags.include));
  log(`Catalog ${catalog.length}; ${eligible.length} eligible (≤${flags.maxAgeDays} days old), ${tooOld.length} too old; ${included.length} selected`);

  const cache = loadCache();
  // Seeded with every eligible model's cached verdict, re-tests overwriting theirs as they finish,
  // so neither an --include subset nor a run interrupted mid-model can drop records from the file.
  const results = new Map<string, ModelRecord>(eligible.filter((m) => cache[m.id]).map((m) => [m.id, cache[m.id]!]));
  const skippedOverBudget: string[] = [];
  const queue: { model: CatalogModel; budget: { maxTokens: number; worstCaseUsd: number } }[] = [];
  let reusedCount = 0;
  for (const model of included) {
    if (!flags.force && isReusable(cache[model.id], model, now, flags.cacheDays)) {
      reusedCount += 1;
      continue;
    }
    const budget = planModelBudget(model, flags.perModel);
    if (!budget) skippedOverBudget.push(model.id);
    else if (!flags.renderOnly && queue.length < flags.limit) queue.push({ model, budget });
  }
  log(`${queue.length} to test, ${reusedCount} reused from cache, ${skippedOverBudget.length} over the per-model cap`);

  const ledger = new SpendLedger(flags.budget);
  const runStartedAt = new Date().toISOString();
  const runId = `run-${runStartedAt}`;
  let stoppedReason: string | null = null;
  const summary = (): BenchSummary => ({
    generatedAt: new Date().toISOString(),
    spentThisRunUsd: ledger.spentUsd,
    budgetUsd: flags.budget,
    perModelUsd: flags.perModel,
    stoppedReason,
    sandbox,
    skippedOverBudget,
    tooOldCount: tooOld.length,
  });
  const writeOutputs = (): ModelScore[] => {
    const ranked = rankScores([...results.values()].map(scoreModel));
    writeFileSync(jsonPath, JSON.stringify(benchFile(ranked, summary()), null, 2), 'utf8');
    writeFileSync(markdownPath, renderMarkdown(ranked, summary()), 'utf8');
    return ranked;
  };

  type Budget = { maxTokens: number; worstCaseUsd: number };
  type Job = { model: CatalogModel; budget: Budget };

  /** Runs jobs with each one's worst case reserved against the global cap before it starts. */
  const runPhase = async (
    label: string,
    phase: readonly Job[],
    concurrency: number,
    work: (job: Job) => Promise<{ costUsd: number; line: string }>,
  ): Promise<void> => {
    const startedAt = Date.now();
    let completed = 0;
    await mapWithConcurrency(phase, concurrency, async (job) => {
      if (stoppedReason) return;
      if (!ledger.tryReserve(job.budget.worstCaseUsd)) {
        stoppedReason = `global budget of ${usd(flags.budget)} reached`;
        log(`STOP: ${stoppedReason} — ${job.model.id} (worst case ${usd(job.budget.worstCaseUsd)}) not started`);
        return;
      }
      let outcome: { costUsd: number; line: string };
      try {
        outcome = await work(job);
      } catch (err) {
        ledger.settle(job.budget.worstCaseUsd, 0);
        throw err;
      }
      ledger.settle(job.budget.worstCaseUsd, outcome.costUsd);
      writeOutputs();
      completed += 1;
      const elapsedMs = Date.now() - startedAt;
      const etaMs = (elapsedMs / completed) * (phase.length - completed);
      log(
        `${label}[${completed}/${phase.length}] ${outcome.line} cost=${usd(outcome.costUsd)} ` +
          `— spent ${usd(ledger.spentUsd)}/${usd(flags.budget)}, elapsed ${Math.round(elapsedMs / 1000)}s, eta ${Math.round(etaMs / 1000)}s`,
      );
    });
  };

  const easyWork = async ({ model, budget }: Job): Promise<{ costUsd: number; line: string }> => {
    const record = await benchModel(client, model, budget, flags.perModel, runPython);
    appendHistory({ type: 'easy', runId, record });
    results.set(model.id, record);
    const score = scoreModel(record);
    return {
      costUsd: record.costUsd,
      line: `${score.tier} ${model.id} roles=${score.roles.join('/') || '-'}${score.failures.length ? ` fails=${score.failures.join(',')}` : ''}`,
    };
  };

  // Free models first, at low concurrency: OpenRouter rate-limits :free ids per minute and per day.
  await runPhase('', queue.filter((q) => isFree(q.model)), flags.freeConcurrency, easyWork);
  await runPhase('', queue.filter((q) => !isFree(q.model)), flags.paidConcurrency, easyWork);

  if (flags.tools && !flags.renderOnly && !stoppedReason) {
    const catalogById = new Map(included.map((model) => [model.id, model]));
    const toolsQueue: Job[] = [];
    for (const score of rankScores([...results.values()].filter((record) => catalogById.has(record.id)).map(scoreModel))) {
      if (score.tools.status === 'tested') continue;
      const model = catalogById.get(score.record.id)!;
      const budget = planModelBudget(model, flags.perModel, TOOLS_SHAPE);
      if (budget) toolsQueue.push({ model, budget });
    }
    log(`Tools: ${toolsQueue.length} models to test`);
    const toolsWork = async ({ model, budget }: Job): Promise<{ costUsd: number; line: string }> => {
      const tools = await benchTools(client, model, budget, flags.perModel);
      appendHistory({ type: 'tools', runId, id: model.id, tools });
      const before = scoreModel(results.get(model.id)!).tier;
      const record = { ...results.get(model.id)!, tools };
      results.set(model.id, record);
      const after = scoreModel(record);
      return { costUsd: tools.costUsd, line: `${before}->${after.tier} ${model.id} tools=${after.tools.label}` };
    };
    await runPhase('TOOLS ', toolsQueue.filter((job) => isFree(job.model)), flags.freeConcurrency, toolsWork);
    await runPhase('TOOLS ', toolsQueue.filter((job) => !isFree(job.model)), flags.paidConcurrency, toolsWork);
  }

  if (flags.hard && !flags.renderOnly && !stoppedReason) {
    if (sandbox !== 'bwrap') {
      log('Hard tier skipped: it runs generated multi-file packages, which needs the bubblewrap sandbox');
    } else {
      // Tier A first, then B, each cheapest first — rankScores' own order.
      const catalogById = new Map(included.map((m) => [m.id, m]));
      const hardQueue: Job[] = [];
      for (const score of rankScores([...results.values()].filter((r) => catalogById.has(r.id)).map(scoreModel))) {
        if (!HARD_ELIGIBLE_TIERS.has(score.tier)) continue;
        if (!flags.forceHard && !needsHardRun(score.record.hard)) continue;
        const model = catalogById.get(score.record.id)!;
        const budget = planModelBudget(model, flags.perModel, HARD_SHAPE);
        if (!budget) {
          const hard = overCapHardRecord();
          appendHistory({ type: 'hard', runId, id: model.id, hard });
          results.set(model.id, { ...score.record, hard });
          continue;
        }
        hardQueue.push({ model, budget });
      }
      log(`Hard tier: ${hardQueue.length} models to test (tier A first, then B, cheapest first)`);
      const hardWork = async ({ model, budget }: Job): Promise<{ costUsd: number; line: string }> => {
        const hard = await benchHard(client, model, budget, flags.perModel, runPython);
        appendHistory({ type: 'hard', runId, id: model.id, hard });
        const before = scoreModel(results.get(model.id)!).tier;
        const record = { ...results.get(model.id)!, hard };
        results.set(model.id, record);
        const after = scoreModel(record);
        return { costUsd: hard.costUsd, line: `${before}->${after.tier} ${model.id} hard=${after.hard.label}` };
      };
      await runPhase('HARD ', hardQueue.filter((q) => isFree(q.model)), flags.freeConcurrency, hardWork);
      await runPhase('HARD ', hardQueue.filter((q) => !isFree(q.model)), flags.paidConcurrency, hardWork);
    }
  }

  if (flags.election && !flags.renderOnly && !stoppedReason) {
    const catalogById = new Map(included.map((m) => [m.id, m]));
    const electionQueue: Job[] = [];
    for (const score of rankScores([...results.values()].filter((r) => catalogById.has(r.id)).map(scoreModel))) {
      if (score.tier === 'FAIL' || score.tier === 'INCONCLUSIVE') continue;
      if (score.election.status === 'tested') continue;
      const model = catalogById.get(score.record.id)!;
      const budget = planModelBudget(model, flags.perModel, ELECTION_SHAPE);
      if (budget) electionQueue.push({ model, budget });
    }
    log(`Election: ${electionQueue.length} models to test`);
    const electionWork = async ({ model, budget }: Job): Promise<{ costUsd: number; line: string }> => {
      const election = await benchElection(client, model, budget, flags.perModel, runPython);
      appendHistory({ type: 'election', runId, id: model.id, election });
      const before = scoreModel(results.get(model.id)!).tier;
      const record = { ...results.get(model.id)!, election };
      results.set(model.id, record);
      const after = scoreModel(record);
      return { costUsd: election.costUsd, line: `${before}->${after.tier} ${model.id} election=${after.election.label}` };
    };
    await runPhase('ELECTION ', electionQueue.filter((q) => isFree(q.model)), flags.freeConcurrency, electionWork);
    await runPhase('ELECTION ', electionQueue.filter((q) => !isFree(q.model)), flags.paidConcurrency, electionWork);
  }

  const ranked = writeOutputs();
  if (!flags.renderOnly) appendHistory({
    type: 'run',
    runId,
    startedAt: runStartedAt,
    finishedAt: new Date().toISOString(),
    argv: process.argv.slice(2),
    spentUsd: ledger.spentUsd,
    budgetUsd: flags.budget,
    stoppedReason,
  });
  process.stdout.write(`\n${renderMarkdown(ranked, summary())}\n`);
  log(`Spent ${usd(ledger.spentUsd)} this run. Wrote ${jsonPath} and ${markdownPath}`);
}

const entryPath = process.argv[1];
if (entryPath && path.resolve(entryPath) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[model-bench] FATAL: ${String(err?.stack ?? err)}\n`);
    process.exitCode = 1;
  });
}
