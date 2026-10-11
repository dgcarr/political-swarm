// Functionally probes OpenRouter models against the two schemas the swarm actually breaks on.
//
// config/models.yaml's header records that its roster was "probed against the implementer and
// planner schemas ... using the request shape WorkerDispatcher sends, with no corrective retries".
// That probe was done by hand and never committed, so the roster could only be re-verified by
// repeating it by hand. This is that probe, made repeatable.
//
// It is deliberately different from modelsSmoke.ts, which compares config/models.yaml's declared
// metadata against the catalog and spends nothing. Metadata agreement is not capability: a model
// can advertise response_format and still return prose, fenced code, or JSON that fails the
// engine's own validator. Only a real completion answers that, so this one spends money.
//
// The verdict is deliberately strict — first attempt only. WorkerDispatcher's corrective-retry
// loop can rescue a bad first answer, but every retry is a real cost paid on every run, and the
// first-attempt rate is what separates a model that works from one that merely can be made to.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { OpenRouterClient, type CatalogModel } from '../engine/OpenRouterClient.js';
import { extractJson } from '../util/jsonSchema.js';
import { jsonResponseSuffix } from '../engine/WorkerDispatcher.js';
import type { ModelEntry } from '../util/config.js';
// The managerial strategy is the benchmark's neutral control — using its prompts keeps any
// doctrine-specific phrasing out of a verdict that every doctrine depends on.
import {
  PLANNER_SCHEMA_DESCRIPTION,
  validatePlannerOutput,
  IMPLEMENTER_SCHEMA_DESCRIPTION,
  validateImplementerOutput,
} from '../strategies/managerial/prompts.js';
import { log as createLog } from './harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '../../..');
const outputPath = path.join(pluginRoot, 'config', 'model-probe.json');

const log = createLog('model-probe');

const DEFAULT_CONCURRENCY = 8;
const PROBE_TIMEOUT_MS = 60_000;
const PROBE_TEMPERATURE = 0;
const PROGRESS_EVERY = 1;
// The catalog churns constantly — models appear, get re-pointed at new weights, and change price.
// A verdict older than this is re-earned rather than trusted.
const DEFAULT_MAX_AGE_DAYS = 30;
// A timeout or transport fault is a statement about the provider that hour, not about the model,
// so it expires far sooner than a real verdict — otherwise one congested afternoon blacklists a
// good model for a month.
const TRANSIENT_MAX_AGE_DAYS = 1;
const MS_PER_DAY = 86_400_000;

export interface ProbeCase {
  id: 'planner' | 'implementer';
  systemPrompt: string;
  userPrompt: string;
  schemaDescription: string;
  validate: (value: unknown) => void;
}

// Small on purpose. The probe measures whether a model can return this shape at all, not whether
// it can solve a hard problem — a large task would conflate capability with instruction-following
// and make a slow model look broken.
export const PROBE_CASES: ProbeCase[] = [
  {
    id: 'planner',
    systemPrompt: 'You are a planner. Break the request into a small dependency-ordered task graph.',
    userPrompt: 'Plan exactly two tasks for building a Python CLI that reads a YAML file and writes a CSV.',
    schemaDescription: PLANNER_SCHEMA_DESCRIPTION,
    validate: validatePlannerOutput,
  },
  {
    id: 'implementer',
    systemPrompt: 'You are an implementer. Return file operations that satisfy the task.',
    userPrompt:
      'Create a file named hello.py containing a function greet(name) that returns "Hello, " followed by the name. ' +
      'Include a short rationale.',
    schemaDescription: IMPLEMENTER_SCHEMA_DESCRIPTION,
    validate: validateImplementerOutput,
  },
];

export type FailureKind = 'timeout' | 'transport' | 'capability-mismatch' | 'unparseable' | 'schema';

export interface CaseResult {
  ok: boolean;
  failureKind?: FailureKind;
  detail?: string;
  latencyMs: number;
  costUsd: number;
}

export interface ModelProbeResult {
  id: string;
  supportsJsonMode: boolean;
  supportsToolCalls: boolean;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  contextLength: number | null;
  cases: Record<string, CaseResult>;
  /** Usable only when every probe case passed on its first attempt. */
  verified: boolean;
  costUsd: number;
  /** When this verdict was earned — the basis for expiring it. */
  probedAt: string;
}

export interface ProbeCache {
  probedAt?: string;
  results?: Record<string, ModelProbeResult>;
}

export type ProbeReason = 'new' | 'stale' | 'transient-retry' | 'metadata-changed';

export interface ProbeSelection {
  toProbe: { model: CatalogModel; reason: ProbeReason }[];
  reused: ModelProbeResult[];
}

function ageDays(probedAt: string | undefined, now: number): number {
  if (!probedAt) return Infinity;
  const at = Date.parse(probedAt);
  return Number.isNaN(at) ? Infinity : (now - at) / MS_PER_DAY;
}

function hadTransientFailure(result: ModelProbeResult): boolean {
  return Object.values(result.cases).some(
    (c) => !c.ok && (c.failureKind === 'timeout' || c.failureKind === 'transport'),
  );
}

/** Decides which candidates need a live probe and which can reuse a cached verdict.
 *
 * Models the caller no longer offers are simply absent from `candidates`, so a model pulled from
 * the catalog drops out of the rewritten cache without needing an explicit prune step. */
export function selectModelsToProbe(
  candidates: readonly CatalogModel[],
  cache: ProbeCache,
  now: number,
  options: { maxAgeDays: number; force: boolean },
): ProbeSelection {
  const cached = cache.results ?? {};
  const toProbe: { model: CatalogModel; reason: ProbeReason }[] = [];
  const reused: ModelProbeResult[] = [];

  for (const model of candidates) {
    const previous = cached[model.id];
    if (options.force || !previous) {
      toProbe.push({ model, reason: previous ? 'stale' : 'new' });
      continue;
    }
    // Price and capability flags come from the catalog, so a change means the id now points at
    // something the last verdict did not describe. Re-earn it rather than carry the old answer over.
    const metadataChanged =
      previous.supportsJsonMode !== model.supportsJsonMode ||
      previous.supportsToolCalls !== model.supportsToolCalls ||
      previous.inputPricePerMTok !== model.inputPricePerMTok ||
      previous.outputPricePerMTok !== model.outputPricePerMTok;
    if (metadataChanged) {
      toProbe.push({ model, reason: 'metadata-changed' });
      continue;
    }
    const age = ageDays(previous.probedAt, now);
    if (age >= options.maxAgeDays) {
      toProbe.push({ model, reason: 'stale' });
      continue;
    }
    if (hadTransientFailure(previous) && age >= TRANSIENT_MAX_AGE_DAYS) {
      toProbe.push({ model, reason: 'transient-retry' });
      continue;
    }
    reused.push(previous);
  }

  return { toProbe, reused };
}

function loadCache(filePath: string): ProbeCache {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as ProbeCache;
  } catch (err) {
    log(`Ignoring unreadable cache at ${filePath}: ${String(err)}`);
    return {};
  }
}

/** Classifies a thrown probe error into the reason a roster maintainer would act on differently:
 * a timeout or transport fault may be provider congestion and is worth retrying another day, while
 * an unparseable or schema-violating answer is a property of the model itself. */
export function classifyFailure(error: unknown, timedOut: boolean): { kind: FailureKind; detail: string } {
  const detail = String((error as Error)?.message ?? error);
  // The client reports a timeout through its result flag on success and by throwing on failure, so
  // the message has to be consulted too — reading the flag alone silently files every timed-out
  // model under "schema", which is a verdict about the model rather than about that afternoon.
  if (timedOut || /\btimed? ?out\b|\bAbortError\b|aborted/i.test(detail)) return { kind: 'timeout', detail };
  // The exact class the whole roster-verification effort exists to catch: the catalog advertises a
  // capability the provider then refuses. Distinct from transport because the fix is a metadata
  // correction, not a retry.
  if (/JSON mode is not enabled|response_format|does not support.*(json|tool)/i.test(detail)) {
    return { kind: 'capability-mismatch', detail };
  }
  // extractJson throws when nothing JSON-shaped could be recovered from the response at all;
  // the validators throw once a value was parsed but did not match the schema.
  if (/no JSON|Unexpected token|JSON at position|Unterminated/i.test(detail)) {
    return { kind: 'unparseable', detail };
  }
  if (/HTTP \d|OpenRouter \d{3}|fetch|network|ECONN|socket/i.test(detail)) return { kind: 'transport', detail };
  return { kind: 'schema', detail };
}

/** Builds the exact two-message shape WorkerDispatcher.dispatchToModel sends, so a verdict here
 * means the same thing it would mean during a real run. Kept in sync by construction: any change
 * to the dispatcher's framing must be mirrored here or the probe stops predicting live behaviour. */
export function buildProbeMessages(
  probeCase: Pick<ProbeCase, 'systemPrompt' | 'userPrompt' | 'schemaDescription'>,
  /** The dispatcher role this case stands in for, which decides the JSON suffix it receives. */
  role?: string,
): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: probeCase.systemPrompt },
    {
      role: 'user',
      content:
        `${probeCase.userPrompt}\n\n${jsonResponseSuffix(probeCase.schemaDescription, role)}`,
    },
  ];
}

async function runCase(
  client: OpenRouterClient,
  model: CatalogModel,
  probeCase: ProbeCase,
): Promise<CaseResult> {
  const modelEntry: ModelEntry = {
    inputPricePerMTok: model.inputPricePerMTok,
    outputPricePerMTok: model.outputPricePerMTok,
    supportsJsonMode: model.supportsJsonMode,
    supportsToolCalls: model.supportsToolCalls,
  };

  const startedAt = Date.now();
  let costUsd = 0;
  let timedOut = false;
  try {
    const result = await client.chatCompletion({
      model: model.id,
      modelEntry,
      messages: buildProbeMessages(probeCase, probeCase.id),
      jsonMode: model.supportsJsonMode,
      timeoutMs: PROBE_TIMEOUT_MS,
      temperature: PROBE_TEMPERATURE,
    });
    costUsd = result.costUsd;
    timedOut = result.timedOut;
    // Identical to WorkerDispatcher's success path: extract, then validate. No corrective retry.
    probeCase.validate(extractJson(result.text));
    return { ok: true, latencyMs: Date.now() - startedAt, costUsd };
  } catch (err) {
    const { kind, detail } = classifyFailure(err, timedOut);
    return {
      ok: false,
      failureKind: kind,
      detail: detail.slice(0, 300),
      latencyMs: Date.now() - startedAt,
      costUsd,
    };
  }
}

async function probeModel(client: OpenRouterClient, model: CatalogModel): Promise<ModelProbeResult> {
  const cases: Record<string, CaseResult> = {};
  for (const probeCase of PROBE_CASES) {
    cases[probeCase.id] = await runCase(client, model, probeCase);
  }
  return {
    id: model.id,
    supportsJsonMode: model.supportsJsonMode,
    supportsToolCalls: model.supportsToolCalls,
    inputPricePerMTok: model.inputPricePerMTok,
    outputPricePerMTok: model.outputPricePerMTok,
    contextLength: model.contextLength,
    cases,
    verified: PROBE_CASES.every((c) => cases[c.id]?.ok),
    costUsd: Object.values(cases).reduce((sum, c) => sum + c.costUsd, 0),
    probedAt: new Date().toISOString(),
  };
}

/** Runs `worker` over `items` with at most `limit` in flight. Probing is embarrassingly parallel
 * and entirely network-bound; serially this sweep takes over an hour for a full catalog. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

function parseFlags(argv: readonly string[]): {
  concurrency: number;
  maxInputPrice: number | null;
  maxAgeDays: number;
  force: boolean;
} {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const maxPrice = get('--max-input-price');
  return {
    concurrency: Number(get('--concurrency') ?? DEFAULT_CONCURRENCY),
    maxInputPrice: maxPrice === undefined ? null : Number(maxPrice),
    maxAgeDays: Number(get('--max-age-days') ?? DEFAULT_MAX_AGE_DAYS),
    force: argv.includes('--force'),
  };
}

async function main(): Promise<void> {
  dotenv.config({ path: path.join(pluginRoot, '.env') });
  const { concurrency, maxInputPrice, maxAgeDays, force } = parseFlags(process.argv.slice(2));

  const client = new OpenRouterClient(process.env.OPENROUTER_API_KEY ?? '');
  const catalog = await client.listModels();
  log(`OpenRouter catalog: ${catalog.length} models`);

  // A model advertising neither response_format nor tool calls has no structural guarantee at all,
  // so the dispatcher could only ever reach it through the prompt-and-retry path. Not roster material.
  //
  // Negative pricing is OpenRouter's sentinel for "not known upfront", used by the dynamic routers
  // (openrouter/auto and friends). They are excluded on two counts: BudgetGuard cannot account for
  // a price it does not know — a probe of openrouter/auto reported a cost of -$1501 — and a router
  // that resolves to a different model per call cannot carry a per-model verdict anyway.
  const priced = catalog.filter((m) => m.inputPricePerMTok >= 0 && m.outputPricePerMTok >= 0);
  if (priced.length !== catalog.length) {
    log(`Excluding ${catalog.length - priced.length} models with unknown (negative) pricing, e.g. dynamic routers`);
  }
  // ":batch" ids address OpenRouter's asynchronous batch API, which does not answer a synchronous
  // chat completion at all — all 61 in the catalog failed the first full sweep on transport, which
  // was 122 wasted calls and two thirds of every transport failure recorded. The dispatcher has no
  // path to them regardless, so they are not roster material.
  const synchronous = priced.filter((m) => !m.id.endsWith(':batch'));
  if (synchronous.length !== priced.length) {
    log(`Excluding ${priced.length - synchronous.length} ":batch" ids — asynchronous API, not reachable by the dispatcher`);
  }
  const candidates = synchronous
    .filter((m) => m.supportsJsonMode || m.supportsToolCalls)
    .filter((m) => maxInputPrice === null || m.inputPricePerMTok <= maxInputPrice);

  const cache = loadCache(outputPath);
  const { toProbe, reused } = selectModelsToProbe(candidates, cache, Date.now(), { maxAgeDays, force });
  const cachedCount = Object.keys(cache.results ?? {}).length;
  const dropped = cachedCount - reused.length - toProbe.filter((t) => t.reason !== 'new').length;

  log(
    `${candidates.length} candidates: ${toProbe.length} to probe, ${reused.length} reused from cache` +
      (dropped > 0 ? `, ${dropped} dropped (no longer in catalog)` : ''),
  );
  if (toProbe.length) {
    const byReason = toProbe.reduce<Record<string, number>>((acc, t) => {
      acc[t.reason] = (acc[t.reason] ?? 0) + 1;
      return acc;
    }, {});
    log(`Reasons: ${Object.entries(byReason).map(([r, n]) => `${r}=${n}`).join(', ')}`);
  } else {
    log('Cache is current — nothing to probe. Use --force to re-probe anyway.');
  }

  const startedAt = Date.now();
  let completed = 0;
  const probed = await mapWithConcurrency(toProbe, concurrency, async ({ model }) => {
    const result = await probeModel(client, model);
    completed += 1;
    if (completed % PROGRESS_EVERY === 0) {
      const elapsedMs = Date.now() - startedAt;
      const etaMs = (elapsedMs / completed) * (toProbe.length - completed);
      const failed = PROBE_CASES.filter((c) => !result.cases[c.id]?.ok)
        .map((c) => `${c.id}:${result.cases[c.id]?.failureKind}`)
        .join(',');
      log(
        `[${completed}/${toProbe.length}] ${result.verified ? 'PASS' : `FAIL(${failed})`} ${result.id} ` +
          `— elapsed ${Math.round(elapsedMs / 1000)}s, eta ${Math.round(etaMs / 1000)}s`,
      );
    }
    return result;
  });

  const results = [...reused, ...probed].sort((a, b) => a.id.localeCompare(b.id));
  const verified = results.filter((r) => r.verified);
  const spendThisRun = probed.reduce((sum, r) => sum + r.costUsd, 0);

  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        probedAt: new Date().toISOString(),
        catalogSize: catalog.length,
        probed: results.length,
        verifiedCount: verified.length,
        lastRunProbed: probed.length,
        lastRunCostUsd: spendThisRun,
        maxAgeDays,
        cases: PROBE_CASES.map((c) => c.id),
        note:
          'verified = every probe case parsed and validated on the FIRST attempt, no corrective retries. ' +
          'Entries carry their own probedAt and are re-probed when older than maxAgeDays, when catalog ' +
          'metadata changes, or (sooner) when the last failure was a timeout or transport fault.',
        results: Object.fromEntries(results.map((r) => [r.id, r])),
      },
      null,
      2,
    ),
    'utf8',
  );

  log(`\n${verified.length}/${results.length} models verified (${probed.length} probed this run).`);
  log(`Probe spend this run: $${spendThisRun.toFixed(4)}`);
  log(`Wrote ${outputPath}`);
}

const entryPath = process.argv[1];
if (entryPath && path.resolve(entryPath) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[model-probe] FATAL: ${String(err?.stack ?? err)}\n`);
    process.exitCode = 1;
  });
}
