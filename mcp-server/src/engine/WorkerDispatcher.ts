import { failureLocations, renderFailureLocations } from './failureLocation.js';
import { renderRepairBrief } from './repairBrief.js';
import type { OpenRouterClient, ChatMessage, ChatCompletionResult, DecideOptions, DecisionAnswer, DecisionQuestion } from './OpenRouterClient.js';
import { isDecisionModel, type ModelEntry, type ModelsConfig, type ReviewCommand } from '../util/config.js';
import type { CheckSandbox } from '../util/sandbox.js';
import { extractJson, JsonValidationError } from '../util/jsonSchema.js';
import type { Ledger } from './Ledger.js';
import { BudgetExceededError, type BudgetGuard } from './BudgetGuard.js';
import type { RunState } from './RunStore.js';
import { logger } from '../util/logger.js';
import { placeholderFileWrites, editsAgainstMissingFiles } from './placeholderBody.js';
import { editsWithUnmatchedFind, unmatchedEditMessage } from './editMatch.js';
import { createHash } from 'node:crypto';
import type { OwnershipMap } from './packets.js';
import { criteriaAheadOfTheirOwners, dependencyCycle, missingOwnedSources, otherOwners, planWithoutTests, readingOnlyTasks, undeclaredPaths } from './ownership.js';
import type { RepoWorktree, RepositoryOverlay } from './RepoWorktree.js';
import {
  executeRepositoryTool,
  executeReviewCommand,
  REPOSITORY_TOOL_DEFINITIONS,
  reviewCommandToolDefinition,
  RUN_REVIEW_COMMAND,
} from './repositoryTools.js';
import { pathsWithForbiddenControlCharacters } from './fileOpHygiene.js';


/** sha256 of a value's JSON, so a ledger entry pins exactly what a model was shown and said. */
export function contentDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined', 'utf8').digest('hex');
}

export interface DispatchOptions {
  role: string;
  /** Institution-owned calls may use a reviewer/generalist model without becoming engineering work. */
  phase?: 'engineering' | 'institutional';
  /** Disable exploratory repository reads when the decision prompt already contains its evidence. */
  repositoryTools?: boolean;
  /**
   * False omits the repository inventory, interfaces and fallback bundle as well, for a call that
   * judges nothing in the repository. A two-line office ballot otherwise went out inside ~15k
   * characters of TASK.md and data previews, and solar-mini4 abstained on all eight ballots of a
   * Prime Coordinator election that it decided every time without them.
   */
  repositoryContext?: boolean;
  taskId?: string;
  /** The task whose work this call judges, for its scope section only: unlike taskId it neither
   * counts against that task's institutional ceiling nor attributes the spend to it. */
  scopeTaskId?: string;
  systemPrompt: string;
  userPrompt: string;
  /** Human-readable schema description injected into the prompt for the fenced-JSON fallback path. */
  schemaDescription: string;
  /** Runtime validator — throw a descriptive error if the parsed JSON doesn't match expectations. */
  validate: (value: unknown) => void;
  personaId?: string; // for strategies that need multiple distinct "agents" playing one role
  temperature?: number;
  /** Optional provider reasoning tier for decisions where latency matters. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Shorter ceiling for optional work; never extends the configured per-call timeout. */
  timeoutMs?: number;
  /** Exact institutional response that must be reused if this transition is replayed. */
  institutionalReplayKey?: string;
}

export interface DispatchResult<T> {
  value: T;
  raw: string;
  model: string;
  costUsd: number;
  /** This call's own usage, every corrective and tool round included. The run-wide counter cannot
   * stand in for it: concurrent calls each see the other's tokens in its delta. */
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Which bounded decisions go to a decision model first.
 * - off: none; every call site makes its ordinary chat call.
 * - pure: calls whose answer is only the decision (ballots, votes, rulings, allocation). Verdicts
 *   on work always come from a written chat review: the "explain" mode that let a confident
 *   approval skip it was removed after it approved 0 of 61 real managerial reviews.
 */
export type DecisionMode = 'off' | 'pure';

export interface DecideDispatchOptions {
  /** Defaults to 'decider' in config/models.yaml. */
  role?: string;
  personaId?: string;
  taskId?: string;
  state: DecideOptions['state'];
  questions: Record<string, DecisionQuestion>;
  /** Every answer's leading probability must reach this, or the call site decides by chat instead. */
  confidenceFloor: number;
  /** A further condition on the answers, e.g. "only an approval is taken without explanation". */
  accept?: (answers: Record<string, DecisionAnswer>) => boolean;
  /** As DispatchOptions.institutionalReplayKey: a replayed transition reuses the accepted answers. */
  institutionalReplayKey?: string;
}

export interface DecideOutcome {
  /** True when the answers may stand on their own. False means: make the ordinary chat call. */
  accepted: boolean;
  answers?: Record<string, DecisionAnswer>;
  reason: 'accepted' | 'low-confidence' | 'not-accepted' | 'failed';
  model?: string;
  costUsd: number;
}

/** The probability of the answer given: the chosen option, or the likelier side of a yes/no. */
export function leadingProbability(answer: DecisionAnswer): number {
  if (answer.type === 'noul') return Math.max(answer.noul, 1 - answer.noul);
  if (answer.type === 'choice') return answer.probabilities[answer.choice] ?? 0;
  return Math.max(0, ...Object.values(answer.probabilities));
}

/** "p(aye)=0.82 p(no)=0.11" — what a decision model offers in place of a written rationale. */
export function describeAnswer(answer: DecisionAnswer): string {
  if (answer.type === 'noul') return `p(yes)=${answer.noul.toFixed(2)}`;
  return Object.entries(answer.probabilities)
    .sort(([, a], [, b]) => b - a)
    .map(([option, p]) => `p(${option})=${p.toFixed(2)}`)
    .join(' ');
}

export interface WorkerDispatcherDeps {
  client: OpenRouterClient;
  modelsConfig: ModelsConfig;
  ledger: Ledger;
  budget: BudgetGuard;
  runState: RunState;
  /** Persist metered usage even while a long planning or voting phase is still in flight. */
  onProgress?: (state: RunState) => void;
  /** Worktree file inventory, appended to the roles that author code. Optional so tests and
   * smoke harnesses can construct a dispatcher without a repository. */
  repoInventory?: () => { paths: string[]; truncated: boolean };
  /** Public definitions of the source already in the tree, so an implementer calls the API that
   * exists rather than the one it assumed. Optional for the same reason repoInventory is. */
  repoInterfaces?: () => Record<string, string[]>;
  /** Whether a repo-relative path is present in the worktree, so an edit aimed at nothing is caught
   * as a corrective retry rather than killing the task. Optional like the other repo hooks. */
  fileExists?: (relPath: string) => boolean;
  worktree?: RepoWorktree;
  ownership?: () => OwnershipMap | undefined;
  fallbackRepositoryContext?: (taskId: string | undefined, prompt: string) => string;
  /** Defaults to 'off', so a decision model is only consulted when a run asks for it. */
  decisionMode?: DecisionMode;
  /** Commands a critic may run before its verdict (checks.yaml reviewCommands), and where they run. */
  reviewCommands?: readonly ReviewCommand[];
  checkSandbox?: CheckSandbox;
  /** checks.yaml testPathGlobs, so a plan that gives no task a test is sent back. */
  testPathGlobs?: readonly string[];
}

/**
 * The JSON instructions closing every dispatched prompt. Exported so the model bench sends what
 * production sends: a bench that drifted to an older, shorter suffix measured solar-mini4 abstaining
 * on 1 of 24 Prime Coordinator ballots while the live prompt drew 18 of 24.
 *
 * The worked example about escaping a file's newlines exists for file contents (2cd23ac), so only
 * the implementer, which writes files, gets it. Sent to every role it cost solar-mini4 its
 * elections: 18 of 24 ballots abstained with it, 0 of 24 without.
 */
export function jsonResponseSuffix(schemaDescription: string, role?: string): string {
  const rule = `Respond with ONLY a single JSON value matching this shape, no prose, no markdown fences:\n${schemaDescription}\n\n` +
    `Critical JSON formatting rule: inside any JSON string value, escape newlines as \\n, tabs as \\t, ` +
    `and double quotes as \\" — never place a literal newline, tab, or unescaped quote inside a string.`;
  if (role !== 'implementer') return rule;
  return `${rule} Escape each character ONCE. A two-line file "def f():" then "    return 1" becomes the JSON string ` +
    `"def f():\\n    return 1" — a single backslash before the n. Do not escape twice (writing the two ` +
    `characters backslash-backslash-n where a real newline belongs produces a literal backslash-n in the ` +
    `saved file instead of a line break, which breaks the file).`;
}

/** Roles that decide what to build or write the code itself, and so need to know what already
 * exists. Deliberately excludes reviewing roles: a reviewer's context is the diff under review,
 * and the opposition gets its own targeted widening rather than a bare file list.
 *
 * Injected here, at the single dispatch chokepoint, rather than in each doctrine's prompt
 * builders. Every strategy then receives a byte-identical inventory — an asymmetry between
 * doctrines would bias the benchmark they exist to be compared in. */
/** Assumed context window for a model whose window is not recorded: small enough for most. */
export const UNKNOWN_CONTEXT_TOKENS = 32_768;

const DELIVERY_EVIDENCE_ROLES = new Set(['integrator', 'verifier']);

/** A refusal that rests on the barrier not gathering evidence itself, not on anything it found. */
const SELF_GATHERING_REFUSAL =
  /\b(?:(?:have|has) not (?:yet )?(?:been )?(?:executed|run|read)\b|I (?:must|need to|would need to) (?:first )?(?:read|run|execute)\b|proposed change rather than|rather than the current repository state)/i;

const REPOSITORY_CONTEXT_ROLES = new Set([
  'planner',
  'implementer',
  'reviewer',
  'opposition',
  'bidder',
  'regulator',
  'integrator',
  'verifier',
  'generalist',
]);

interface DispatchTarget {
  modelId: string;
  modelEntry: ModelEntry;
  fallbackIndex: number;
}

const MAX_CORRECTIVE_RETRIES = 2;
const MAX_TOOL_ROUNDS = 6;
const MAX_TOOL_CALLS = 8;
const MAX_INSTITUTIONAL_TOOL_ROUNDS = 3;
const MAX_INSTITUTIONAL_TOOL_CALLS = 4;
const MAX_TOOL_BYTES = 64 * 1024;
/** Each command can take a check's full timeout, so a critic gets a few, not a test campaign. Three
 * cut critics off mid-investigation in every 2026-10-08 arm; the call's tool ceiling still binds. */
const MAX_REVIEW_COMMANDS_PER_CALL = 5;
/** The roles that give a verdict on code. Only these are offered run_review_command. */
const REVIEW_COMMAND_ROLES = new Set(['reviewer', 'opposition', 'regulator', 'verifier']);
/** Roles that judge one task's work, and so are told what that task does and does not own. */
const REVIEW_SCOPE_ROLES = new Set(['reviewer', 'opposition']);
const ENGINEERING_ROLES = new Set(['implementer', 'reviewer', 'integrator', 'verifier', 'generalist']);
class UsagePersistenceError extends Error {}

/** A decision is one forward pass; a call still waiting after this is better decided by chat. */
const DECISION_CALL_TIMEOUT_MS = 30_000;
const REQUIRED_OWNERSHIP_MARKER = 'Engine-enforced required ownership paths (JSON): ';

function requiredOwnershipPaths(prompt: string): string[] {
  const markerStart = prompt.indexOf(REQUIRED_OWNERSHIP_MARKER);
  if (markerStart < 0) return [];
  const valueStart = markerStart + REQUIRED_OWNERSHIP_MARKER.length;
  const valueEnd = prompt.indexOf('\n', valueStart);
  const serialized = prompt.slice(valueStart, valueEnd < 0 ? undefined : valueEnd).trim();
  try {
    const paths = JSON.parse(serialized) as unknown;
    return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : [];
  } catch {
    return [];
  }
}

function collectTargetGlobs(value: unknown, globs = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectTargetGlobs(item, globs);
    return globs;
  }
  if (typeof value !== 'object' || value === null) return globs;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'targetGlobs' && Array.isArray(child)) {
      for (const glob of child) if (typeof glob === 'string') globs.add(glob);
    } else {
      collectTargetGlobs(child, globs);
    }
  }
  return globs;
}

interface PlanNodeSummary {
  id?: string;
  title?: string;
  description?: string;
  dependsOn: string[];
  targetGlobs: string[];
  acceptanceCriteria: string[];
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function collectPlanNodes(value: unknown, nodes: PlanNodeSummary[] = []): PlanNodeSummary[] {
  if (Array.isArray(value)) {
    for (const item of value) collectPlanNodes(item, nodes);
    return nodes;
  }
  if (typeof value !== 'object' || value === null) return nodes;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.targetGlobs)) {
    nodes.push({
      ...(typeof record.id === 'string' ? { id: record.id } : {}),
      ...(typeof record.title === 'string' ? { title: record.title } : {}),
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
      dependsOn: strings(record.dependsOn),
      targetGlobs: strings(record.targetGlobs),
      acceptanceCriteria: strings(record.acceptanceCriteria),
    });
    return nodes;
  }
  for (const child of Object.values(record)) collectPlanNodes(child, nodes);
  return nodes;
}

// Routes a role (planner/implementer/reviewer/opposition/...) to its configured model, forces
// structured JSON output, and retries with a corrective prompt on parse/validation failure.
// Every call is metered through BudgetGuard first — no worker call happens for free.
export class WorkerDispatcher {
  private readonly client: OpenRouterClient;
  private readonly modelsConfig: ModelsConfig;
  private readonly ledger: Ledger;
  private readonly budget: BudgetGuard;
  private readonly onProgress?: (state: RunState) => void;
  private readonly runState: RunState;
  private readonly repoInventory?: () => { paths: string[]; truncated: boolean };
  private readonly repoInterfaces?: () => Record<string, string[]>;
  private readonly fileExists?: (relPath: string) => boolean;
  private readonly worktree?: RepoWorktree;
  private readonly reviewCommands: readonly ReviewCommand[];
  private readonly checkSandbox: CheckSandbox;
  private readonly testPathGlobs: readonly string[];
  private readonly ownership?: () => OwnershipMap | undefined;
  private readonly fallbackRepositoryContext?: (taskId: string | undefined, prompt: string) => string;
  readonly decisionMode: DecisionMode;
  /** Above zero while the run-level delivery review is in progress; see outsideTaskCeilings. */
  private deliveryReviewDepth = 0;

  constructor(deps: WorkerDispatcherDeps) {
    const { client, modelsConfig, ledger, budget, runState, repoInventory, repoInterfaces, fileExists } = deps;
    this.client = client;
    this.modelsConfig = modelsConfig;
    this.ledger = ledger;
    this.budget = budget;
    this.runState = runState;
    this.onProgress = deps.onProgress;
    this.repoInventory = repoInventory;
    this.repoInterfaces = repoInterfaces;
    this.fileExists = fileExists;
    this.worktree = deps.worktree;
    this.ownership = deps.ownership;
    this.fallbackRepositoryContext = deps.fallbackRepositoryContext;
    this.decisionMode = deps.decisionMode ?? 'off';
    this.reviewCommands = deps.reviewCommands ?? [];
    this.checkSandbox = deps.checkSandbox ?? 'none';
    this.testPathGlobs = deps.testPathGlobs ?? [];
  }

  /** The repository tools offered to this call: the read tools, plus run_review_command for a critic. */
  private toolDefinitionsFor(opts: DispatchOptions) {
    const review = REVIEW_COMMAND_ROLES.has(opts.role) ? reviewCommandToolDefinition(this.reviewCommands) : null;
    return review ? [...REPOSITORY_TOOL_DEFINITIONS, review] : REPOSITORY_TOOL_DEFINITIONS;
  }

  /**
   * The smallest context window, in tokens, among the chat models any role may be served by,
   * primary or fallback. A prompt sized to it fits whichever model answers. A model whose window
   * is not recorded counts as UNKNOWN_CONTEXT_TOKENS, so an unrecorded roster errs small.
   */
  smallestContextTokens(): number {
    const ids = new Set(Object.values(this.modelsConfig.roles).flatMap((role) => [role.primary, role.fallback]));
    const windows = [...ids]
      .map((id) => this.modelsConfig.models[id])
      .filter((entry): entry is ModelEntry => entry !== undefined && !isDecisionModel(entry))
      .map((entry) => entry.contextLength ?? UNKNOWN_CONTEXT_TOKENS);
    return windows.length ? Math.min(...windows) : UNKNOWN_CONTEXT_TOKENS;
  }

  /** Whether bounded decisions go to a decision model first under the run's mode. */
  decidesFirst(): boolean {
    return this.decisionMode === 'pure';
  }

  /**
   * Asks the role's decision models (primary, then fallback) one or more typed questions. Never
   * throws for a model failure: an unusable or unconfident answer comes back as `accepted: false`,
   * and the call site makes its ordinary chat call, so the worst case is today's behaviour plus one
   * cheap call. Metered and ledgered like any worker call, but outside the institutional-call
   * ceiling, so enabling decisions cannot make a task hit that ceiling sooner.
   */
  async decide(opts: DecideDispatchOptions): Promise<DecideOutcome> {
    const role = opts.role ?? 'decider';
    const roleConfig = this.modelsConfig.roles[role];
    if (!roleConfig) return { accepted: false, reason: 'failed', costUsd: 0 };
    const cacheKey = opts.institutionalReplayKey
      ? createHash('sha256').update(JSON.stringify({ decision: opts.institutionalReplayKey, questions: opts.questions })).digest('hex')
      : undefined;
    const cached = cacheKey ? this.runState.institutionalPlanCache?.[cacheKey] : undefined;
    if (cached) {
      this.ledger.record('institutional_plan_cache_hit', { role, taskId: opts.taskId, model: cached.model });
      return { accepted: true, answers: JSON.parse(cached.raw) as Record<string, DecisionAnswer>, reason: 'accepted', model: cached.model, costUsd: 0 };
    }
    // A choice with one option is already decided, and the API refuses it (2 to 255 options).
    const forced: Record<string, DecisionAnswer> = {};
    const asked: typeof opts.questions = {};
    for (const [key, question] of Object.entries(opts.questions)) {
      const options = question.type === 'choice' ? Object.keys(question.criteria) : [];
      if (options.length === 1) forced[key] = { type: 'choice', choice: options[0]!, confidence: 1, probabilities: { [options[0]!]: 1 } };
      else asked[key] = question;
    }
    if (Object.keys(asked).length === 0) {
      const accepted = !opts.accept || opts.accept(forced);
      return { accepted, answers: forced, reason: accepted ? 'accepted' : 'not-accepted', costUsd: 0 };
    }
    let costUsd = 0;
    for (const [fallbackIndex, modelId] of [roleConfig.primary, roleConfig.fallback].entries()) {
      const modelEntry = this.modelsConfig.models[modelId];
      if (!isDecisionModel(modelEntry)) continue;
      this.budget.checkBeforeCall(this.runState, opts.taskId);
      const startedAtMs = Date.now();
      try {
        const result = await this.client.decide({
          model: modelId,
          modelEntry: modelEntry!,
          state: opts.state,
          questions: asked,
          timeoutMs: Math.min(this.budget.perCallTimeoutMs(role), DECISION_CALL_TIMEOUT_MS),
        });
        Object.assign(result.answers, forced);
        costUsd += result.costUsd;
        this.budget.recordSpend(this.runState, { costUsd: result.costUsd, promptTokens: result.promptTokens, completionTokens: 0 }, opts.taskId);
        const confident = Object.values(result.answers).every((answer) => leadingProbability(answer) >= opts.confidenceFloor);
        const reason = !confident ? 'low-confidence' : opts.accept && !opts.accept(result.answers) ? 'not-accepted' : 'accepted';
        this.ledger.record('decision_call', {
          role,
          personaId: opts.personaId,
          taskId: opts.taskId,
          model: modelId,
          fallbackIndex,
          answers: Object.fromEntries(Object.entries(result.answers).map(([key, answer]) => [key, describeAnswer(answer)])),
          confidenceFloor: opts.confidenceFloor,
          inputDigest: contentDigest({ state: opts.state, questions: asked }),
          outcome: reason,
          costUsd: result.costUsd,
          costMetered: result.costMetered,
          promptTokens: result.promptTokens,
          durationMs: Date.now() - startedAtMs,
          ...(result.provider !== undefined ? { provider: result.provider } : {}),
        });
        if (cacheKey && reason === 'accepted') {
          (this.runState.institutionalPlanCache ??= {})[cacheKey] = { raw: JSON.stringify(result.answers), model: modelId };
        }
        this.persistProgress();
        return { accepted: reason === 'accepted', answers: result.answers, reason, model: modelId, costUsd };
      } catch (err) {
        if (err instanceof BudgetExceededError || err instanceof UsagePersistenceError) throw err;
        this.ledger.record('decision_call_failed', {
          role, personaId: opts.personaId, taskId: opts.taskId, model: modelId, fallbackIndex,
          durationMs: Date.now() - startedAtMs, error: String(err).slice(0, 200),
          timedOut: (err as Error & { timeout?: boolean }).timeout === true,
        });
        // A failed request still used a call slot, as a failed chat call does.
        this.runState.workerCalls += 1;
        this.persistProgress();
      }
    }
    return { accepted: false, reason: 'failed', costUsd };
  }

  /**
   * Runs the final delivery review without charging its calls to any task's institutional ceiling.
   *
   * That ceiling bounds procedure on one engineering task. A doctrine's delivery review convenes per
   * task (socialist councils pass council.taskId), so it was billed to whatever the task had already
   * spent: on 2026-10-05 a socialist arm whose tree scored 12/12 ended with no delivery because
   * tests-and-readme had used its 24 calls before the final council sat. The review is still bounded
   * by maxWorkerCalls and the spend ceiling, and every call is still recorded.
   */
  /** The task's own reworked attempt, as its repository tools should see it (TaskNode.retainedAttempt). */
  private retainedOverlay(taskId: string | undefined): RepositoryOverlay | undefined {
    const retained = taskId ? this.runState.graph?.nodes[taskId]?.retainedAttempt : undefined;
    if (!retained?.length) return undefined;
    return new Map(retained.map((file) => [file.path.replace(/\\/g, '/').replace(/^\.\//, ''), file.existed ? file.content ?? '' : null]));
  }

  async outsideTaskCeilings<T>(review: () => Promise<T>): Promise<T> {
    this.deliveryReviewDepth += 1;
    try {
      return await review();
    } finally {
      this.deliveryReviewDepth -= 1;
    }
  }

  async dispatch<T = unknown>(opts: DispatchOptions): Promise<DispatchResult<T>> {
    const roleConfig = this.modelsConfig.roles[opts.role];
    if (!roleConfig) throw new Error(`No model configured for role "${opts.role}" in config/models.yaml`);

    const cacheKey = this.planCacheKey(opts);
    const cached = cacheKey ? this.runState.institutionalPlanCache?.[cacheKey] : undefined;
    if (cached) {
      const parsed = extractJson(cached.raw);
      opts.validate(parsed);
      this.ledger.record('institutional_plan_cache_hit', { role: opts.role, taskId: opts.taskId, model: cached.model });
      return { value: parsed as T, raw: cached.raw, model: cached.model, costUsd: 0 };
    }

    const phase = opts.phase ?? (ENGINEERING_ROLES.has(opts.role) ? 'engineering' : 'institutional');
    if (phase === 'institutional' && opts.taskId && this.deliveryReviewDepth > 0) {
      this.ledger.record('institutional_dispatch', {
        taskId: opts.taskId, role: opts.role, personaId: opts.personaId, deliveryReview: true,
      });
    } else if (phase === 'institutional' && opts.taskId) {
      const counts = (this.runState.institutionalCallsByTask ??= {});
      const used = counts[opts.taskId] ?? 0;
      const ceiling = this.budget.maxInstitutionalCallsPerTask?.();
      if (ceiling !== undefined && used >= ceiling) {
        this.ledger.record('institutional_call_ceiling', { taskId: opts.taskId, role: opts.role, used, ceiling });
        throw new Error(`Task ${opts.taskId} reached its institutional-call ceiling of ${ceiling}.`);
      }
      counts[opts.taskId] = used + 1;
      this.ledger.record('institutional_dispatch', { taskId: opts.taskId, role: opts.role, personaId: opts.personaId });
      this.persistProgress();
    }

    const candidates = [roleConfig.primary, roleConfig.fallback];
    let lastErr: unknown;

    for (const [fallbackIndex, modelId] of candidates.entries()) {
      const modelEntry = this.modelsConfig.models[modelId];
      if (!modelEntry) {
        logger.warn('Model referenced by role has no pricing entry, skipping', { modelId, role: opts.role });
        continue;
      }
      if (isDecisionModel(modelEntry)) {
        logger.warn('Decision model cannot serve a chat dispatch, skipping', { modelId, role: opts.role });
        continue;
      }

      try {
        const result = await this.dispatchToModel<T>({ modelId, modelEntry, fallbackIndex }, opts);
        if (cacheKey) {
          (this.runState.institutionalPlanCache ??= {})[cacheKey] = { raw: result.raw, model: result.model };
          this.persistProgress();
        }
        return result;
      } catch (err) {
        if (err instanceof BudgetExceededError || err instanceof UsagePersistenceError) throw err;
        lastErr = err;
        logger.warn('Dispatch to model failed, trying fallback if available', {
          modelId,
          role: opts.role,
          error: String(err),
        });
      }
    }

    throw lastErr ?? new Error(`All models failed for role "${opts.role}"`);
  }

  private planCacheKey(opts: DispatchOptions): string | undefined {
    if (!opts.institutionalReplayKey) {
      if (opts.role !== 'planner' && opts.role !== 'bidder') return undefined;
      const graphHasImplementation = this.runState.graph?.order.some((taskId) =>
        this.runState.graph!.nodes[taskId].attempts.length > 0,
      ) ?? false;
      if (graphHasImplementation) return undefined;
    }
    return createHash('sha256')
      .update(JSON.stringify({ replay: opts.institutionalReplayKey, role: opts.role,
        personaId: opts.personaId, system: opts.systemPrompt, user: opts.userPrompt,
        schema: opts.schemaDescription }))
      .digest('hex');
  }

  private persistProgress(): void {
    try {
      this.onProgress?.(this.runState);
    } catch (error) {
      throw new UsagePersistenceError(`Could not persist metered worker usage: ${String(error)}`);
    }
  }

  /** The repository as it actually stands, for the roles that write to it.
   *
   * Without this an implementer is authoring blind: it can read any path it can name, but has no
   * way to learn a path it was never told about. In the benchmark that produced three successive
   * attempts to invent nuclear-data files while the real ones sat unread in the same worktree.
   * Says explicitly that these files already exist, because merely listing them left the earlier
   * failure mode — treating the listing as a plan of files to create — available. */
  private repoInventorySection(role: string): string {
    if (!REPOSITORY_CONTEXT_ROLES.has(role) || !this.repoInventory) return '';
    let inventory;
    try {
      inventory = this.repoInventory();
    } catch (err) {
      logger.warn('Could not build repo inventory for prompt', { role, error: String(err) });
      return '';
    }
    if (!inventory.paths.length) return '';
    return (
      `These files ALREADY EXIST in the repository you are working in. Read what you need with ` +
      `the paths below rather than recreating or inventing their contents; supplied data files ` +
      `are authoritative and must not be regenerated${inventory.truncated ? ' (listing truncated)' : ''}:\n` +
      `${inventory.paths.join('\n')}\n\n`
    );
  }

  /** Implementers deliver a file whose entire body is `...` and report the task done. Two separate
   * benchmark doctrines shipped exactly the three bytes `...` — capitalist as `cli.py`, democratic
   * as `nuclear_data.py`, the latter approved by its own committee because an empty module breaks
   * no test until something imports it. The next task then fails on an ImportError it cannot fix,
   * having been handed a dependency that was never written. Placed at the single dispatch
   * chokepoint so no doctrine is told this more forcefully than another. */
  private noPlaceholderSection(role: string): string {
    if (role !== 'implementer') return '';
    return (
      `Every file you write must be complete and runnable as delivered. Do not emit a placeholder ` +
      `body — a lone \`...\`, a bare \`pass\`, \`raise NotImplementedError\`, or a TODO comment — for ` +
      `anything you are reporting as done: another task will import what you write and cannot repair ` +
      `it. If you cannot complete a file, leave it out and say so in your rationale rather than ` +
      `delivering a stub that looks finished.\n\n` +
      `Never delete, skip, weaken or narrow an existing test to make a check pass. A failing test ` +
      `is telling you the code is wrong, not that the test is. Requests to waive a required test ` +
      `are refused, so an attempt that removes one is spent for nothing — a real run lost all six ` +
      `of its attempts asking for the same waiver. Fix the code, or add coverage.\n\n`
    );
  }

  private runtimeArtifactPlanningSection(role: string): string {
    if (role !== 'planner') return '';
    return (
      `Workers can change the repository only through structured text FileOp entries; they cannot ` +
      `run shell commands or encode binary output files. Do not create a standalone task whose ` +
      `owned outputs are runtime-generated artifacts such as results/*.png, results/*.csv, coverage ` +
      `reports, or build products. Put responsibility for making the command generate those outputs ` +
      `on the source/CLI task, and put behavioral assertions in the test task. Generated files are ` +
      `check artifacts, not authored FileOps — the engine copies them out of the worktree as evidence ` +
      `and strips them before capturing the authored delivery. Every required invocation must also have an ` +
      `owned implementation path: for example, a requirement to run "python -m package" needs ` +
      `package/__main__.py in the CLI task's target paths, not only package/cli.py. Check the complete ` +
      `task for conventional entry points and manifests before finalizing ownership. Assign each node ` +
      `only acceptance criteria that its own work can satisfy before downstream tasks run. Do not copy ` +
      `final integrated commands or whole-project criteria onto every node; the engine applies strict ` +
      `whole-suite checks after integration.\n\n` +
      `At least one task's target paths must own a test file the test runner will actually discover ` +
      `(e.g. a Python task's globs must include a path under tests/ or matching test_*.py/*_test.py, ` +
      `not just the source module). A plan whose tasks between them own zero test files still passes ` +
      `every individual task review, then fails the final whole-suite check with no test collected and ` +
      `no task left to blame or retry — a defect discovered too late to fix. Verify this explicitly ` +
      `before finalizing the plan: read every task's targetGlobs and confirm at least one names a test ` +
      `path.\n\n` +
      `Before finalizing any task's acceptance criteria, check them against each other for a hidden ` +
      `contradiction: a criterion invented as a literal detail (an exact grid-construction rule, a ` +
      `specific numeric tolerance, a specific dict key name) can silently conflict with another, more ` +
      `fundamental one (e.g. "never read outside the input's own bounds"). If a goal only asks ` +
      `for the outcome ("merge the inputs onto one index", "report where the data came from") without dictating the ` +
      `mechanism, do not invent a specific mechanism as the acceptance criterion — state the outcome ` +
      `and let the implementer choose a mechanism that satisfies every other stated requirement too. A ` +
      `criterion no implementation can satisfy without violating a different criterion is worse than no ` +
      `criterion at all: it consumes every rework attempt on a contradiction, not a defect.\n\n` +
      `Give every file exactly one owning task. A scaffold or package-skeleton task owns only what no ` +
      `other task implements; it never lists a module another task will write. Logic two modules both ` +
      `need lives in one task's file and is imported by the other, not copied into both. Two tasks that ` +
      `claim the same file will each rewrite the other's work, and neither can be retried alone.\n\n` +
      `Every task must create or change files. Reading the repository or its supplied inputs is not a ` +
      `task of its own: the task that uses an input reads it. Never list a supplied input file in ` +
      `targetGlobs unless a task must change it — owning a file invites a worker to rewrite it.\n\n`
    );
  }

  /** Names the work the doctrine abandoned, so a task released to proceed without it builds around
   * a known gap instead of importing something that was reverted away. Read off the run's own graph
   * at the single dispatch chokepoint, so every doctrine is told in the same words. */
  private abandonedWorkSection(role: string): string {
    if (role !== 'implementer') return '';
    const graph = this.runState.graph;
    if (!graph) return '';
    const abandoned = graph.order
      .map((id) => graph.nodes[id])
      .filter((node) => node.phase === 'abandoned');
    if (abandoned.length === 0) return '';
    return (
      `These parts of the plan were ABANDONED and their code is NOT in the repository — every ` +
      `change they proposed was reverted. Do not import from them or assume they exist; implement ` +
      `what you need yourself, or state plainly in your rationale what you could not do without ` +
      `them:\n` +
      `${abandoned.map((node) => `- ${node.id}: ${node.title} (would have owned ${node.targetGlobs.join(', ') || 'no declared paths'})`).join('\n')}\n\n`
    );
  }

  /** Why earlier attempts at this work were not accepted. Without it a requeued task starts over
   * knowing nothing: one task spent all six of its attempts being refused for the same failing
   * check. Read off the run's own graph at the single dispatch chokepoint, so every doctrine's
   * implementer sees the same evidence in the same words: the engine's repair brief (failing
   * checks, review findings, the reverted attempt, earlier attempts), any sign-off refusals, and
   * real execution failures. Provider timeouts are not shown — they say nothing about the work. */
  private repairSection(role: string, taskId?: string): string {
    if (role !== 'implementer' || !taskId) return '';
    const graph = this.runState.graph;
    if (!graph) return '';
    const node = graph.nodes[taskId];
    // The engine marks a node `running` before strategy.execute() dispatches its implementer, so a
    // queued-only check never fired in a real run.
    if (!node || (node.phase !== 'queued' && node.phase !== 'running')) return '';
    const brief = node.repairBrief ? renderRepairBrief(node.repairBrief) : '';
    const executionFailures = node.attempts
      .filter((attempt) => !attempt.transient && attempt.rationale.startsWith('Execution failed:'))
      .slice(-2)
      .map((attempt) => attempt.rationale);
    // The brief already carries the check output; a refusal's own copy of it would be the third.
    const refusals = (node.signOffRefusals?.slice(-2) ?? [])
      .map((refusal) => (brief ? refusal.replace(/\nIndependent check output[\s\S]*?(?=\nEvaluator decision:|$)/g, '') : refusal));
    const retryReasons = [...refusals, ...executionFailures];
    const reasons = retryReasons.length === 0 ? '' : (
      `Earlier attempts at this work failed or were refused sign-off for the reasons below. Address ` +
      `them directly — repeating the same delivery will fail again:\n` +
      `- ${retryReasons.join(' | ')}\n\n`
    );
    return brief + reasons;
  }

  /** What the code already in the tree actually exposes.
   *
   * The file listing tells an implementer a module exists; it does not tell it what to call. A real
   * run lost `plotting` to six rejections because it assumed composition.py exposed `load_alloy`,
   * and an earlier one lost `damage` importing a NuclearDataReader nobody had written. Signatures
   * only — the contract, not the bodies. */
  private repoInterfaceSection(role: string): string {
    if (!REPOSITORY_CONTEXT_ROLES.has(role) || !this.repoInterfaces) return '';
    let surface: Record<string, string[]>;
    try {
      surface = this.repoInterfaces();
    } catch (err) {
      logger.warn('Could not read repo interfaces for prompt', { role, error: String(err) });
      return '';
    }
    const entries = Object.entries(surface);
    if (entries.length === 0) return '';
    return (
      `This is what the code already in the repository EXPOSES. Call these exact names — do not ` +
      `assume an API that is not listed here, and do not invent one; an import that does not ` +
      `resolve fails the whole check run:\n` +
      `${entries.map(([file, defs]) => `${file}\n${defs.map((d) => `    ${d}`).join('\n')}`).join('\n')}\n\n`
    );
  }

  private async dispatchToModel<T>(target: DispatchTarget, opts: DispatchOptions): Promise<DispatchResult<T>> {
    const { modelId, modelEntry, fallbackIndex } = target;
    const messages: ChatMessage[] = [
      { role: 'system', content: opts.systemPrompt },
      {
        role: 'user',
        content:
          `${opts.userPrompt}\n\n` +
          (opts.repositoryContext === false ? '' : this.repoInventorySection(opts.role) + this.repoInterfaceSection(opts.role)) +
          this.noPlaceholderSection(opts.role) +
          this.runtimeArtifactPlanningSection(opts.role) +
          this.abandonedWorkSection(opts.role) +
          this.repairSection(opts.role, opts.taskId) +
          this.ownershipSection(opts) +
          this.reviewScopeSection(opts) +
          this.defectPathsSection(opts) +
          this.deliveryEvidenceSection(opts.role) +
          this.fallbackRepositorySection(opts) +
          jsonResponseSuffix(opts.schemaDescription, opts.role),
      },
    ];

    let attempt = 0;
    let totalCost = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    while (attempt <= MAX_CORRECTIVE_RETRIES) {
      const round = await this.completeWithRepositoryTools({ target, opts, messages, correctiveAttempt: attempt + 1 });
      const result = round.result;
      totalCost += round.costUsd;
      totalPromptTokens += round.promptTokens;
      totalCompletionTokens += round.completionTokens;

      try {
        const parsed = extractJson(result.text);
        opts.validate(parsed);
        this.holdRejectToOwnedFiles(parsed, opts, attempt);
        if (opts.role === 'planner' && opts.schemaDescription.includes('targetGlobs')) {
          // Every problem with the plan is reported in one correction. Reported one at a time, they
          // used up the planner's retries before the later ones were ever named: the 2026-10-08
          // managerial cycle-2 planner spent both on a missing path and a criterion ahead of its
          // owner, and the reading-only task it had also made stood unchallenged, so its worker had
          // nothing to write and was refused sign-off three times.
          // `blocking` problems are never let stand. The rest are corrected while retries remain;
          // the last attempt's plan stands with them recorded, so a planner that cannot untangle
          // them is never failed for it.
          const problems: Array<{ message: string; blocking: boolean }> = [];
          const requiredPaths = requiredOwnershipPaths(opts.userPrompt);
          const declaredPaths = collectTargetGlobs(parsed);
          const missingPaths = requiredPaths.filter((path) => !declaredPaths.has(path));
          if (missingPaths.length > 0) {
            problems.push({ blocking: true, message:
              `The plan does not assign these engine-required paths verbatim in any task's targetGlobs: ` +
                `${missingPaths.join(', ')}. Add each exact path to an actionable task without removing ` +
                `the ownership already declared.` });
          }
          const planNodes = collectPlanNodes(parsed);
          if (requiredPaths.length > 0 && planNodes.length > 1) {
            const sharedCriteria = planNodes[0]!.acceptanceCriteria.filter((criterion) =>
              planNodes.every((node) => node.acceptanceCriteria.includes(criterion)),
            );
            if (sharedCriteria.length > 0) {
              problems.push({ blocking: true, message:
                `These final integrated criteria were copied onto every task: ${sharedCriteria.join(' | ')}. ` +
                  `Replace them with task-local criteria each node can satisfy before its downstream ` +
                  `dependencies exist. Final whole-suite and CLI checks run after integration.` });
            }
          }
          const planned = planNodes.filter((node): node is PlanNodeSummary & { id: string } => node.id !== undefined);
          // A cycle is never let stand: no task in it can ever become runnable, so the run would end
          // the moment it started.
          const cycle = dependencyCycle(planned);
          if (cycle) {
            problems.push({ blocking: true, message:
              `The tasks' dependsOn form a cycle, so none of them can ever start: ${cycle.join(' → ')}. ` +
                'Remove one dependsOn link in the cycle; a task that needs another\'s file must come after it, never both ways.' });
          }
          // A criterion that needs a file a non-upstream task writes cannot be met when its own task
          // is accepted.
          const ahead = planned.length === planNodes.length ? criteriaAheadOfTheirOwners(planned) : [];
          if (ahead.length > 0) {
            problems.push({ blocking: false, message:
              'These acceptance criteria need a file that another task writes, and that task is not ' +
                `upstream of theirs, so they cannot be met when their own task is accepted: ${ahead.map((hit) =>
                  `task "${hit.taskId}" criterion "${hit.criterion}" needs ${hit.path} (written by "${hit.ownerTaskId}")`,
                ).join('; ')}. For each, either add the owning task to dependsOn (if that makes no cycle), ` +
                'move the file into this task\'s targetGlobs, or move the criterion to the owning task or a later one.' });
          }
          const reading = this.fileExists ? readingOnlyTasks(planNodes, this.fileExists) : [];
          if (reading.length > 0) {
            problems.push({ blocking: false, message:
              `These tasks only read files the repository already holds, so their workers have nothing ` +
                `to write: ${reading.map((task) => `"${task.id ?? task.title}" (${task.targetGlobs.join(', ')})`).join('; ')}. ` +
                'Reading inputs is part of the tasks that use them: remove these tasks (and any dependsOn ' +
                'naming them), and never put a supplied input file in targetGlobs unless a task must change it.' });
          }
          const untested = planWithoutTests(planNodes, this.testPathGlobs);
          if (untested) {
            problems.push({ blocking: false, message:
              'No task owns a test file, so nobody may write the automated tests that show this change ' +
                `works (test paths match: ${this.testPathGlobs.join(', ')}). Give the tests to a task: add ` +
                'their paths to the targetGlobs of the task that writes the code they test, or of a test task ' +
                'that depends on it, with acceptance criteria naming what the tests demonstrate.' });
          }
          const retriesRemain = attempt < MAX_CORRECTIVE_RETRIES;
          const reported = problems.filter((problem) => problem.blocking || retriesRemain);
          if (reported.some((problem) => problem.blocking) || (retriesRemain && reported.length > 0)) {
            throw new Error(reported.length === 1
              ? reported[0]!.message
              : `Fix all ${reported.length} of these problems in one revision:\n` +
                reported.map((problem, index) => `${index + 1}. ${problem.message}`).join('\n'));
          }
          if (untested) {
            this.ledger.record('plan_without_tests', { role: opts.role, personaId: opts.personaId, testPathGlobs: this.testPathGlobs });
          }
          if (ahead.length > 0) {
            this.ledger.record('plan_criteria_ahead_of_owner', {
              role: opts.role, personaId: opts.personaId,
              criteria: ahead.map((hit) => ({ taskId: hit.taskId, ownerTaskId: hit.ownerTaskId, path: hit.path })),
            });
          }
        }
        // Corrected while retries remain; the last answer stands, since a real rejection can share
        // the wording.
        if (DELIVERY_EVIDENCE_ROLES.has(opts.role) && attempt < MAX_CORRECTIVE_RETRIES) {
          const report = parsed as { verified?: unknown; integrated?: unknown; rationale?: unknown };
          const withheld = report.verified === false || report.integrated === false;
          if (withheld && typeof report.rationale === 'string' && SELF_GATHERING_REFUSAL.test(report.rationale)) {
            throw new Error(
              'Your rationale withholds because you have not run or read something yourself. The diff is ' +
                'already applied and the check results were executed on this tree: decide on them, reading ' +
                'files with the repository tools if you need to. Withhold only for a defect or gap you can name.',
            );
          }
        }
        // Asking implementers not to ship stubs was not enough — the instruction shipped and the
        // next run delivered five of them. Checked here rather than in each doctrine's validator
        // because the five validate through five different mechanisms, and a guard that reached
        // only some of them would bias the benchmark it exists to protect. A stub is the model
        // failing to produce usable output, like malformed JSON, so it takes the same corrective
        // retry and never reaches a doctrine's judgement.
        if (opts.role === 'implementer') {
          const controlCharacterPaths = pathsWithForbiddenControlCharacters(parsed);
          if (controlCharacterPaths.length > 0) {
            throw new Error(
              `These files contain forbidden control characters, usually caused by a malformed JSON ` +
                `escape such as \\b followed by n: ${controlCharacterPaths.join(', ')}. Replace them ` +
                `with the intended escaped newline (\\n) or ordinary source text.`,
            );
          }
          // An edit against a file that is not there kills the task outright via handleTaskError,
          // and a rejected attempt has had its files reverted — so the very next attempt at a task
          // that just failed is the most likely moment to aim an edit at nothing. Caught here it is
          // a corrective retry the model can fix by writing the file instead; uncaught it cost one
          // run 91 minutes and $1.15 looping on a single missing path.
          const missing = editsAgainstMissingFiles(parsed, (p) => this.fileExists?.(p) ?? true);
          if (missing.length > 0) {
            throw new Error(
              `These edits target files that do not exist: ${missing.join(', ')}. ` +
                'Use a write operation to create a file, and reserve edit for files already present.',
            );
          }
          // Same reasoning one step further: an edit whose find-text is not in the file failed the
          // whole attempt at apply time (7 of 10 task errors in the 2026-10-03 sweep's democratic
          // arm). Here it is a corrective retry, and the model is shown the file as it stands.
          const unmatched = this.worktree
            ? editsWithUnmatchedFind(parsed, (p) => this.worktree!.readFileIfExists(p))
            : [];
          if (unmatched.length > 0) {
            throw new Error(unmatchedEditMessage(unmatched, (p) => this.worktree!.readFileIfExists(p)));
          }
          const stubs = placeholderFileWrites(parsed);
          if (stubs.length > 0) {
            throw new Error(
              `These files were delivered with a placeholder body and no implementation: ${stubs.join(', ')}. ` +
                'Write the real implementation, or omit the file entirely and say why in your rationale — ' +
                'another task will import what you deliver and cannot repair it.',
            );
          }
          const ownership = this.ownership?.();
          if (opts.taskId && ownership) {
            // `parsed` is the model's raw wire JSON, not yet run through a strategy's own
            // translation into the engine's FileOp shape — democratic's wire format keys each
            // op by `filePath`, not `path` (see democratic/prompts.ts's toEngineFileOps, which
            // only runs after dispatch() returns to the caller). Without this fallback, every
            // op.path here is undefined, and undeclaredPaths -> matchesAnyGlob throws on it
            // instead of producing a correctable validation error for the model to fix.
            const rawFileOps = (parsed as { fileOps?: Array<Record<string, unknown>> }).fileOps ?? [];
            const normalizedFileOps = rawFileOps.map((op) => ({
              ...op,
              path: typeof op.path === 'string' ? op.path : (op as { filePath?: unknown }).filePath,
            })) as import('./types.js').FileOp[];
            const undeclared = undeclaredPaths(opts.taskId, normalizedFileOps, ownership);
            if (undeclared.length) {
              const owned = (p: string) => {
                const owners = otherOwners(p, opts.taskId!, ownership);
                return owners.length ? `${p} (owned by ${owners.join(', ')})` : `${p} (owned by no task)`;
              };
              throw new Error(
                `These paths are outside task ${opts.taskId}'s declared ownership: ${undeclared.map(owned).join(', ')}. ` +
                'Only return FileOps for owned paths or a declared overlap: drop these ops, and name any change ' +
                'they needed in your rationale instead.',
              );
            }
            // Never let stand on the last attempt: an approved empty answer for an absent file is
            // a task reported done with its work missing.
            const absent = rawFileOps.length === 0 && this.fileExists
              ? missingOwnedSources(opts.taskId, ownership, this.fileExists)
              : [];
            if (absent.length > 0) {
              throw new Error(
                `You returned no file operations, but these files your task owns do not exist yet: ${absent.join(', ')}. ` +
                  '"No change" is only valid when your owned files already exist and meet the criteria: write each of them.',
              );
            }
          }
        }
        return {
          value: parsed as T,
          raw: result.text,
          model: modelId,
          costUsd: totalCost,
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
        };
      } catch (err) {
        attempt += 1;
        if (attempt > MAX_CORRECTIVE_RETRIES) {
          throw new JsonValidationError(
            `Model ${modelId} failed to produce valid JSON for role "${opts.role}" after ${MAX_CORRECTIVE_RETRIES} corrective retries: ${String(err)}`,
            result.text,
          );
        }
        messages.push({ role: 'assistant', content: result.text });
        // The final correction emphasizes JSON syntax. Engineering roles must retain the code
        // and plan details needed to satisfy the task; only short institutional answers can be
        // compressed without changing their meaning.
        const lastAttempt = attempt === MAX_CORRECTIVE_RETRIES;
        const lastAttemptDetail = opts.role === 'implementer'
          ? 'Preserve complete, runnable file contents. Keep only the rationale concise; escape source newlines inside JSON strings as \\n. '
          : opts.role === 'planner'
            ? 'Keep task descriptions concise, but preserve every required output path and test criterion. '
            : 'Keep every string value to a few words. ';
        messages.push({
          role: 'user',
          content: lastAttempt
            ? `That was still not valid JSON: ${String(err)}. Return ONLY a single JSON value matching ` +
              `${opts.schemaDescription}. ${lastAttemptDetail}Every string MUST be ` +
              `wrapped in double quotes — including values, not just keys. No newlines inside strings, ` +
              `no markdown, no explanation before or after the JSON.`
            : `Your last output was invalid: ${String(err)}. Return ONLY the corrected JSON value, matching: ${opts.schemaDescription}`,
        });
      }
    }
    throw new Error('unreachable');
  }

  private ownershipSection(opts: DispatchOptions): string {
    if (opts.role !== 'implementer' || !opts.taskId) return '';
    const taskId = opts.taskId;
    const ownership = this.ownership?.();
    const entry = ownership?.entries[taskId];
    if (!entry) return '';
    const overlaps = ownership!.declaredOverlaps.filter((overlap) => overlap.taskIds.includes(taskId));
    return (
      `Your task owns exactly these paths/globs: ${[...entry.paths, ...entry.interfaces, ...entry.generated, ...entry.tests].join(', ') || '(none)'}.\n` +
      `Declared overlaps: ${overlaps.map((overlap) => `${overlap.path} (${overlap.rationale})`).join('; ') || '(none)'}. ` +
      `Do not return a FileOp for any other path. Other files belong to other tasks, which make ` +
      `their own changes to them: if this task seems to need a change to a file you do not own ` +
      `(a test for your code, an entry point, an example), leave it out and say so in your rationale. ` +
      `If your owned files already meet the task, or the task only reads inputs, return an empty ` +
      `fileOps array and say why in your rationale; do not rewrite a file just to return something.\n\n`
    );
  }

  /**
   * Reviewers read TASK.md through their repository context and judged each task against the whole
   * project: one democratic arm's Opposition rejected "plotting" for lacking cli.py, __main__.py and
   * composition.py, all owned by other motions, and seven motions in a row went to rework for work
   * they were forbidden to write. Capitalist's reviewer prompt already scoped its listing; this
   * tells every doctrine's reviewers the same thing, at the same chokepoint as the implementers'
   * ownership section.
   */
  private reviewScopeSection(opts: DispatchOptions): string {
    const taskId = opts.scopeTaskId ?? (REVIEW_SCOPE_ROLES.has(opts.role) ? opts.taskId : undefined);
    if (!taskId) return '';
    const ownership = this.ownership?.();
    const entry = ownership?.entries[taskId];
    if (!entry) return '';
    const own = [...entry.paths, ...entry.interfaces, ...entry.generated, ...entry.tests];
    const others = Object.values(ownership!.entries)
      .filter((other) => other.taskId !== taskId)
      .map((other) => `${other.taskId}: ${[...other.paths, ...other.interfaces, ...other.generated, ...other.tests].join(', ') || '(none)'}`);
    return (
      `Scope of this review: task ${taskId} owns exactly ${own.join(', ') || '(none)'}. ` +
      `It is one task in a larger plan, and its worker may not write any other file.\n` +
      (others.length ? `Other tasks own: ${others.join('; ')}.\n` : '') +
      `Judge the work against this task's own acceptance criteria and files. A file or feature another ` +
      `task owns is not a defect of this one, even when the project brief requires it and it is still ` +
      `missing: do not reject or flag this task for it. Do reject a concrete defect in this task's own ` +
      `files, including an interface they expose that does not match what their acceptance criteria ` +
      `promise to other tasks.\n\n` +
      this.failureLocationSection(opts, taskId, ownership!)
    );
  }

  /** Which task is under a work review in this dispatch, if any: a reviewer or the Opposition, on
   * the attempt the engine is settling right now. Institutional ballots run in the same window but
   * judge procedure, not files, and say so with phase 'institutional'. */
  private workReviewTaskId(opts: DispatchOptions): string | undefined {
    if (!REVIEW_SCOPE_ROLES.has(opts.role) || opts.phase === 'institutional') return undefined;
    const taskId = opts.scopeTaskId ?? opts.taskId;
    return taskId !== undefined && this.runState.underReview?.[taskId] !== undefined ? taskId : undefined;
  }

  private failureLocationSection(opts: DispatchOptions, taskId: string, ownership: OwnershipMap): string {
    if (this.workReviewTaskId(opts) !== taskId) return '';
    return renderFailureLocations(failureLocations(this.runState.underReview?.[taskId], ownership), taskId);
  }

  private defectPathsSection(opts: DispatchOptions): string {
    if (!this.workReviewTaskId(opts)) return '';
    return (
      'Also include "defectPaths": string[] in your JSON. When your verdict is "reject" or "flag", list ' +
      'the repository files the defect is in, or [] when it is not in any one file. A reject must name ' +
      'a defect in the files this task owns.\n\n'
    );
  }

  /**
   * A reject whose every named defect lives in another task's files asks this task to repair code its
   * worker may not write. Sent back while retries remain; on the last attempt it stands as a flag, so
   * the concern still reaches the record without blocking work that is not at fault. Applied here so
   * every doctrine's reviewers are held to it alike. The paths also join evidenceRefs where the
   * schema has them, so ownership handoff reads them instead of mining prose.
   */
  private holdRejectToOwnedFiles(parsed: unknown, opts: DispatchOptions, correctiveAttempt: number): void {
    const taskId = this.workReviewTaskId(opts);
    const ownership = this.ownership?.();
    if (!taskId || !ownership || typeof parsed !== 'object' || parsed === null) return;
    const verdict = parsed as { verdict?: unknown; defectPaths?: unknown; rationale?: unknown; evidenceRefs?: unknown };
    const paths = Array.isArray(verdict.defectPaths)
      ? verdict.defectPaths.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    if (paths.length && Array.isArray(verdict.evidenceRefs)) {
      verdict.evidenceRefs = [...new Set([...verdict.evidenceRefs, ...paths])];
    }
    if (verdict.verdict !== 'reject' || paths.length === 0) return;
    const owned = (path: string) => otherOwners(path, '', ownership);
    const foreign = paths.filter((path) => owned(path).length > 0 && !owned(path).includes(taskId));
    if (foreign.length < paths.length) return;
    const described = foreign.map((path) => `${path} (owned by ${owned(path).join(', ')})`).join(', ');
    if (correctiveAttempt < MAX_CORRECTIVE_RETRIES) {
      const own = ownership.entries[taskId];
      const ownFiles = own ? [...own.paths, ...own.interfaces, ...own.generated, ...own.tests].join(', ') : '';
      throw new Error(
        `Your reject places the defect only in files other tasks own: ${described}. Task ${taskId} ` +
          `may not write them, so it cannot repair them. Reject only for a defect in this task's own ` +
          `files${ownFiles ? ` (${ownFiles})` : ''} and list those in defectPaths; a defect in another ` +
          `task's file is a flag, or approve if this task's own work is sound.`,
      );
    }
    verdict.verdict = 'flag';
    if (typeof verdict.rationale === 'string') {
      verdict.rationale += ` [Engine: recorded as a flag, not a reject — every file named as the defect's location is owned by another task: ${described}.]`;
    }
    this.ledger.record('review_reject_downgraded', { taskId, role: opts.role, personaId: opts.personaId, foreignPaths: foreign });
  }

  /**
   * The final barriers judge evidence they did not gather, and neither prompt said where it came
   * from. Twice on 2026-10-04 a verifier returned verified=false with nothing traced because it had
   * "not yet executed the required commands" or took the diff for "a proposed change rather than
   * the current repository state", and the delivery was refused for it. Written once here so every
   * doctrine's barrier reads the same account of its evidence.
   */
  private deliveryEvidenceSection(role: string): string {
    if (!DELIVERY_EVIDENCE_ROLES.has(role)) return '';
    return (
      'Where this evidence comes from: the diff is already applied. It is the current state of the ' +
      'repository, the same files the repository tools read, not a proposal. The check results were ' +
      'executed by the engine on exactly this tree. You cannot run commands and do not need to: decide ' +
      'on these results and the code. Read files with the repository tools where the diff is truncated ' +
      'or you need context. Withhold only for a defect or a gap you can name, never because you have ' +
      'not run or read something yourself.\n\n'
    );
  }

  private fallbackRepositorySection(opts: DispatchOptions): string {
    if (opts.repositoryContext === false || !REPOSITORY_CONTEXT_ROLES.has(opts.role) || !this.fallbackRepositoryContext) return '';
    try {
      const bundle = this.fallbackRepositoryContext(opts.taskId, opts.userPrompt);
      return bundle ? `Repository fallback bundle (read-only context):\n${bundle}\n\n` : '';
    } catch (error) {
      this.ledger.record('repository_fallback_failed', { role: opts.role, error: String(error) });
      return '';
    }
  }

  private repositoryToolsEnabled(target: DispatchTarget, opts: DispatchOptions): boolean {
    if (opts.repositoryTools === false || opts.repositoryContext === false) return false;
    return target.fallbackIndex === 0 &&
      target.modelEntry.supportsToolCalls &&
      Boolean(this.worktree) &&
      REPOSITORY_CONTEXT_ROLES.has(opts.role);
  }

  private async completeWithRepositoryTools(params: {
    target: DispatchTarget;
    opts: DispatchOptions;
    messages: ChatMessage[];
    correctiveAttempt: number;
  }): Promise<{ result: ChatCompletionResult; costUsd: number; promptTokens: number; completionTokens: number }> {
    let toolRounds = 0;
    let toolCalls = 0;
    let toolBytes = 0;
    let reviewCommandsRun = 0;
    let costUsd = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let finishWithoutTools = false;
    const phase = params.opts.phase ?? (ENGINEERING_ROLES.has(params.opts.role) ? 'engineering' : 'institutional');
    const maxToolRounds = phase === 'institutional' ? MAX_INSTITUTIONAL_TOOL_ROUNDS : MAX_TOOL_ROUNDS;
    const maxToolCalls = phase === 'institutional' ? MAX_INSTITUTIONAL_TOOL_CALLS : MAX_TOOL_CALLS;

    for (;;) {
      const result = await this.callAndRecord(params, toolRounds, !finishWithoutTools);
      costUsd += result.costUsd;
      promptTokens += result.promptTokens ?? 0;
      completionTokens += result.completionTokens ?? 0;
      if (!result.toolCalls?.length) return { result, costUsd, promptTokens, completionTokens };
      if (finishWithoutTools || !this.repositoryToolsEnabled(params.target, params.opts) || !this.worktree) {
        throw new Error(`Model ${params.target.modelId} returned repository tool calls when tools were unavailable`);
      }
      toolRounds += 1;
      if (toolRounds > maxToolRounds || toolCalls + result.toolCalls.length > maxToolCalls) {
        this.ledger.record('repository_tool_limit_reached', { role: params.opts.role, toolRounds, toolCalls });
        params.messages.push({ role: 'user', content: 'The repository-read limit is reached. Use the context already available and return the requested JSON now. Do not request more tools.' });
        finishWithoutTools = true;
        continue;
      }
      params.messages.push(result.assistantMessage ?? {
        role: 'assistant',
        content: result.text || null,
        tool_calls: result.toolCalls,
      });
      for (const call of result.toolCalls) {
        toolCalls += 1;
        let content: string;
        let metadata: Record<string, unknown>;
        if (call.function.name === RUN_REVIEW_COMMAND) {
          const outcome = await this.runReviewCommand(params.opts, call.function.arguments, reviewCommandsRun);
          content = outcome.content;
          // A refused call ran nothing, so it does not spend one of the critic's runs.
          if (outcome.ran) reviewCommandsRun += 1;
          params.messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content });
          continue;
        }
        try {
          const toolResult = executeRepositoryTool(
            this.worktree, call.function.name, call.function.arguments, this.retainedOverlay(params.opts.taskId));
          const remaining = MAX_TOOL_BYTES - toolBytes;
          const bytes = Buffer.byteLength(toolResult.content);
          content = bytes > remaining ? Buffer.from(toolResult.content).subarray(0, Math.max(0, remaining)).toString('utf8') : toolResult.content;
          const returnedBytes = Buffer.byteLength(content);
          toolBytes += returnedBytes;
          metadata = {
            tool: call.function.name,
            path: toolResult.path,
            paths: toolResult.paths,
            bytes: returnedBytes,
            truncated: toolResult.truncated || returnedBytes < bytes,
          };
        } catch (error) {
          content = JSON.stringify({ error: String(error) });
          metadata = { tool: call.function.name, bytes: Buffer.byteLength(content), truncated: false, failure: String(error) };
        }
        this.ledger.record('repository_tool_call', metadata);
        params.messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content });
      }
      if (toolBytes >= MAX_TOOL_BYTES || toolCalls >= maxToolCalls || toolRounds >= maxToolRounds) {
        params.messages.push({ role: 'user', content: 'The repository-read limit is reached. Use the context already available and return the requested JSON now. Do not request more tools.' });
        finishWithoutTools = true;
      }
    }
  }

  /**
   * One run_review_command call. Failures come back to the model as the tool's result rather than
   * throwing: a refused argument is the critic's to correct, not a reason to fail the review.
   */
  private async runReviewCommand(
    opts: DispatchOptions,
    rawArguments: string,
    alreadyRun: number,
  ): Promise<{ content: string; ran: boolean }> {
    const base = { role: opts.role, personaId: opts.personaId, ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}) };
    if (!REVIEW_COMMAND_ROLES.has(opts.role) || this.reviewCommands.length === 0) {
      const error = `${RUN_REVIEW_COMMAND} is not available to the ${opts.role} role`;
      this.ledger.record('review_command_refused', { ...base, reason: error });
      return { content: JSON.stringify({ error }), ran: false };
    }
    if (alreadyRun >= MAX_REVIEW_COMMANDS_PER_CALL) {
      const error = `At most ${MAX_REVIEW_COMMANDS_PER_CALL} review commands per verdict; decide on what you have.`;
      this.ledger.record('review_command_refused', { ...base, reason: error });
      return { content: JSON.stringify({ error }), ran: false };
    }
    const startedAtMs = Date.now();
    try {
      const result = await executeReviewCommand(this.worktree!, this.reviewCommands, rawArguments, this.checkSandbox);
      this.ledger.record('review_command_run', {
        role: opts.role,
        personaId: opts.personaId,
        taskId: opts.taskId,
        commandId: result.commandId,
        args: result.args,
        ran: result.ran,
        exitedZero: result.exitedZero,
        durationMs: Date.now() - startedAtMs,
      });
      return { content: result.content, ran: true };
    } catch (error) {
      this.ledger.record('review_command_refused', { ...base, reason: String(error).slice(0, 300) });
      return { content: JSON.stringify({ error: String(error) }), ran: false };
    }
  }

  private async callAndRecord(
    params: { target: DispatchTarget; opts: DispatchOptions; messages: ChatMessage[]; correctiveAttempt: number },
    toolRound: number,
    allowRepositoryTools = true,
  ): Promise<ChatCompletionResult> {
    const { target, opts, messages, correctiveAttempt } = params;
    const phase = opts.phase ?? (ENGINEERING_ROLES.has(opts.role) ? 'engineering' : 'institutional');
    this.budget.checkBeforeCall(this.runState, opts.taskId);
    const toolsEnabled = allowRepositoryTools && this.repositoryToolsEnabled(target, opts);
    const startedAtMs = Date.now();
    let result: ChatCompletionResult;
    try {
      result = await this.client.chatCompletion({
        model: target.modelId,
        modelEntry: target.modelEntry,
        messages,
        // Never alongside tools. Under response_format, solar-mini4 wrote each tool call as JSON
        // text instead of calling it (0 real calls in 6; 5 in 6 without it), so no implementer read
        // the repository in any sweep it ran. The prompt still asks for JSON and extractJson still
        // parses it; the tool-free final round gets response_format back.
        jsonMode: target.modelEntry.supportsJsonMode && !toolsEnabled,
        timeoutMs: opts.timeoutMs === undefined
          ? this.budget.perCallTimeoutMs(opts.role)
          : Math.min(this.budget.perCallTimeoutMs(opts.role), opts.timeoutMs),
        stallTimeout: this.budget.stallTimeout(),
        temperature: opts.temperature,
        // Repository exploration should answer the next concrete question quickly. A live
        // implementer spent 29k completion tokens deciding to read one more file; replaying
        // that context with low effort produced valid file operations in 16 seconds.
        // Explicit role settings still take precedence. Planner reconnaissance has shown the
        // same slow read-round pattern; its tool-free synthesis keeps the default budget.
        reasoningEffort: opts.reasoningEffort ?? (toolsEnabled && (phase === 'engineering' || opts.role === 'planner') ? 'low' : undefined),
        ...(toolsEnabled ? { tools: this.toolDefinitionsFor(opts), toolChoice: 'auto' as const } : {}),
      });
    } catch (error) {
      // A call that threw still consumed whatever the provider generated before we gave up on it,
      // and nothing here can price that: no response means no usage and no cost. Recording the
      // call keeps it visible, because 54 of these in one benchmark trial were spent on the most
      // expensive model in the roster while `costUsd` and `timeoutCount` both reported nothing.
      const failedCallId = this.ledger.recordTranscript({
        role: opts.role,
        personaId: opts.personaId,
        taskId: opts.taskId,
        model: target.modelId,
        fallbackIndex: target.fallbackIndex,
        attempt: correctiveAttempt,
        toolRound,
        messages,
        error: String(error),
      });
      this.ledger.record('worker_call_unmetered', {
        role: opts.role,
        model: target.modelId,
        phase,
        durationMs: Date.now() - startedAtMs,
        timedOut: (error as Error & { timeout?: boolean }).timeout === true,
        ...((error as Error & { stalled?: boolean }).stalled ? { stalled: true } : {}),
        error: String(error).slice(0, 200),
        ...(failedCallId !== undefined ? { callId: failedCallId } : {}),
      });
      // A provider request used a worker-call slot even when it returned no usage data.
      // Otherwise repeated timeouts could bypass maxWorkerCalls entirely.
      this.runState.workerCalls += 1;
      this.persistProgress();
      throw error;
    }
    const { warn } = this.budget.recordSpend(this.runState, {
      costUsd: result.costUsd,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
    }, opts.taskId);
    const callId = this.ledger.recordTranscript({
      role: opts.role,
      personaId: opts.personaId,
      taskId: opts.taskId,
      model: target.modelId,
      fallbackIndex: target.fallbackIndex,
      attempt: correctiveAttempt,
      toolRound,
      messages,
      responseText: result.text,
      toolCalls: result.toolCalls,
    });
    // The digests are provenance without opt-in transcripts: a transcript, when kept, must hash to them.
    this.ledger.record('worker_call', {
      role: opts.role,
      personaId: opts.personaId,
      ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
      model: target.modelId,
      promptDigest: contentDigest(messages),
      responseDigest: contentDigest({ text: result.text, toolCalls: result.toolCalls ?? [] }),
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      costUsd: result.costUsd,
      costMetered: result.costMetered,
      attempt: correctiveAttempt,
      toolRound,
      phase,
      durationMs: Date.now() - startedAtMs,
      fallbackIndex: target.fallbackIndex,
      networkRetries: result.attempts - 1,
      timedOut: result.timedOut,
      ...(result.stalled ? { stalled: true } : {}),
      ...(result.provider !== undefined ? { provider: result.provider } : {}),
      ...(callId !== undefined ? { callId } : {}),
    });
    this.persistProgress();
    if (warn) logger.warn('Run approaching per-run budget', { runId: this.runState.runId, costUsd: this.runState.costUsd });
    return result;
  }
}
