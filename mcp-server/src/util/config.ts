import type { CheckSandbox } from './sandbox.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { parseStrategiesConfig } from '../constitution/schema.js';

export interface ModelEntry {
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  supportsJsonMode: boolean;
  supportsToolCalls: boolean;
  /** Context window in tokens, from OpenRouter's catalog. Prompt budgets that scale with the model
   * (the delivery diff the barriers read) use it; unknown means a conservative default. */
  contextLength?: number | null;
  /**
   * Which OpenRouter API serves the model. 'decisions' models (OpenRouter's alpha Decisions API)
   * answer typed questions with probabilities and cannot take a chat request; only
   * WorkerDispatcher.decide uses them. Omitted means 'chat'.
   */
  api?: 'chat' | 'decisions';
}

export function isDecisionModel(entry: ModelEntry | undefined): boolean {
  return entry?.api === 'decisions';
}

export interface ModelsConfig {
  roles: Record<string, { primary: string; fallback: string }>;
  models: Record<string, ModelEntry>;
}

export interface ModelsLocalOverride {
  primary: string;
  fallback: string;
  updatedAt: string;
  modelEntries: Record<string, ModelEntry>;
}

const MODELS_LOCAL_FILE = 'models.local.json';
const DEFAULT_MAX_TASK_ATTEMPTS = 3;

export interface BudgetConfig {
  defaults: {
    perRunUsd: number;
    perTaskUsd: number;
    maxWorkerCalls: number;
    maxWallClockMinutes: number;
    maxTaskAttempts: number;
    maxInstitutionalCallsPerTask?: number;
    perCallTimeoutMs: number;
    /** Per-role override of perCallTimeoutMs, keyed by the role name in config/models.yaml
     * (e.g. 'implementer'). Roles not listed here use perCallTimeoutMs. Optional. */
    perCallTimeoutMsByRole?: Record<string, number>;
    /** When set, calls stream and fail over once the model goes silent this long; the per-call
     * timeout then only bounds a model that keeps talking. Unset keeps calls unstreamed. */
    stallTimeout?: { firstTokenMs: number; betweenTokensMs: number };
    warnAtFractionOfPerRun: number;
  };
  hardCeilingUsd: number;
}

// The engine hands each strategy its own slice untyped. loadStrategiesConfig validates the whole
// file against constitution/schema.ts and fills every default before it gets that far, and each
// strategy's config type is inferred from the same schema.
export type StrategiesConfig = Record<string, Record<string, unknown>>;

function loadYaml<T>(configDir: string, file: string): T {
  const full = path.join(configDir, file);
  return yaml.load(readFileSync(full, 'utf8')) as T;
}

export function loadModelsConfig(configDir: string): ModelsConfig {
  return loadYaml<ModelsConfig>(configDir, 'models.yaml');
}

// Written by `swarm_configure_models` (surfaced via /swarm-setup). Absent until the user
// has run setup at least once — that's the "no override yet" case, callers fall back to
// config/models.yaml's built-in roster.
export function loadModelsLocalOverride(configDir: string): ModelsLocalOverride | null {
  const full = path.join(configDir, MODELS_LOCAL_FILE);
  if (!existsSync(full)) return null;
  return JSON.parse(readFileSync(full, 'utf8')) as ModelsLocalOverride;
}

export function saveModelsLocalOverride(configDir: string, override: ModelsLocalOverride): void {
  const full = path.join(configDir, MODELS_LOCAL_FILE);
  writeFileSync(full, JSON.stringify(override, null, 2), 'utf8');
}

// Re-read on every run start (see SwarmEngine.startRun) so /swarm-setup takes effect
// immediately, without restarting the long-lived MCP server process.
export function resolveModelsConfig(configDir: string, base: ModelsConfig): ModelsConfig {
  const override = loadModelsLocalOverride(configDir);
  if (!override) return base;

  // The override names chat models, so a role served by decision models (decider) keeps its own.
  const roles = Object.fromEntries(
    Object.entries(base.roles).map(([role, entry]) => [
      role,
      isDecisionModel(base.models[entry.primary]) ? entry : { primary: override.primary, fallback: override.fallback },
    ]),
  );
  return { roles, models: { ...base.models, ...override.modelEntries } };
}

export function loadBudgetConfig(configDir: string): BudgetConfig {
  const config = loadYaml<BudgetConfig>(configDir, 'budget.yaml');
  return {
    ...config,
    defaults: {
      ...config.defaults,
      maxTaskAttempts: config.defaults.maxTaskAttempts ?? DEFAULT_MAX_TASK_ATTEMPTS,
    },
  };
}

/** Throws, naming each bad key path, when strategies.yaml does not match the schema. */
export function loadStrategiesConfig(configDir: string): StrategiesConfig {
  return parseStrategiesConfig(loadYaml<unknown>(configDir, 'strategies.yaml'), path.join(configDir, 'strategies.yaml'));
}

/**
 * One verification category. Section 9 of every philosophy doc requires the swarm to select "all
 * checks applicable to the repository and change: unit, integration, regression and security
 * tests; type-checking and linting; build validation; and documentation checks" — and to record a
 * reason for any category it omits rather than passing over it in silence.
 */
export interface CheckCategory {
  id: string;
  command: string;
  args: string[];
  timeoutMs: number;
  /** A failing required category blocks acceptance. An optional one is disclosed as a limitation. */
  required: boolean;
}

/**
 * A command a critic may run before its verdict. The engine fixes the program and its leading
 * arguments; the critic may only append arguments, which repositoryTools.ts validates. It runs in
 * a throwaway copy of the worktree, so nothing it writes reaches the tree under review.
 */
export interface ReviewCommand {
  id: string;
  /** Shown to the critic: what the command does and what arguments it takes. */
  description: string;
  command: string;
  args: string[];
  timeoutMs: number;
  /** Longest argument the critic may pass; 200 unless raised, e.g. for a code snippet. */
  maxArgChars?: number;
}

export interface ChecksConfig {
  categories: CheckCategory[];
  /** Commands reviewers may run before their verdict. Undeclared, each check category is offered
   * with arguments the critic appends; an explicit empty list offers none. */
  reviewCommands: ReviewCommand[];
  /** Paths the engine treats as tests for the non-waivable integrity floor (section 9). */
  testPathGlobs: string[];
  /** Cap on strategy.execute() calls the engine runs concurrently for disjoint-ownership nodes. */
  maxConcurrentExecutes: number;
  /**
   * Whether a named manual inspection can stand as a criterion's evidence. True where a person
   * reads the manual rows before accepting; false headless (the benchmark), where nobody performs
   * them and the evaluator refuses them, so the test mandate must name a check for every criterion.
   */
  manualEvidenceAccepted: boolean;
  /** Where checks run: 'none' (the user's environment, scrubbed) or 'bubblewrap' (no network,
   * read-only filesystem except the worktree). See util/sandbox.ts. */
  sandbox: CheckSandbox;
  /** The first required category, kept so single-command call sites stay readable. */
  readonly command: string;
  readonly args: string[];
  readonly timeoutMs: number;
}

const DEFAULT_CATEGORY: CheckCategory = {
  id: 'unit',
  command: 'npm',
  args: ['test', '--silent'],
  timeoutMs: 60_000,
  required: true,
};

const DEFAULT_TEST_PATH_GLOBS = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
];

interface RawChecksConfig {
  categories?: Array<Partial<CheckCategory>>;
  reviewCommands?: Array<Partial<ReviewCommand>>;
  testPathGlobs?: string[];
  maxConcurrentExecutes?: number;
  manualEvidenceAccepted?: boolean;
  sandbox?: CheckSandbox;
  // Pre-categories format, still honoured: a single command/args/timeoutMs triple.
  command?: string;
  args?: string[];
  timeoutMs?: number;
}

function parseSandbox(value: unknown): CheckSandbox {
  if (value === undefined || value === 'none') return 'none';
  if (value === 'bubblewrap') return 'bubblewrap';
  // A typo here would otherwise run checks unconfined while the operator believes they are not.
  throw new Error(`config/checks.yaml: sandbox must be "none" or "bubblewrap", got ${JSON.stringify(value)}.`);
}

/**
 * A check category offered to critics as a review command, so on any repository a critic can run
 * one test file or a name filter rather than only reading the whole suite's result.
 */
function reviewCommandFromCategory(category: CheckCategory): ReviewCommand {
  const invocation = [category.command, ...category.args].join(' ');
  return {
    id: category.id,
    description:
      `the "${category.id}" check (${invocation}) with arguments you append, e.g. one test file or a test-name ` +
      'filter; with npm scripts, put "--" before arguments meant for the test runner',
    command: category.command,
    args: category.args,
    timeoutMs: category.timeoutMs,
  };
}

function parseReviewCommand(raw: Partial<ReviewCommand>, index: number): ReviewCommand {
  if (!raw.id || !raw.command) {
    throw new Error(`config/checks.yaml: reviewCommands[${index}] needs an id and a command.`);
  }
  return {
    id: raw.id,
    description: raw.description ?? `${[raw.command, ...(raw.args ?? [])].join(' ')} [arguments]`,
    command: raw.command,
    args: raw.args ?? [],
    timeoutMs: raw.timeoutMs ?? DEFAULT_CATEGORY.timeoutMs,
    ...(raw.maxArgChars !== undefined ? { maxArgChars: raw.maxArgChars } : {}),
  };
}

/**
 * Normalizes both the current categories format and the original single-command format. The shim
 * matters beyond old config files on disk: SwarmEngine accepts an in-memory `checksConfig`
 * override for target repos that aren't Node/npm, and tests construct one by hand.
 */
export function normalizeChecksConfig(raw: RawChecksConfig | Partial<ChecksConfig> | undefined): ChecksConfig {
  const source = (raw ?? {}) as RawChecksConfig;
  let categories: CheckCategory[];

  if (source.categories?.length) {
    categories = source.categories.map((c, i) => ({
      id: c.id ?? `check-${i + 1}`,
      command: c.command ?? DEFAULT_CATEGORY.command,
      args: c.args ?? [],
      timeoutMs: c.timeoutMs ?? DEFAULT_CATEGORY.timeoutMs,
      required: c.required ?? false,
    }));
  } else if (source.command) {
    categories = [
      {
        ...DEFAULT_CATEGORY,
        command: source.command,
        args: source.args ?? [],
        timeoutMs: source.timeoutMs ?? DEFAULT_CATEGORY.timeoutMs,
      },
    ];
  } else {
    categories = [{ ...DEFAULT_CATEGORY }];
  }

  const primary = categories.find((c) => c.required) ?? categories[0];
  return {
    categories,
    reviewCommands: source.reviewCommands === undefined
      ? categories.map(reviewCommandFromCategory)
      : source.reviewCommands.map(parseReviewCommand),
    testPathGlobs: source.testPathGlobs?.length ? source.testPathGlobs : DEFAULT_TEST_PATH_GLOBS,
    maxConcurrentExecutes: Math.max(1, source.maxConcurrentExecutes ?? 3),
    manualEvidenceAccepted: source.manualEvidenceAccepted ?? true,
    sandbox: parseSandbox(source.sandbox),
    command: primary.command,
    args: primary.args,
    timeoutMs: primary.timeoutMs,
  };
}

// Re-read on every run start (see SwarmEngine.buildContext), same pattern as resolveModelsConfig,
// so editing config/checks.yaml takes effect immediately without restarting the MCP server.
export function loadChecksConfig(configDir: string): ChecksConfig {
  const full = path.join(configDir, 'checks.yaml');
  if (!existsSync(full)) return normalizeChecksConfig(undefined);
  return normalizeChecksConfig(loadYaml<RawChecksConfig>(configDir, 'checks.yaml'));
}
