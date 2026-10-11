import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPOSITORY_FILE_MAX_BYTES, RepoWorktree } from './RepoWorktree.js';
import {
  executeRepositoryTool,
  executeReviewCommand,
  reviewCommandToolDefinition,
  validateReviewArgs,
} from './repositoryTools.js';
import { existsSync, readFileSync } from 'node:fs';

let root: string;
let worktree: RepoWorktree;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'repository-tools-'));
  worktree = new RepoWorktree(root, path.join(root, 'run'), 'tools');
  mkdirSync(worktree.worktreePath, { recursive: true });
  mkdirSync(path.join(worktree.worktreePath, 'src'), { recursive: true });
  writeFileSync(path.join(worktree.worktreePath, 'src', 'main.ts'), 'first\nneedle here\nlast\n', 'utf8');
  writeFileSync(path.join(worktree.worktreePath, 'binary.bin'), Buffer.from([0, 1, 2]));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('repository read tools', () => {
  it('lists, reads numbered lines, and searches literal text', () => {
    expect(executeRepositoryTool(worktree, 'list_repository_files', '{}').content).toContain('src/main.ts');
    expect(executeRepositoryTool(worktree, 'read_repository_file', '{"path":"src/main.ts","startLine":2}').content)
      .toContain('2: needle here');
    expect(executeRepositoryTool(worktree, 'search_repository', '{"query":"needle"}').content)
      .toContain('src/main.ts');
  });

  it('rejects traversal, absolute paths, binary files, and symlink escapes', () => {
    expect(() => executeRepositoryTool(worktree, 'read_repository_file', '{"path":"../secret"}')).toThrow(/escapes/);
    expect(() => executeRepositoryTool(worktree, 'read_repository_file', '{"path":"/etc/passwd"}')).toThrow(/relative/);
    expect(() => executeRepositoryTool(worktree, 'read_repository_file', '{"path":"binary.bin"}')).toThrow(/binary/);
    const outside = path.join(root, 'outside.txt');
    writeFileSync(outside, 'secret', 'utf8');
    symlinkSync(outside, path.join(worktree.worktreePath, 'escape.txt'));
    expect(() => executeRepositoryTool(worktree, 'read_repository_file', '{"path":"escape.txt"}')).toThrow(/escapes/);
  });

  it('refuses to read a file over the size limit, and leaves it out of a search', () => {
    writeFileSync(path.join(worktree.worktreePath, 'big.txt'), `needle\n${'x'.repeat(REPOSITORY_FILE_MAX_BYTES)}`, 'utf8');

    expect(() => executeRepositoryTool(worktree, 'read_repository_file', '{"path":"big.txt"}')).toThrow(/too large/);
    const search = JSON.parse(executeRepositoryTool(worktree, 'search_repository', '{"query":"needle"}').content);
    expect(search.matches.map((m: { path: string }) => m.path)).toEqual(['src/main.ts']);
    expect(search.skippedLargeFiles).toEqual(['big.txt']);
  });

  it("shows a task's overlay instead of the tree: its files added, its deletions gone, in reads and searches", () => {
    const overlay = new Map<string, string | null>([
      ['src/kept.py', 'def kept():\n    return "needle"\n'],
      ['src/main.ts', null],
    ]);

    const listed = JSON.parse(executeRepositoryTool(worktree, 'list_repository_files', '{}', overlay).content);
    expect(listed.paths).toContain('src/kept.py');
    expect(listed.paths).not.toContain('src/main.ts');
    expect(executeRepositoryTool(worktree, 'read_repository_file', '{"path":"./src/kept.py","startLine":2}', overlay).content)
      .toBe('2:     return "needle"\n3: ');
    expect(() => executeRepositoryTool(worktree, 'read_repository_file', '{"path":"src/main.ts"}', overlay))
      .toThrow(/not found/);
    const search = JSON.parse(executeRepositoryTool(worktree, 'search_repository', '{"query":"needle"}', overlay).content);
    expect(search.matches.map((m: { path: string }) => m.path)).toEqual(['src/kept.py']);
    // Nothing reached the shared tree, and a read without the overlay still sees it as it is.
    expect(executeRepositoryTool(worktree, 'read_repository_file', '{"path":"src/main.ts"}').content).toContain('needle here');
    expect(() => executeRepositoryTool(worktree, 'read_repository_file', '{"path":"src/kept.py"}')).toThrow(/not found/);
  });

  it('rejects malformed arguments without touching the filesystem', () => {
    expect(() => executeRepositoryTool(worktree, 'read_repository_file', '{bad json')).toThrow(/Malformed arguments/);
  });

  it('labels tabular fallback content as a partial preview with its real row count', () => {
    const csvPath = path.join(worktree.worktreePath, 'data.csv');
    writeFileSync(csvPath, 'energy,value\n1,10\n2,20\n3,30\n4,40\n5,50\n6,60\n', 'utf8');

    const bundle = worktree.fallbackRepositoryBundle([], 'Inspect data.csv');

    expect(bundle).toContain('PREVIEW ONLY — showing the first 5 of 7 physical lines');
    expect(bundle).toContain('6 data rows after the header');
    expect(bundle).toContain('Never infer row counts, grid sizes, final values, or full coverage from this preview.');
  });
});

describe('run_review_command', () => {
  const node = process.execPath;
  // Writes a file and overwrites a source file, then prints what it was given.
  const script = "require('fs').writeFileSync('out.csv','x');require('fs').writeFileSync('src/main.ts','clobbered');" +
    "console.log('args', process.argv.slice(1).join(' '))";
  const commands = [{ id: 'probe', description: 'node probe', command: node, args: ['-e', script], timeoutMs: 10_000 }];

  it('is offered only when the run declares review commands', () => {
    expect(reviewCommandToolDefinition([])).toBeNull();
    const tool = reviewCommandToolDefinition(commands)!;
    expect(tool.function.name).toBe('run_review_command');
    expect(JSON.stringify(tool.function.parameters)).toContain('"enum":["probe"]');
  });

  it('runs in a scratch copy that sees the change but keeps nothing it writes', async () => {
    const result = await executeReviewCommand(worktree, commands, '{"commandId":"probe","args":["--", "a", "b"]}', 'none');

    expect(result).toMatchObject({ commandId: 'probe', ran: true, exitedZero: true });
    expect(JSON.parse(result.content)).toMatchObject({ status: 'exited 0' });
    expect(JSON.parse(result.content).output).toContain('args a b');
    expect(existsSync(path.join(worktree.worktreePath, 'out.csv'))).toBe(false);
    expect(readFileSync(path.join(worktree.worktreePath, 'src', 'main.ts'), 'utf8')).toBe('first\nneedle here\nlast\n');
  });

  it('reports a failing command as a result, not an error', async () => {
    const failing = [{ ...commands[0], args: ['-e', "console.error('boom'); process.exit(3)"] }];
    const result = await executeReviewCommand(worktree, failing, '{"commandId":"probe"}', 'none');
    expect(result).toMatchObject({ ran: true, exitedZero: false });
    expect(JSON.parse(result.content).output).toContain('boom');
  });

  it('shows the fixed prefix, and drops a restatement of it from the args', async () => {
    const echo = "console.log('argv', JSON.stringify(process.argv.slice(1)))";
    const probe = [{ id: 'probe', description: 'echo', command: process.execPath, args: ['-e', echo], timeoutMs: 10_000 }];
    const program = path.basename(process.execPath);
    expect(reviewCommandToolDefinition(probe)!.function.description).toContain(`\`${program} -e console.log`);
    for (const args of [[program, '-e', echo, 'x'], ['probe', 'x'], ['-e', echo, 'x'], ['-e', 'x']]) {
      const result = await executeReviewCommand(worktree, probe, JSON.stringify({ commandId: 'probe', args }), 'none');
      expect(result.args).toEqual(['x']);
      expect(JSON.parse(result.content).note).toMatch(/always supplied/);
      expect(JSON.parse(result.content).output).toContain('argv ["x"]');
    }
    const plain = await executeReviewCommand(worktree, probe, '{"commandId":"probe","args":["x"]}', 'none');
    expect(JSON.parse(plain.content).note).toBeUndefined();
  });

  it('takes a lone string as one argument', () => {
    expect(validateReviewArgs('print(1)')).toEqual(['print(1)']);
    expect(validateReviewArgs('["-q", "tests"]')).toEqual(['-q', 'tests']);
    expect(validateReviewArgs('[1, 2]')).toEqual(['[1, 2]']);
    expect(validateReviewArgs(['["-c", "print(1)"]'])).toEqual(['-c', 'print(1)']);
  });

  it('refuses shell redirection and chaining, which do nothing without a shell', () => {
    expect(() => validateReviewArgs(['print(1)', '2>/dev/null'])).toThrow(/no shell/);
    expect(() => validateReviewArgs(['tests', '||', 'true'])).toThrow(/no shell/);
    // Verbatim shape from the 2026-10-08 managerial reviewer.
    expect(() => validateReviewArgs(['["-c", "print(1)"] 2>/dev/null || true'])).toThrow(/no shell/);
    expect(validateReviewArgs(['print(1 if a and b else 2)', '-k', 'not slow'])).toHaveLength(3);
    // Shell syntax inside a snippet belongs to the snippet (2026-10-08 capitalist cycle 2).
    expect(validateReviewArgs(["import os; os.system('python -m pkg >/dev/null 2>&1 && echo ok')"])).toHaveLength(1);
  });

  it('refuses an unknown command id', async () => {
    await expect(executeReviewCommand(worktree, commands, '{"commandId":"sh"}', 'none')).rejects.toThrow(/Unknown review command/);
  });

  it('accepts relative arguments and refuses paths that leave the scratch copy', () => {
    expect(validateReviewArgs(['calculate', 'examples/304L.yaml', '--output=results/x', '-k', 'interp'])).toHaveLength(5);
    expect(validateReviewArgs(undefined)).toEqual([]);
    expect(() => validateReviewArgs(['/etc/passwd'])).toThrow(/absolute/);
    expect(() => validateReviewArgs(['--output=/tmp/x'])).toThrow(/absolute/);
    expect(() => validateReviewArgs(['~/x'])).toThrow(/absolute/);
    expect(() => validateReviewArgs(['../outside'])).toThrow(/\.\./);
    expect(() => validateReviewArgs(['--basetemp=a/../../b'])).toThrow(/\.\./);
    expect(() => validateReviewArgs([1])).toThrow(/array of strings/);
    expect(() => validateReviewArgs({ a: 1 })).toThrow(/array of strings/);
    expect(() => validateReviewArgs(Array.from({ length: 17 }, () => 'a'))).toThrow(/at most 16/);
    expect(() => validateReviewArgs(['x'.repeat(201)])).toThrow(/longer than 200/);
    expect(validateReviewArgs(['x'.repeat(3_000)], 4_000)).toHaveLength(1);
  });
});
