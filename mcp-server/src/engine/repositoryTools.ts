import type { ToolDefinition } from './OpenRouterClient.js';
import path from 'node:path';
import type { RepoWorktree, RepositoryOverlay, RepositoryToolResult } from './RepoWorktree.js';
import type { ReviewCommand } from '../util/config.js';
import type { CheckSandbox } from '../util/sandbox.js';
import { clipCheckOutput } from '../util/checkOutput.js';

export const REPOSITORY_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_repository_files',
      description: 'List repository-relative files, optionally filtered by a glob and paginated by cursor.',
      parameters: {
        type: 'object',
        properties: { glob: { type: 'string' }, cursor: { type: 'string' } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_repository_file',
      description: 'Read at most 400 numbered lines from one repository-relative text file. Files over 1 MiB are refused.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_repository',
      description: 'Search text files for a literal query, returning at most 100 matches per page. Files over 1 MiB are skipped.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, glob: { type: 'string' }, cursor: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
];

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function executeRepositoryTool(
  worktree: RepoWorktree,
  name: string,
  rawArguments: string,
  overlay?: RepositoryOverlay,
): RepositoryToolResult {
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('arguments must be an object');
    args = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Malformed arguments for ${name}: ${String(error)}`);
  }

  if (name === 'list_repository_files') {
    return worktree.listRepositoryFiles(optionalString(args.glob), optionalString(args.cursor), overlay);
  }
  if (name === 'read_repository_file') {
    if (typeof args.path !== 'string') throw new Error('read_repository_file requires a string path');
    return worktree.readRepositoryFile(args.path, optionalNumber(args.startLine), optionalNumber(args.endLine), overlay);
  }
  if (name === 'search_repository') {
    if (typeof args.query !== 'string') throw new Error('search_repository requires a string query');
    return worktree.searchRepository(args.query, optionalString(args.glob), optionalString(args.cursor), overlay);
  }
  throw new Error(`Unknown repository tool: ${name}`);
}

export const RUN_REVIEW_COMMAND = 'run_review_command';

const MAX_REVIEW_ARGS = 16;
const MAX_REVIEW_ARG_CHARS = 200;
const MAX_REVIEW_OUTPUT_CHARS = 4_000;

/** The tool a critic is offered when the run declares review commands; null when it declares none. */
export function reviewCommandToolDefinition(commands: readonly ReviewCommand[]): ToolDefinition | null {
  if (commands.length === 0) return null;
  const listing = commands.map((c) => `"${c.id}" runs \`${fixedPrefix(c)} <your args>\` (${c.description})`).join('; ');
  return {
    type: 'function',
    function: {
      name: RUN_REVIEW_COMMAND,
      description:
        'Run one allow-listed command against the change under review, to test a claim before your verdict: ' +
        'probe an edge case, reproduce a suspected bug, or run one test. It runs in a throwaway copy of the ' +
        'repository with the change applied, so nothing it writes is kept. You choose the command id; your args ' +
        'are appended after its fixed prefix, so never repeat the program or the prefix in them. ' +
        'The working directory is the repository root; use repository-relative paths only. ' +
        `Commands: ${listing}.`,
      parameters: {
        type: 'object',
        properties: {
          commandId: { type: 'string', enum: commands.map((c) => c.id) },
          args: { type: 'array', items: { type: 'string' }, maxItems: MAX_REVIEW_ARGS },
        },
        required: ['commandId'],
        additionalProperties: false,
      },
    },
  };
}

/** The command line a critic's arguments are appended to, as the critic should picture it. */
function fixedPrefix(command: ReviewCommand): string {
  const shown = command.args.map((arg) => (arg.length > 40 ? `${arg.slice(0, 37)}...` : arg));
  return [programName(command.command), ...shown].join(' ');
}

function programName(command: string): string {
  return path.basename(command).replace(/\.(exe|cmd)$/i, '');
}

/**
 * Drops a restatement of the command from the front of the critic's arguments. Models do this
 * readily: the 2026-10-08 democratic minister sent ["python", "-m", "pytest", "-q"] to the pytest
 * command and ran `pytest ... python -m pytest -q` three times, and socialist critics sent
 * ["-c", code] to `python -c` eight times. Refusing those cost a tool round each; they only ever
 * mean "run it", so the repeated program name or id, and any leading run of the fixed prefix, is
 * removed and the result says so.
 */
function withoutRestatedPrefix(command: ReviewCommand, args: readonly string[]): { args: string[]; dropped: string[] } {
  let offset = 0;
  const first = args[0]?.toLowerCase();
  if (first !== undefined && (first === command.id.toLowerCase() || first === programName(command.command).toLowerCase())) {
    offset = 1;
  }
  let matched = 0;
  while (matched < command.args.length && args[offset + matched] === command.args[matched]) matched += 1;
  const cut = offset + matched;
  return { args: args.slice(cut), dropped: args.slice(0, cut) };
}

/** Shell redirection or chaining, which means the critic thinks it is typing into a shell: an argument
 * that is only a shell token, or an encoded argument array with shell syntax after it. The 2026-10-08
 * managerial reviewer's probe ended `2>/dev/null || ...`, ran as Python, and failed, leaving its
 * mistaken claim of a units bug unchecked. Shell syntax inside an argument (a Python snippet's
 * os.system string) is the program's business, not refused. */
const SHELL_SYNTAX = /^(\d?>>?(\s*\/dev\/null)?|\d>&\d|\|\||&&|\||;)$|^\s*\[.*\]\s*(\d?>|\|\||&&|\|)/s;

function decodedArgumentArray(text: string): string[] | null {
  if (!text.trim().startsWith('[')) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
  } catch {
    return null;
  }
}

/**
 * Arguments a critic appends to an allow-listed command. They reach execFile as an argv array, never
 * a shell, so the remaining risks are paths: an absolute path or a `..` segment could read or write
 * outside the scratch copy.
 */
export function validateReviewArgs(args: unknown, maxArgChars = MAX_REVIEW_ARG_CHARS): string[] {
  if (args === undefined) return [];
  // A lone string is one argument: models send `python -c`'s code that way as often as not. One
  // that is itself a JSON array of strings is that array, encoded once too often.
  if (typeof args === 'string') args = decodedArgumentArray(args) ?? [args];
  else if (Array.isArray(args) && args.length === 1 && typeof args[0] === 'string') args = decodedArgumentArray(args[0]) ?? args;
  if (!Array.isArray(args) || !args.every((a): a is string => typeof a === 'string')) {
    throw new Error('args must be an array of strings');
  }
  if (args.length > MAX_REVIEW_ARGS) throw new Error(`at most ${MAX_REVIEW_ARGS} arguments are allowed`);
  for (const arg of args) {
    if (arg.length > maxArgChars) throw new Error(`argument longer than ${maxArgChars} characters`);
    if (arg.includes('\0')) throw new Error('arguments may not contain NUL');
    if (SHELL_SYNTAX.test(arg)) {
      throw new Error(
        `arguments go straight to the program with no shell, so redirection and chaining do nothing but break it: ${arg.slice(0, 80)}. ` +
          'Drop them; the output is returned to you whatever the exit code.',
      );
    }
    // `--output=/etc/x` hides the path behind a flag, so every `=`-separated part is checked.
    for (const part of arg.split('=')) {
      if (path.isAbsolute(part) || /^~/.test(part) || /^[A-Za-z]:[\\/]/.test(part)) {
        throw new Error(`absolute paths are not allowed: ${arg}`);
      }
      if (part.split(/[\\/]/).includes('..')) throw new Error(`".." path segments are not allowed: ${arg}`);
    }
  }
  return args;
}

export async function executeReviewCommand(
  worktree: RepoWorktree,
  commands: readonly ReviewCommand[],
  rawArguments: string,
  sandbox: CheckSandbox,
): Promise<{ content: string; commandId: string; args: string[]; ran: boolean; exitedZero: boolean }> {
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(rawArguments) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('arguments must be an object');
    parsed = value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Malformed arguments for ${RUN_REVIEW_COMMAND}: ${String(error)}`);
  }
  const command = commands.find((c) => c.id === parsed.commandId);
  if (!command) {
    throw new Error(`Unknown review command ${JSON.stringify(parsed.commandId)}; choose one of: ${commands.map((c) => c.id).join(', ')}`);
  }
  const { args, dropped } = withoutRestatedPrefix(command, validateReviewArgs(parsed.args, command.maxArgChars));
  const result = await worktree.runInScratchCopy(command.command, [...command.args, ...args], command.timeoutMs, { sandbox });
  const exitedZero = result.ran && result.passed;
  const status = !result.ran ? 'could not run' : exitedZero ? 'exited 0' : 'exited non-zero';
  const content = JSON.stringify({
    command: [command.id, ...args].join(' '),
    ...(dropped.length
      ? { note: `${JSON.stringify(dropped)} repeated \`${fixedPrefix(command)}\`, which is always supplied, so it was dropped.` }
      : {}),
    status,
    output: clipCheckOutput(result.output ?? '', MAX_REVIEW_OUTPUT_CHARS),
  });
  return { content, commandId: command.id, args, ran: result.ran, exitedZero };
}
