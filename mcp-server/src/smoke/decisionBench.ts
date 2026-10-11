// Benches decision models (OpenRouter's Decisions API) on the two jobs the swarm gives them:
//
// 1. Elections. The real Prime Coordinator ballot, once per constituency, among interchangeable
//    candidates. A ballot that abstains for want of a preference leaves an office empty, so the
//    abstention rate is reported, as the chat-model bench reports it.
// 2. Verdicts. A labelled set of sound and defective changes. The phase-2 fast path takes an
//    approval without a written rationale when its probability clears a floor, so what matters is,
//    for each candidate floor, how many sound changes clear it and how many defective ones do —
//    a defective change approved on the fast path is a defect shipped without review.
//
// Usage: npm run bench:decisions [-- --include upstage/solar-decide,typesafe/jev-1.13]
// Writes config/decision-bench.json and config/decision-bench.md. Spends a few cents at most:
// input tokens only, output is free on these models.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { OpenRouterClient, type DecisionAnswer } from '../engine/OpenRouterClient.js';
import { isDecisionModel, loadModelsConfig } from '../util/config.js';
import { coordinatorBallotSystemPrompt } from '../strategies/democratic/prompts.js';
import { LABELLED_REVIEWS, VERDICT_QUESTION } from './decisionBenchCases.js';
import { log as createLog } from './harness.js';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const configDir = path.join(pluginRoot, 'config');
const log = createLog('decision-bench');
const TIMEOUT_MS = 30_000;
export const FLOORS = [0.6, 0.7, 0.8, 0.85, 0.9, 0.95] as const;

const CONSTITUENCIES = ['frontend', 'backend', 'data', 'security', 'testing', 'documentation', 'user-experience', 'operations'];
const CANDIDATES = ['prime-coordinator-t1c1', 'prime-coordinator-t1c2', 'prime-coordinator-t1c3'];

export interface VerdictRecord {
  id: string;
  expected: 'approve' | 'reject';
  choice: string;
  pApprove: number;
}

export interface FloorStats {
  floor: number;
  /** Sound changes approved on the fast path, of all sound changes. */
  fastPathSound: number;
  /** Defective changes approved on the fast path: shipped without a written review. */
  fastPathDefective: number;
}

export interface DecisionModelReport {
  model: string;
  abstained: number;
  ballots: number;
  accuracy: number;
  /** Mean squared error of p(approve) against the label (approve = 1). Lower is better. */
  brier: number;
  floors: FloorStats[];
  /** The lowest floor at which no defective change took the fast path, if any did not. */
  safeFloor: number | null;
  costUsd: number;
  medianLatencyMs: number;
  errors: string[];
}

export function scoreVerdicts(verdicts: readonly VerdictRecord[]): Pick<DecisionModelReport, 'accuracy' | 'brier' | 'floors' | 'safeFloor'> {
  const correct = verdicts.filter((v) => (v.expected === 'approve') === (v.choice === 'approve')).length;
  const brier = verdicts.reduce((sum, v) => sum + (v.pApprove - (v.expected === 'approve' ? 1 : 0)) ** 2, 0) / Math.max(verdicts.length, 1);
  const floors = FLOORS.map((floor) => ({
    floor,
    fastPathSound: verdicts.filter((v) => v.expected === 'approve' && v.choice === 'approve' && v.pApprove >= floor).length,
    fastPathDefective: verdicts.filter((v) => v.expected === 'reject' && v.choice === 'approve' && v.pApprove >= floor).length,
  }));
  const safe = floors.find((f) => f.fastPathDefective === 0);
  return { accuracy: correct / Math.max(verdicts.length, 1), brier, floors, safeFloor: safe ? safe.floor : null };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2) : 0;
}

async function benchModel(client: OpenRouterClient, model: string, entry: ReturnType<typeof loadModelsConfig>['models'][string]): Promise<DecisionModelReport> {
  let costUsd = 0;
  const latencies: number[] = [];
  const errors: string[] = [];
  const ask = async (state: Parameters<OpenRouterClient['decide']>[0]['state'], question: Parameters<OpenRouterClient['decide']>[0]['questions'][string]): Promise<DecisionAnswer | undefined> => {
    const started = Date.now();
    try {
      const result = await client.decide({ model, modelEntry: entry, state, questions: { q: question }, timeoutMs: TIMEOUT_MS });
      costUsd += result.costUsd;
      latencies.push(Date.now() - started);
      return result.answers.q;
    } catch (err) {
      errors.push(String(err).slice(0, 160));
      return undefined;
    }
  };

  const ballots = await Promise.all(CONSTITUENCIES.map((constituency) => ask(
    { constituency, candidates: CANDIDATES.map((candidate) => ({ candidate, score: 0.5 })) },
    {
      type: 'choice',
      instructions: coordinatorBallotSystemPrompt(constituency),
      criteria: { ...Object.fromEntries(CANDIDATES.map((c) => [c, `Vote for ${c}.`])), abstain: 'You hold a specific objection to every candidate.' },
    },
  )));
  const answeredBallots = ballots.filter((b): b is DecisionAnswer & { type: 'choice' } => b?.type === 'choice');

  const verdicts: VerdictRecord[] = [];
  await Promise.all(LABELLED_REVIEWS.map(async (review) => {
    const answer = await ask(review.state, VERDICT_QUESTION);
    if (answer?.type !== 'choice') return;
    verdicts.push({ id: review.id, expected: review.expected, choice: answer.choice, pApprove: answer.probabilities.approve ?? 0 });
  }));

  return {
    model,
    abstained: answeredBallots.filter((b) => b.choice === 'abstain').length,
    ballots: answeredBallots.length,
    ...scoreVerdicts(verdicts),
    costUsd,
    medianLatencyMs: median(latencies),
    errors,
  };
}

export function renderReport(reports: readonly DecisionModelReport[], generatedAt: string): string {
  const lines = [
    '# Decision-model bench',
    '',
    `Generated ${generatedAt} by \`npm run bench:decisions\`. Elections: the real Prime Coordinator ballot for 8 ` +
      `constituencies among equal candidates. Verdicts: ${LABELLED_REVIEWS.length} labelled changes, half with one ` +
      'concrete defect. "Fast path" is an approval whose p(approve) clears the floor and so stands without a written ' +
      'review; a defective change on the fast path ships unreviewed. The safe floor is the lowest with none.',
    '',
    '| model | abstained | accuracy | Brier | safe floor | cost | latency med | errors |',
    '|---|---|---|---|---|---|---|---|',
    ...reports.map((r) => `| \`${r.model}\` | ${r.abstained}/${r.ballots} | ${(r.accuracy * 100).toFixed(0)}% | ` +
      `${r.brier.toFixed(3)} | ${r.safeFloor ?? 'none'} | $${r.costUsd.toFixed(5)} | ${(r.medianLatencyMs / 1000).toFixed(1)}s | ${r.errors.length} |`),
  ];
  for (const r of reports) {
    const sound = LABELLED_REVIEWS.filter((c) => c.expected === 'approve').length;
    const bad = LABELLED_REVIEWS.length - sound;
    lines.push('', `## \`${r.model}\` fast path by floor`, '', '| floor | sound approved unexplained | defective approved unexplained |', '|---|---|---|');
    for (const f of r.floors) lines.push(`| ${f.floor} | ${f.fastPathSound}/${sound} | ${f.fastPathDefective}/${bad} |`);
  }
  return `${lines.join('\n')}\n`;
}

export async function main(): Promise<void> {
  dotenv.config({ path: path.join(pluginRoot, '.env') });
  const argv = process.argv.slice(2);
  const includeIndex = argv.indexOf('--include');
  const config = loadModelsConfig(configDir);
  const models = includeIndex >= 0
    ? argv[includeIndex + 1]!.split(',').filter(Boolean)
    : Object.entries(config.models).filter(([, entry]) => isDecisionModel(entry)).map(([id]) => id);
  const client = new OpenRouterClient(process.env.OPENROUTER_API_KEY ?? '');
  const reports: DecisionModelReport[] = [];
  for (const [index, model] of models.entries()) {
    const entry = config.models[model] ?? { inputPricePerMTok: 0.1, outputPricePerMTok: 0, supportsJsonMode: false, supportsToolCalls: false, api: 'decisions' as const };
    const started = Date.now();
    const report = await benchModel(client, model, entry);
    reports.push(report);
    log(`[${index + 1}/${models.length}] ${model}: abstained ${report.abstained}/${report.ballots}, accuracy ${(report.accuracy * 100).toFixed(0)}%, ` +
      `safe floor ${report.safeFloor ?? 'none'}, $${report.costUsd.toFixed(5)}, ${Math.round((Date.now() - started) / 1000)}s`);
  }
  const generatedAt = new Date().toISOString();
  writeFileSync(path.join(configDir, 'decision-bench.json'), JSON.stringify({ generatedAt, reports }, null, 2), 'utf8');
  writeFileSync(path.join(configDir, 'decision-bench.md'), renderReport(reports, generatedAt), 'utf8');
  process.stdout.write(`\n${renderReport(reports, generatedAt)}`);
}

const entryPath = process.argv[1];
if (entryPath && path.resolve(entryPath) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[decision-bench] FATAL: ${String(err?.stack ?? err)}\n`);
    process.exitCode = 1;
  });
}
