// The model bench's suite: six short calls shaped like the ones the strategies actually make, each
// graded mechanically rather than by another model.
//
// modelProbe.ts asks only whether a model can emit the JSON shape. That let a model that returns
// well-formed `pass` stubs pass, so here the implementer's code is executed against hidden tests
// and every case has a check that a made-up answer cannot satisfy: an edit's `find` text must be in
// the file it was given, a task may only depend on ids the plan defines, and a review may only cite
// files that were in front of it.

import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  PLANNER_SCHEMA_DESCRIPTION,
  validatePlannerOutput,
  IMPLEMENTER_SYSTEM_PROMPT,
  IMPLEMENTER_SCHEMA_DESCRIPTION,
  validateImplementerOutput,
  REVIEWER_SYSTEM_PROMPT,
  REVIEWER_SCHEMA_DESCRIPTION,
  validateReviewerOutput,
} from '../strategies/managerial/prompts.js';
import {
  committeeSchemaDescription,
  coordinatorBallotSchemaDescription,
  coordinatorBallotSystemPrompt,
  coordinatorBallotUserPrompt,
  validateCommitteeVerdict,
} from '../strategies/democratic/prompts.js';
import { placeholderFileWrites } from '../engine/placeholderBody.js';

export type BenchRole = 'planner' | 'implementer' | 'reviewer' | 'voter';

export interface Grade {
  ok: boolean;
  kind?: 'hallucination' | 'wrong';
  detail?: string;
}

export interface PythonRun {
  ok: boolean;
  output: string;
}

export type PythonRunner = (files: Record<string, string>, testCode: string) => Promise<PythonRun>;

export interface BenchCase {
  id: string;
  role: BenchRole;
  systemPrompt: string;
  userPrompt: string;
  schemaDescription: string;
  validate: (value: unknown) => void;
  /** Implementer cases get one corrective retry, as WorkerDispatcher gives them. */
  retryable: boolean;
  grade: (value: unknown, runPython: PythonRunner) => Promise<Grade>;
}

// Bumped whenever a case changes, so cached verdicts earned against an older suite are re-earned.
// 2: prompts now end with the dispatcher's own JSON suffix (jsonResponseSuffix), not a stale copy.
// 3: that suffix keeps its file-escaping example for the implementer only.
export const SUITE_VERSION = 3;

const PY_TIMEOUT_MS = 10_000;
const HIDDEN_TEST_FILE = '_bench_hidden_test.py';
const PY_FILE_PATTERN = /[\w./-]+\.py\b/g;

// ---------- sandboxed execution ----------

export type SandboxMode = 'bwrap' | 'static';

// Used only when bubblewrap is unavailable: without a namespace the code runs as the user, so
// anything that reaches outside the temp dir is refused rather than run. None of the tasks needs it.
const UNSAFE_PYTHON = /\b(subprocess|socket|shutil|ctypes|urllib|requests|http\.client)\b|os\.(system|popen|remove|unlink|rmdir|exec)|__import__|\beval\(|\bexec\(|\bopen\(/;

function run(command: string, args: string[], cwd: string): Promise<PythonRun> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: PY_TIMEOUT_MS, env: {}, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}${stderr}${err && !stderr ? String(err.message) : ''}`.trim() });
    });
  });
}

function bwrapArgs(dir: string): string[] {
  return [
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/lib64', '/lib64',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/bin', '/bin',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--bind', dir, '/work',
    '--chdir', '/work',
    '--unshare-all',
    '--die-with-parent',
    '--clearenv',
    '--setenv', 'PATH', '/usr/bin',
    // -E -s rather than -I: -I also drops the script's directory from sys.path, which would make
    // every `from ranges import ...` fail regardless of the model.
    'python3', '-E', '-s', HIDDEN_TEST_FILE,
  ];
}

export async function detectSandbox(): Promise<SandboxMode> {
  const dir = mkdtempSync(path.join(tmpdir(), 'bench-probe-'));
  try {
    writeFileSync(path.join(dir, HIDDEN_TEST_FILE), 'print("ok")\n');
    const probe = await run('bwrap', bwrapArgs(dir), dir);
    return probe.ok && probe.output === 'ok' ? 'bwrap' : 'static';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function pythonRunner(mode: SandboxMode): PythonRunner {
  return async (files, testCode) => {
    if (mode === 'static') {
      const unsafe = Object.entries(files).find(([, content]) => UNSAFE_PYTHON.test(content));
      if (unsafe) return { ok: false, output: `UNSAFE: ${unsafe[0]} uses a refused API` };
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'bench-run-'));
    try {
      for (const [file, content] of Object.entries(files)) {
        const target = path.join(dir, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
      writeFileSync(path.join(dir, HIDDEN_TEST_FILE), testCode);
      return mode === 'bwrap'
        ? await run('bwrap', bwrapArgs(dir), dir)
        : await run('python3', ['-E', '-s', HIDDEN_TEST_FILE], dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// ---------- shared grading helpers ----------

interface FileOp {
  op: 'write' | 'edit' | 'delete';
  path: string;
  content?: string;
  find?: string;
  replace?: string;
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, '');
}

/** Applies file operations to `base`. An edit whose `find` text is absent from the file it was
 * given, or that targets a file it was never given, is invented, so it is reported as a
 * hallucination rather than as a wrong answer. */
export function applyFileOps(
  base: Readonly<Record<string, string>>,
  ops: readonly FileOp[],
): { files: Record<string, string> } | Grade {
  const files = { ...base };
  for (const op of ops) {
    const file = normalizePath(op.path);
    if (op.op === 'write') {
      files[file] = op.content ?? '';
    } else if (op.op === 'delete') {
      delete files[file];
    } else {
      const current = files[file];
      if (current === undefined) return { ok: false, kind: 'hallucination', detail: `edit targets ${file}, which does not exist` };
      const occurrences = current.split(op.find ?? '').length - 1;
      if (!op.find || occurrences === 0) {
        return { ok: false, kind: 'hallucination', detail: `edit find text is not in ${file}` };
      }
      if (occurrences > 1) return { ok: false, kind: 'wrong', detail: `edit find text is ambiguous in ${file}` };
      files[file] = current.replace(op.find, op.replace ?? '');
    }
  }
  return { files };
}

/** The exception line first — it is what explains the failure, and the 300-char cut must not lose it. */
function tail(output: string): string {
  const lines = output.trim().split('\n');
  return [lines.at(-1) ?? '', ...lines.slice(-4, -1)].join(' | ').slice(0, 300);
}

/** Reads a failed test run. Importing a module that does not exist is an invented dependency. */
export function gradeTestRun(result: PythonRun, ownModules: readonly string[]): Grade {
  if (result.ok) return { ok: true };
  if (result.output.startsWith('UNSAFE:')) return { ok: false, kind: 'hallucination', detail: result.output };
  const missing = /ModuleNotFoundError: No module named '([^']+)'/.exec(result.output);
  if (missing && !ownModules.includes(missing[1]!)) {
    return { ok: false, kind: 'hallucination', detail: `imports non-existent module ${missing[1]}` };
  }
  return { ok: false, kind: 'wrong', detail: tail(result.output) };
}

function stubGrade(value: unknown): Grade | null {
  const stubs = placeholderFileWrites(value);
  return stubs.length ? { ok: false, kind: 'hallucination', detail: `placeholder body in ${stubs.join(', ')}` } : null;
}

/** evidenceRefs may only cite files that were in the prompt. */
export function inventedRefs(refs: readonly string[] | undefined, known: readonly string[]): string[] {
  return (refs ?? []).flatMap((ref) => (ref.match(PY_FILE_PATTERN) ?? []).filter((file) => !known.some((k) => k.endsWith(file) || file.endsWith(k))));
}

// ---------- case 1: planner ----------

export function gradePlan(value: unknown): Grade {
  const { tasks } = value as { tasks: { id: string; dependsOn: string[]; targetGlobs: string[] }[] };
  const ids = new Set(tasks.map((t) => t.id));
  const dangling = tasks.flatMap((t) => t.dependsOn.filter((d) => !ids.has(d)));
  if (dangling.length) return { ok: false, kind: 'hallucination', detail: `depends on undefined task ids: ${dangling.join(', ')}` };
  if (tasks.length !== 3) return { ok: false, kind: 'wrong', detail: `asked for exactly 3 tasks, got ${tasks.length}` };
  if (tasks.some((t) => t.targetGlobs.length === 0)) return { ok: false, kind: 'wrong', detail: 'a task has no targetGlobs' };
  if (!tasks.some((t) => t.dependsOn.length > 0)) return { ok: false, kind: 'wrong', detail: 'no task depends on another' };

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const cyclic = (id: string): boolean => {
    if (done.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    const found = (byId.get(id)?.dependsOn ?? []).some(cyclic);
    visiting.delete(id);
    done.add(id);
    return found;
  };
  if (tasks.some((t) => cyclic(t.id))) return { ok: false, kind: 'wrong', detail: 'dependency cycle' };
  return { ok: true };
}

const plannerCase: BenchCase = {
  id: 'planner',
  role: 'planner',
  systemPrompt: 'You are a planner. Break the request into a small dependency-ordered task graph.',
  userPrompt:
    'Plan exactly three tasks for building a Python command-line tool `csvstat` that reads a CSV file and prints the ' +
    'mean of a named numeric column. The tasks must be dependency-ordered: use dependsOn to reference the ids of ' +
    'earlier tasks in this same plan, and give every task at least one targetGlob.',
  schemaDescription: PLANNER_SCHEMA_DESCRIPTION,
  validate: validatePlannerOutput,
  retryable: false,
  grade: async (value) => gradePlan(value),
};

// ---------- case 2: implementer writes a new module ----------

const RANGES_TESTS = `from ranges import parse_ranges
assert parse_ranges("1-3,5") == [1, 2, 3, 5], parse_ranges("1-3,5")
assert parse_ranges("") == []
assert parse_ranges("   ") == []
assert parse_ranges(" 7 , 2-3 ") == [2, 3, 7]
assert parse_ranges("3,1-3") == [1, 2, 3]
assert parse_ranges("4-4") == [4]
for bad in ["5-3", "a", "1-", "1,,2"]:
    try:
        parse_ranges(bad)
    except ValueError:
        pass
    else:
        raise AssertionError(f"expected ValueError for {bad!r}")
print("ok")
`;

const implementWriteCase: BenchCase = {
  id: 'implement-write',
  role: 'implementer',
  systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
  userPrompt:
    'Assigned task: create ranges.py containing a function parse_ranges(spec: str) -> list[int].\n\n' +
    'Acceptance criteria:\n' +
    '- Parses a comma-separated list of non-negative integers and inclusive ranges: "1-3,5" returns [1, 2, 3, 5].\n' +
    '- Whitespace around items is ignored; an empty or whitespace-only string returns [].\n' +
    '- The result is sorted ascending with duplicates removed.\n' +
    '- A reversed range such as "5-3", a non-integer item, an incomplete range such as "1-", or an empty item ' +
    'such as the middle of "1,,2" raises ValueError.\n' +
    '- Standard library only.\n\n' +
    'Expected paths: ranges.py',
  schemaDescription: IMPLEMENTER_SCHEMA_DESCRIPTION,
  validate: validateImplementerOutput,
  retryable: true,
  grade: async (value, runPython) => {
    const stub = stubGrade(value);
    if (stub) return stub;
    const applied = applyFileOps({}, (value as { fileOps: FileOp[] }).fileOps);
    if (!('files' in applied)) return applied;
    return gradeTestRun(await runPython(applied.files, RANGES_TESTS), ['ranges']);
  },
};

// ---------- case 3: implementer fixes a bug with an exact edit ----------

export const STATS_PY = `"""Small statistics helpers."""


def mean(values):
    if not values:
        raise ValueError("mean of empty sequence")
    return sum(values) / len(values)


def median(values):
    if not values:
        raise ValueError("median of empty sequence")
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[mid]
    return (ordered[mid] + ordered[mid + 1]) / 2


def clamp(value, low, high):
    if low > high:
        raise ValueError("low must not exceed high")
    return max(low, min(value, high))
`;

const STATS_TESTS = `from stats import mean, median, clamp
assert median([1, 2, 3, 4]) == 2.5, median([1, 2, 3, 4])
assert median([4, 1, 3, 2]) == 2.5
assert median([3, 1, 2]) == 2
assert median([5]) == 5
assert median([1, 3]) == 2
assert mean([1, 2, 3]) == 2
assert clamp(5, 0, 3) == 3 and clamp(-1, 0, 3) == 0
for fn in (mean, median):
    try:
        fn([])
    except ValueError:
        pass
    else:
        raise AssertionError("empty input must raise")
print("ok")
`;

const implementEditCase: BenchCase = {
  id: 'implement-edit',
  role: 'implementer',
  systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
  userPrompt:
    'Assigned task: fix a bug in stats.py. median([1, 2, 3, 4]) returns 3.5, but it should return 2.5.\n\n' +
    'Acceptance criteria:\n' +
    '- median returns the correct value for even- and odd-length input.\n' +
    '- Fix it with exact "edit" operations on stats.py; do not rewrite the whole file and do not change the other functions.\n\n' +
    `Current contents of stats.py:\n\`\`\`python\n${STATS_PY}\`\`\`\n\n` +
    'Expected paths: stats.py',
  schemaDescription: IMPLEMENTER_SCHEMA_DESCRIPTION,
  validate: validateImplementerOutput,
  retryable: true,
  grade: async (value, runPython) => {
    const ops = (value as { fileOps: FileOp[] }).fileOps;
    if (!ops.some((op) => op.op === 'edit')) return { ok: false, kind: 'wrong', detail: 'rewrote the file instead of an edit' };
    const applied = applyFileOps({ 'stats.py': STATS_PY }, ops);
    if (!('files' in applied)) return applied;
    return gradeTestRun(await runPython(applied.files, STATS_TESTS), ['stats']);
  },
};

// ---------- cases 4 and 5: reviewer ----------

const CHUNK_TASK =
  'Task: implement chunk(items, size) in chunks.py\n' +
  'Description: split a list into consecutive sub-lists.\n\n' +
  'Acceptance criteria:\n' +
  '- Returns consecutive lists of length size; the last list may be shorter.\n' +
  '- Every input element appears exactly once, in order.\n' +
  '- size < 1 raises ValueError.\n\n' +
  'Implementer rationale: list comprehension over range with a step of size.\n\n';

function chunkReview(body: string, testResult: string): string {
  const fileOps = [{ op: 'write', path: 'chunks.py', content: body }];
  return `${CHUNK_TASK}File operations:\n${JSON.stringify(fileOps)}\n\nTest result: ${testResult}`;
}

const CHUNK_DEFECTIVE =
  'def chunk(items, size):\n    if size < 1:\n        raise ValueError("size must be at least 1")\n' +
  '    return [items[i:i + size] for i in range(0, len(items) - 1, size)]\n';
const CHUNK_SOUND =
  'def chunk(items, size):\n    if size < 1:\n        raise ValueError("size must be at least 1")\n' +
  '    return [items[i:i + size] for i in range(0, len(items), size)]\n';
const REVIEW_KNOWN_FILES = ['chunks.py', 'tests/test_chunks.py'];
// chunk([1, 2, 3], 2) returns [[1, 2]]: the `- 1` drops a final single-element chunk.
const NAMES_THE_DEFECT = /len\(items\)\s*-\s*1|-\s*1\b|off[- ]by[- ]one|last|final|trailing|drop|miss|lost|omit|remainder|skip/i;

function reviewCase(id: string, body: string, testResult: string, expected: 'approve' | 'reject'): BenchCase {
  return {
    id,
    role: 'reviewer',
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    userPrompt: chunkReview(body, testResult),
    schemaDescription: REVIEWER_SCHEMA_DESCRIPTION,
    validate: validateReviewerOutput,
    retryable: false,
    grade: async (value) => {
      const review = value as { verdict: string; rationale: string; evidenceRefs?: string[] };
      const invented = inventedRefs(review.evidenceRefs, REVIEW_KNOWN_FILES);
      if (invented.length) return { ok: false, kind: 'hallucination', detail: `cites files not in the review: ${invented.join(', ')}` };
      if (review.verdict !== expected) return { ok: false, kind: 'wrong', detail: `verdict ${review.verdict}, expected ${expected}` };
      if (expected === 'reject' && !NAMES_THE_DEFECT.test(review.rationale)) {
        return { ok: false, kind: 'wrong', detail: 'rejected without naming the dropped final chunk' };
      }
      return { ok: true };
    },
  };
}

// ---------- case 6: democratic committee ballot ----------

const ballotCase: BenchCase = {
  id: 'ballot',
  role: 'voter',
  systemPrompt:
    'You sit on a standing committee that decides whether a motion proceeds to implementation. Judge the motion on its merits.',
  userPrompt:
    'Motion: add a slugify helper\n' +
    'Description: create text_utils.py with slugify(title: str) -> str, which lowercases the title, replaces each run ' +
    'of characters other than a-z and 0-9 with a single hyphen, and strips leading and trailing hyphens. ' +
    'Add tests/test_text_utils.py covering "Hello, World!" -> "hello-world" and "" -> "".\n\n' +
    'Acceptance criteria:\n- slugify("Hello, World!") == "hello-world"\n- slugify("  --A  B--  ") == "a-b"\n- slugify("") == ""\n\n' +
    'Files this motion will create or change: text_utils.py, tests/test_text_utils.py\n' +
    'The motion has not been implemented yet, so any of these files may not exist: creating them is the motion\'s ' +
    'work, and their absence is not a reason to refuse it.\n\n' +
    'Give your committee verdict on whether this motion should proceed to implementation.',
  schemaDescription: committeeSchemaDescription,
  validate: validateCommitteeVerdict,
  retryable: false,
  grade: async (value) => {
    const { verdict } = value as { verdict: string };
    return verdict === 'approve' ? { ok: true } : { ok: false, kind: 'wrong', detail: `voted ${verdict} on a sound, fully specified motion` };
  },
};

// ---------- election: abstention across constituencies ----------

// The committee ballot above has one right answer, so it cannot see a model that abstains whenever
// it has no reason to prefer anyone. solar-mini4 passed it and then abstained on 18 of 24 replays of
// the real Prime Coordinator ballot, leaving a democratic run without a government. These are that
// ballot, verbatim, once per constituency, with every candidate at the no-record score of 0.5.
export const ELECTION_SUITE_VERSION = 3;
/** Above this share of abstentions a model cannot hold the voter role, and it loses one tier. */
export const MAX_ELECTION_ABSTENTION = 0.25;
const ELECTION_CONSTITUENCIES = ['frontend', 'backend', 'data', 'security', 'testing', 'documentation', 'user-experience', 'operations'];
const ELECTION_CANDIDATES = ['prime-coordinator-t1c1', 'prime-coordinator-t1c2', 'prime-coordinator-t1c3'];

export const ELECTION_CASES: BenchCase[] = ELECTION_CONSTITUENCIES.map((constituency) => ({
  id: `election-${constituency}`,
  role: 'voter',
  systemPrompt: coordinatorBallotSystemPrompt(constituency),
  userPrompt: coordinatorBallotUserPrompt(ELECTION_CANDIDATES.map((candidate) => ({ candidate, score: 0.5 }))),
  schemaDescription: coordinatorBallotSchemaDescription,
  validate: (value: unknown) => {
    if (typeof value !== 'object' || value === null || !('candidate' in value)) throw new Error('The ballot must have a candidate field.');
    const { candidate } = value as { candidate: unknown };
    if (candidate !== null && (typeof candidate !== 'string' || !ELECTION_CANDIDATES.includes(candidate))) {
      throw new Error('The ballot must name a listed candidate or abstain.');
    }
  },
  retryable: false,
  grade: async (value) => (value as { candidate: string | null }).candidate === null
    ? { ok: false, kind: 'wrong', detail: 'abstained between interchangeable candidates' }
    : { ok: true },
}));

// ---------- repository tool use ----------

export const TOOL_SUITE_VERSION = 1;
/** Below this share of real repository calls a model cannot hold a tool-using role. */
export const MIN_TOOL_CALL_RATE = 2 / 3;

export interface ToolBenchCase {
  id: string;
  role: 'implementer' | 'reviewer';
  systemPrompt: string;
  userPrompt: string;
  expectedPath: string;
}

const TOOL_SYSTEM_PROMPT =
  'You have read-only repository tools. You must read the relevant files with those tools rather than guess. ' +
  'After using the tools, return your final answer as JSON.';

export const TOOL_CASES: ToolBenchCase[] = [
  {
    id: 'tools-implementer-signature',
    role: 'implementer',
    systemPrompt: TOOL_SYSTEM_PROMPT,
    expectedPath: 'src/engine/repositoryTools.ts',
    userPrompt: 'Read src/engine/repositoryTools.ts with your repository tools before answering. What is the signature of executeRepositoryTool?',
  },
  {
    id: 'tools-reviewer-verify',
    role: 'reviewer',
    systemPrompt: TOOL_SYSTEM_PROMPT,
    expectedPath: 'src/engine/WorkerDispatcher.ts',
    userPrompt: 'Verify whether src/engine/WorkerDispatcher.ts enables JSON mode when repository tools are supplied. Read the file with a repository tool before answering.',
  },
  {
    id: 'tools-implementer-exports',
    role: 'implementer',
    systemPrompt: TOOL_SYSTEM_PROMPT,
    expectedPath: 'src/smoke/modelBenchCases.ts',
    userPrompt: 'Use your read-only repository tools to inspect src/smoke/modelBenchCases.ts, then report which suite-version constants the module exports.',
  },
];

export const BENCH_CASES: BenchCase[] = [
  plannerCase,
  implementWriteCase,
  implementEditCase,
  reviewCase('review-defective', CHUNK_DEFECTIVE, 'passed: 1 test (tests/test_chunks.py::test_even_split)', 'reject'),
  reviewCase('review-sound', CHUNK_SOUND, 'passed: 3 tests (tests/test_chunks.py)', 'approve'),
  ballotCase,
];

// ---------- hard tier ----------
//
// The six cases above catch broken models, but 72 models passed all of them, so they cannot rank
// capable ones. The hard tier mirrors the two shapes real runs actually failed on: a multi-file
// package with a CLI entry point (the benchmark's recurring blocker was an unfinished
// alloydamage/__main__.py and subcommand parsing), and an exact edit inside a file the size of a
// real implementer prompt (~10k tokens), where a misquoted `find` is the typical invention.

export const HARD_SUITE_VERSION = 1;

const UNITS_CSV = `unit,dimension,factor
m,length,1
km,length,1000
cm,length,0.01
mi,length,1609.344
s,time,1
min,time,60
h,time,3600
g,mass,1
kg,mass,1000
lb,mass,453.59237
`;

const ALL_UNITS = ['cm', 'g', 'h', 'kg', 'km', 'lb', 'm', 'mi', 'min', 's'];

const UNITCONV_TESTS = `import subprocess, sys
def run(*args):
    return subprocess.run([sys.executable, "-E", "-s", "-m", "unitconv", *args], capture_output=True, text=True, timeout=5)
r = run("convert", "3", "km", "m"); assert r.returncode == 0 and r.stdout.strip() == "3000", ("convert 3 km m", r.returncode, r.stdout, r.stderr[-300:])
r = run("convert", "1.5", "h", "min"); assert r.stdout.strip() == "90", ("convert 1.5 h min", r.stdout, r.stderr[-300:])
r = run("convert", "1", "lb", "kg"); assert r.stdout.strip() == "0.453592", ("convert 1 lb kg", r.stdout, r.stderr[-300:])
r = run("convert", "2", "km", "h"); assert r.returncode == 2 and "incompatible" in r.stderr.lower(), ("incompatible units", r.returncode, r.stderr[-300:])
r = run("convert", "1", "parsec", "m"); assert r.returncode == 2 and "unknown unit" in r.stderr.lower(), ("unknown unit", r.returncode, r.stderr[-300:])
r = run("list", "--dimension", "time"); assert r.stdout.split() == ["h", "min", "s"], ("list --dimension time", r.stdout, r.stderr[-300:])
r = run("list"); assert r.stdout.split() == ${JSON.stringify(ALL_UNITS)}, ("list", r.stdout, r.stderr[-300:])
r = run(); assert r.returncode == 2, ("no subcommand", r.returncode)
from unitconv import convert
assert abs(convert(3, "km", "m") - 3000) < 1e-9, "convert() API"
from unitconv.data import load_units
units = load_units()
assert units["km"] == ("length", 1000.0), ("load_units()['km']", units.get("km"))
print("ok")
`;

const hardCliCase: BenchCase = {
  id: 'hard-cli',
  role: 'implementer',
  systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
  userPrompt:
    'Overall goal: a small unit-conversion package, unitconv, usable as a library and as `python -m unitconv`.\n\n' +
    'Assigned task: implement the whole package. unitconv/units.csv already exists with this content:\n' +
    `\`\`\`\n${UNITS_CSV}\`\`\`\n` +
    'Acceptance criteria:\n' +
    '- unitconv/data.py defines load_units() returning a dict mapping each unit to a (dimension, factor) tuple, ' +
    'with factor as a float, read from units.csv located next to data.py (resolve the path from __file__, not the working directory).\n' +
    '- unitconv/__init__.py exports convert(value, from_unit, to_unit) -> float. It raises ValueError("unknown unit: X") ' +
    'for a unit not in the table and ValueError("incompatible units: A and B") when the dimensions differ.\n' +
    '- unitconv/cli.py defines main(argv=None) using argparse with two subcommands:\n' +
    '  - `convert VALUE FROM TO` prints the converted value formatted with "{:g}" (e.g. `convert 3 km m` prints 3000).\n' +
    '  - `list [--dimension D]` prints unit names one per line, sorted alphabetically, optionally only those of dimension D.\n' +
    '  - Any ValueError from convert is printed to stderr and the process exits with status 2.\n' +
    '  - Running with no subcommand prints usage to stderr and exits with status 2.\n' +
    '- unitconv/__main__.py makes `python -m unitconv ...` call cli.main().\n' +
    '- Standard library only.\n\n' +
    'Expected paths: unitconv/__init__.py, unitconv/__main__.py, unitconv/cli.py, unitconv/data.py',
  schemaDescription: IMPLEMENTER_SCHEMA_DESCRIPTION,
  validate: validateImplementerOutput,
  retryable: true,
  grade: async (value, runPython) => {
    const stub = stubGrade(value);
    if (stub) return stub;
    const applied = applyFileOps({ 'unitconv/units.csv': UNITS_CSV }, (value as { fileOps: FileOp[] }).fileOps);
    if (!('files' in applied)) return applied;
    return gradeTestRun(await runPython(applied.files, UNITCONV_TESTS), ['unitconv', 'unitconv.data', 'unitconv.cli']);
  },
};

// The long file is generated rather than hand-written: ~80 ordinary helpers around one buggy one,
// which is how a real module looks to an implementer asked to fix a single symptom in it.
const NOUNS = [
  'invoice', 'shipment', 'ledger', 'account', 'order', 'refund', 'voucher', 'payout', 'batch', 'tariff',
  'parcel', 'pallet', 'manifest', 'carrier', 'warehouse', 'supplier', 'receipt', 'credit', 'rebate', 'quota',
];

interface Filler {
  source: string;
  tests: string[];
}

function filler(index: number): Filler {
  // Past one lap of NOUNS x kinds the names would repeat, so later helpers are the legacy variants.
  const noun = NOUNS[index % NOUNS.length]! + (index >= NOUNS.length * 4 ? '_legacy' : '');
  const kind = Math.floor(index / NOUNS.length) % 4;
  const a = 10 + ((index * 37) % 90);
  const b = a + 50 + ((index * 13) % 200);
  if (kind === 0) {
    const length = 6 + (index % 5);
    const sample = 'ab-' + 'X9'.repeat(length).slice(0, length - 2);
    return {
      source:
        `def normalize_${noun}_code(code):\n` +
        `    """Upper-case a ${noun} code and strip separators; codes are ${length} characters once normalised."""\n` +
        `    cleaned = "".join(ch for ch in code.upper() if ch.isalnum())\n` +
        `    if len(cleaned) != ${length}:\n` +
        `        raise ValueError(f"${noun} code must have ${length} characters, got {len(cleaned)}")\n` +
        `    return cleaned\n`,
      tests: [`assert normalize_${noun}_code(${JSON.stringify(sample)}) == ${JSON.stringify(sample.replace('-', '').toUpperCase())}`],
    };
  }
  if (kind === 1) {
    return {
      source:
        `def ${noun}_band(amount):\n` +
        `    """Return the ${noun} pricing band for an amount: 0 below ${a}, 1 below ${b}, otherwise 2."""\n` +
        `    if amount < 0:\n` +
        `        raise ValueError("amount must be non-negative")\n` +
        `    if amount < ${a}:\n` +
        `        return 0\n` +
        `    if amount < ${b}:\n` +
        `        return 1\n` +
        `    return 2\n`,
      tests: [`assert ${noun}_band(${a - 1}) == 0 and ${noun}_band(${a}) == 1 and ${noun}_band(${b}) == 2`],
    };
  }
  if (kind === 2) {
    return {
      source:
        `def clamp_${noun}_quantity(quantity, maximum=${b}):\n` +
        `    """Clamp a ${noun} quantity into the inclusive range 0..maximum, truncating fractions."""\n` +
        `    return max(0, min(int(quantity), maximum))\n`,
      tests: [`assert clamp_${noun}_quantity(${b + 5}) == ${b} and clamp_${noun}_quantity(-3) == 0`],
    };
  }
  const modulus = 7 + (index % 6);
  const weight = 2 + (index % 3);
  const digits = String(100000 + index * 7919);
  const expected = [...digits].reduce((sum, d, position) => sum + ((position % weight) + 1) * Number(d), 0) % modulus;
  return {
    source:
      `def ${noun}_checksum(digits):\n` +
      `    """Weighted mod-${modulus} checksum used on ${noun} references."""\n` +
      `    total = 0\n` +
      `    for position, digit in enumerate(str(digits)):\n` +
      `        total += (position % ${weight} + 1) * int(digit)\n` +
      `    return total % ${modulus}\n`,
    tests: [`assert ${noun}_checksum(${digits}) == ${expected}`],
  };
}

const PARSE_DURATION = `def parse_duration(text):
    """Parse a duration such as "1h30m", "45m", "2h5s" or "90s" into seconds.

    Each unit may appear at most once, in h-m-s order. An empty or malformed string raises ValueError.
    """
    match = re.fullmatch(r"(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?", text.strip())
    if not match or not any(match.groups()):
        raise ValueError(f"malformed duration: {text!r}")
    hours, minutes, seconds = (int(part) if part else 0 for part in match.groups())
    return hours * 360 + minutes * 60 + seconds
`;

const FILLER_COUNT = 130;
const BUG_POSITION = 80;

function buildOperationsModule(): { source: string; tests: string } {
  const helpers = Array.from({ length: FILLER_COUNT }, (_, i) => filler(i));
  const blocks = helpers.map((h) => h.source);
  blocks.splice(BUG_POSITION, 0, PARSE_DURATION);
  const source = `"""Operational helpers shared by the billing, logistics and reporting services."""\n\nimport re\n\n\n${blocks.join('\n\n')}`;
  // Every helper is checked, so an edit that lands in the wrong place, or "tidies" a neighbour the
  // task said to leave alone, fails rather than slipping through.
  const spotChecks = helpers.flatMap((h) => h.tests);
  const tests =
    'from operations import *\n' +
    'assert parse_duration("2h") == 7200, parse_duration("2h")\n' +
    'assert parse_duration("1h30m") == 5400\n' +
    'assert parse_duration("45m") == 2700 and parse_duration("90s") == 90 and parse_duration("2h5s") == 7205\n' +
    'for bad in ["", "5x", "m"]:\n' +
    '    try:\n        parse_duration(bad)\n    except ValueError:\n        pass\n' +
    '    else:\n        raise AssertionError(f"expected ValueError for {bad!r}")\n' +
    `${spotChecks.join('\n')}\nprint("ok")\n`;
  return { source, tests };
}

export const OPERATIONS_MODULE = buildOperationsModule();

const hardLongEditCase: BenchCase = {
  id: 'hard-long-edit',
  role: 'implementer',
  systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
  userPrompt:
    'Overall goal: keep the shared operations helpers correct.\n\n' +
    'Assigned task: bug report from the scheduling service — durations that include hours come out far too short; ' +
    'for example a two-hour job was scheduled for twelve minutes. Find the cause in operations.py and fix it.\n\n' +
    'Acceptance criteria:\n' +
    '- Durations with hours, minutes and seconds convert to the correct number of seconds.\n' +
    '- Fix it with exact "edit" operations on operations.py; do not rewrite the file and do not change any other function.\n\n' +
    `Current contents of operations.py:\n\`\`\`python\n${OPERATIONS_MODULE.source}\`\`\`\n\n` +
    'Expected paths: operations.py',
  schemaDescription: IMPLEMENTER_SCHEMA_DESCRIPTION,
  validate: validateImplementerOutput,
  retryable: true,
  grade: async (value, runPython) => {
    const ops = (value as { fileOps: FileOp[] }).fileOps;
    if (!ops.some((op) => op.op === 'edit')) return { ok: false, kind: 'wrong', detail: 'rewrote the file instead of an edit' };
    const applied = applyFileOps({ 'operations.py': OPERATIONS_MODULE.source }, ops);
    if (!('files' in applied)) return applied;
    return gradeTestRun(await runPython(applied.files, OPERATIONS_MODULE.tests), ['operations']);
  },
};

export const HARD_CASES: BenchCase[] = [hardCliCase, hardLongEditCase];
