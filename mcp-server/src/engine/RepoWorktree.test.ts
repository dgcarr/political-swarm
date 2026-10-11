import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, symlinkSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FILE_OP_MAX_BYTES, RepoWorktree } from './RepoWorktree.js';

let tmpRoot: string;
let repoPath: string;
let worktree: RepoWorktree;

it('commits only the accepted tree even if the index changes after validation', async () => {
  writeFileSync(path.join(worktree.worktreePath, 'existing.txt'), 'reviewed');
  const acceptedTree = await worktree.snapshotTree();
  const snapshot = worktree.snapshotTree.bind(worktree);
  worktree.snapshotTree = async () => {
    const tree = await snapshot();
    writeFileSync(path.join(worktree.worktreePath, 'existing.txt'), 'unreviewed');
    git(worktree.worktreePath, ['add', '-A']);
    return tree;
  };
  const revision = await worktree.commit('accepted snapshot', acceptedTree);
  const committed = execFileSync('git', ['show', `${revision}:existing.txt`], { cwd: repoPath, encoding: 'utf8' });
  expect(committed).toBe('reviewed');
});

it('recovers a resume lock left behind by an exited process', async () => {
  const moduleUrl = new URL('./RepoWorktree.ts', import.meta.url).href;
  const script = `import { RepoWorktree } from ${JSON.stringify(moduleUrl)};
    const tree = new RepoWorktree(${JSON.stringify(repoPath)}, ${JSON.stringify(path.join(tmpRoot, 'run'))}, 'test-run');
    await tree.withResumeLock(async () => { process.exit(0); });`;
  await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script]);
  await expect(worktree.withResumeLock(async () => 'recovered')).resolves.toBe('recovered');
});

it('releases the resume lock when validation fails', async () => {
  await expect(worktree.withResumeLock(async () => { throw new Error('validation failed'); })).rejects.toThrow('validation failed');
  await expect(worktree.withResumeLock(async () => 'retry')).resolves.toBe('retry');
});

it('excludes a competing process while the resume lock is held', async () => {
  const moduleUrl = new URL('./RepoWorktree.ts', import.meta.url).href;
  await worktree.withResumeLock(async () => {
    const script = `import { RepoWorktree } from ${JSON.stringify(moduleUrl)};
      const tree = new RepoWorktree(${JSON.stringify(repoPath)}, ${JSON.stringify(path.join(tmpRoot, 'run'))}, 'test-run');
      await tree.withResumeLock(async () => {});`;
    await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script])).rejects.toThrow('already locked');
  });
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'swarm-worktree-test-'));
  repoPath = path.join(tmpRoot, 'repo');
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-q']);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  git(repoPath, ['config', 'user.name', 'Test']);
  writeFileSync(path.join(repoPath, 'existing.txt'), 'original\n', 'utf8');
  writeFileSync(path.join(repoPath, '.gitignore'), 'ignored/\n', 'utf8');
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '-q', '-m', 'init']);
  git(repoPath, ['branch', '-M', 'main']);

  worktree = new RepoWorktree(repoPath, path.join(tmpRoot, 'run'), 'test-run');
  await worktree.create('main');
});

afterEach(() => {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktree.worktreePath], { cwd: repoPath, stdio: 'pipe' });
  } catch {
    // best effort; the tmp dir removal below is what actually matters
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

function wt(rel: string): string {
  return path.join(worktree.worktreePath, rel);
}

describe('runAllowListedCommand', () => {
  it.skipIf(process.platform !== 'linux')('terminates nested check processes when the check times out', async () => {
    const marker = wt('nested-check.pid');
    const script = `const {spawn}=require('node:child_process');` +
      `const {writeFileSync}=require('node:fs');` +
      `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});` +
      `writeFileSync(${JSON.stringify(marker)},String(child.pid));` +
      `setInterval(()=>{},1000);`;

    const result = await worktree.runAllowListedCommand(process.execPath, ['-e', script], 200);

    expect(result).toMatchObject({ ran: true, passed: false });
    expect(result.output).toContain('timeout');
    const childPid = Number(readFileSync(marker, 'utf8'));
    let status = '';
    try { status = readFileSync(`/proc/${childPid}/status`, 'utf8'); }
    catch { /* A reaped child has no proc entry. */ }
    expect(status === '' || /^State:\s+[ZX]/m.test(status)).toBe(true);
  });
});

describe('runAllowListedCommand environment', () => {
  it('hands a check none of the server\'s credentials, and marks it as CI', async () => {
    const saved = { key: process.env.OPENROUTER_API_KEY, other: process.env.SWARM_TEST_UNLISTED };
    process.env.OPENROUTER_API_KEY = 'sk-or-should-not-leak';
    process.env.SWARM_TEST_UNLISTED = 'unlisted';
    try {
      const result = await worktree.runAllowListedCommand(
        process.execPath,
        ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
        10_000,
      );
      const env = JSON.parse(result.output ?? '') as Record<string, string>;
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(env.SWARM_TEST_UNLISTED).toBeUndefined();
      expect(env.CI).toBe('1');
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      if (saved.key === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved.key;
      delete process.env.SWARM_TEST_UNLISTED;
    }
  });
});

describe('git metadata protection', () => {
  it.each(['.git/config', '.git', '.GIT/hooks/pre-commit', 'sub/.git/config', '.git./config', '.git\\hooks\\post-commit'])(
    'refuses the git metadata path %s',
    (relPath) => {
      expect(() => worktree.resolveSafePath(relPath)).toThrow(/git metadata/);
    },
  );

  it('still allows ordinary dotfiles that merely start with .git', () => {
    expect(() => worktree.resolveSafePath('.gitignore')).not.toThrow();
    expect(() => worktree.resolveSafePath('.github/workflows/ci.yml')).not.toThrow();
  });

  it('refuses a FileOp that would write a hook into the shared repository', () => {
    expect(() =>
      worktree.applyFileOps([{ op: 'write', path: '.git/hooks/post-commit', content: '#!/bin/sh\n' }]),
    ).toThrow(/git metadata/);
  });

  it.skipIf(process.platform === 'win32')('runs no repository hook when the engine commits', async () => {
    const marker = path.join(tmpRoot, 'hook-ran');
    mkdirSync(wt('.husky'));
    writeFileSync(wt('.husky/pre-commit'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, 'utf8');
    chmodSync(wt('.husky/pre-commit'), 0o755);
    git(repoPath, ['config', 'core.hooksPath', '.husky']);

    await worktree.commit('engine commit');
    expect(existsSync(marker)).toBe(false);

    // The same hook does fire for a plain git commit, so the assertion above is not vacuous.
    writeFileSync(wt('existing.txt'), 'touched\n', 'utf8');
    git(worktree.worktreePath, ['commit', '-qam', 'plain commit']);
    expect(existsSync(marker)).toBe(true);
  });
});

describe('snapshotFileOps / revertFileOps', () => {
  it('restores a modified file and deletes a created one', () => {
    const ops = [
      { op: 'write' as const, path: 'existing.txt', content: 'changed\n' },
      { op: 'write' as const, path: 'src/new.py', content: 'print(1)\n' },
    ];
    // Read rather than hardcode: git's core.autocrlf may have rewritten line endings on checkout,
    // and the invariant under test is "restores exactly what was there", not a literal.
    const contentBefore = readFileSync(wt('existing.txt'), 'utf8');

    const snapshot = worktree.snapshotFileOps(ops);
    worktree.applyFileOps(ops);
    expect(readFileSync(wt('existing.txt'), 'utf8')).toBe('changed\n');
    expect(existsSync(wt('src/new.py'))).toBe(true);

    worktree.revertFileOps(snapshot);
    expect(readFileSync(wt('existing.txt'), 'utf8')).toBe(contentBefore);
    expect(existsSync(wt('src/new.py'))).toBe(false);
  });
});

describe('applyFileOps', () => {
  it('writes over-escaped model content with real newlines', () => {
    const escapedNewline = String.fromCharCode(92) + 'n';
    const corrupted = [
      'def validate_result():',
      '    result = calculate_value()',
      '    assert result == 42',
    ].join(escapedNewline);

    worktree.applyFileOps([{ op: 'write', path: 'tests/test_result.py', content: corrupted }]);

    expect(readFileSync(wt('tests/test_result.py'), 'utf8')).toBe(
      'def validate_result():\n    result = calculate_value()\n    assert result == 42',
    );
  });

  it('rejects writes through a symlink that points outside the worktree', () => {
    const outsideDir = path.join(tmpRoot, 'outside');
    mkdirSync(outsideDir);
    symlinkSync(outsideDir, wt('vendor'), 'dir');

    expect(() =>
      worktree.applyFileOps([{ op: 'write', path: 'vendor/escaped.txt', content: 'escaped\n' }]),
    ).toThrow(/escapes the worktree/);
    expect(existsSync(path.join(outsideDir, 'escaped.txt'))).toBe(false);
  });

  it('writes and reads ordinary nested files whose leaf and parent directories do not exist yet', () => {
    worktree.applyFileOps([{ op: 'write', path: 'new/nested/file.txt', content: 'safe\n' }]);

    expect(worktree.readFileIfExists('new/nested/file.txt')).toBe('safe\n');
    expect(worktree.pathExists('new/nested/file.txt')).toBe(true);
  });

  it('rejects a write over the size limit before touching the file', () => {
    const huge = 'x'.repeat(FILE_OP_MAX_BYTES + 1);

    expect(() => worktree.applyFileOps([{ op: 'write', path: 'huge.txt', content: huge }])).toThrow(/over the .*-byte limit/);
    expect(existsSync(wt('huge.txt'))).toBe(false);
  });

  it('applies a reindented edit literally, "$&" and all', () => {
    worktree.applyFileOps([{ op: 'write', path: 'e.py', content: 'def f():\n    return 1\n' }]);
    worktree.applyFileOps([{ op: 'edit', path: 'e.py', find: 'return 1', replace: 'return "$&"' }]);
    worktree.applyFileOps([{ op: 'edit', path: 'e.py', find: 'def f():\nreturn "$&"', replace: 'def g():\n    return 2' }]);

    expect(worktree.readFileIfExists('e.py')).toBe('def g():\n    return 2\n');
  });
});

describe('listDirtyPaths', () => {
  it('reports untracked and modified paths, and ignores .gitignored ones', async () => {
    writeFileSync(wt('existing.txt'), 'edited\n', 'utf8');
    writeFileSync(wt('untracked.txt'), 'new\n', 'utf8');
    mkdirSync(wt('ignored'), { recursive: true });
    writeFileSync(wt('ignored/noise.txt'), 'noise\n', 'utf8');

    const dirty = await worktree.listDirtyPaths();
    expect(dirty.has('untracked.txt')).toBe(true);
    expect(dirty.has('existing.txt')).toBe(true);
    expect(dirty.has('ignored/noise.txt')).toBe(false);
  });
});

describe('diff', () => {
  it('omits check-generated bytecode from a benchmark patch without hiding authored files', async () => {
    worktree.applyFileOps([{ op: 'write', path: 'alloydamage/composition.py', content: 'VALUE = 1\n' }]);
    mkdirSync(wt('alloydamage/__pycache__'), { recursive: true });
    writeFileSync(wt('alloydamage/__pycache__/composition.cpython-314.pyc'), 'bytecode');

    const result = await worktree.diff(['**/__pycache__/**', '**/*.pyc']);

    expect(result.filesChanged).toEqual(['alloydamage/composition.py']);
    expect(result.diffText).toContain('VALUE = 1');
    expect(result.diffText).not.toContain('composition.cpython-314.pyc');
  });
});

describe('removeUntrackedSince', () => {
  it('removes check-generated artifacts and prunes the emptied directory', async () => {
    const before = await worktree.listDirtyPaths();

    // Simulate pytest writing bytecode next to the implementer's file.
    mkdirSync(wt('alloydamage/__pycache__'), { recursive: true });
    writeFileSync(wt('alloydamage/__pycache__/mod.cpython-314.pyc'), 'bytecode', 'utf8');

    const removed = worktree.removeUntrackedSince(before, await worktree.listDirtyPaths());
    expect(removed).toContain('alloydamage/__pycache__/mod.cpython-314.pyc');
    expect(existsSync(wt('alloydamage/__pycache__'))).toBe(false);
    expect(existsSync(wt('alloydamage'))).toBe(false);
  });

  it('leaves files that already existed before the task alone', async () => {
    writeFileSync(wt('earlier-approved.txt'), 'from an earlier task\n', 'utf8');
    const before = await worktree.listDirtyPaths();

    writeFileSync(wt('stray.txt'), 'artifact\n', 'utf8');
    const removed = worktree.removeUntrackedSince(before, await worktree.listDirtyPaths());

    expect(removed).toEqual(['stray.txt']);
    expect(existsSync(wt('earlier-approved.txt'))).toBe(true);
  });

  it('never deletes a modified tracked file, only untracked additions', async () => {
    const before = await worktree.listDirtyPaths();
    writeFileSync(wt('existing.txt'), 'modified by something\n', 'utf8');

    const removed = worktree.removeUntrackedSince(before, await worktree.listDirtyPaths());
    expect(removed).toEqual([]);
    expect(existsSync(wt('existing.txt'))).toBe(true);
  });

  it('preserves the task\'s own new files while removing artifacts beside them', async () => {
    // The approved-task case: source the implementer created is untracked and "new since" the
    // baseline exactly like bytecode is, so only preservePaths distinguishes them.
    const before = await worktree.listDirtyPaths();

    mkdirSync(wt('alloydamage'), { recursive: true });
    writeFileSync(wt('alloydamage/composition.py'), 'def parse(): ...\n', 'utf8');
    mkdirSync(wt('alloydamage/__pycache__'), { recursive: true });
    writeFileSync(wt('alloydamage/__pycache__/composition.cpython-314.pyc'), 'bytecode', 'utf8');

    const removed = worktree.removeUntrackedSince(before, await worktree.listDirtyPaths(), [
      'alloydamage/composition.py',
    ]);

    expect(removed).toEqual(['alloydamage/__pycache__/composition.cpython-314.pyc']);
    expect(existsSync(wt('alloydamage/composition.py'))).toBe(true);
    expect(existsSync(wt('alloydamage/__pycache__'))).toBe(false);
  });

  it('preserves paths given with backslashes or a ./ prefix', async () => {
    const before = await worktree.listDirtyPaths();
    mkdirSync(wt('pkg'), { recursive: true });
    writeFileSync(wt('pkg/a.py'), 'a\n', 'utf8');
    writeFileSync(wt('pkg/b.py'), 'b\n', 'utf8');

    const removed = worktree.removeUntrackedSince(before, await worktree.listDirtyPaths(), [
      'pkg\\a.py',
      './pkg/b.py',
    ]);

    expect(removed).toEqual([]);
    expect(existsSync(wt('pkg/a.py'))).toBe(true);
    expect(existsSync(wt('pkg/b.py'))).toBe(true);
  });

  it('does not prune a directory that still holds other files', async () => {
    mkdirSync(wt('pkg'), { recursive: true });
    writeFileSync(wt('pkg/keep.py'), 'keep\n', 'utf8');
    const before = await worktree.listDirtyPaths();

    writeFileSync(wt('pkg/stray.pyc'), 'x', 'utf8');
    worktree.removeUntrackedSince(before, await worktree.listDirtyPaths());

    expect(existsSync(wt('pkg/stray.pyc'))).toBe(false);
    expect(existsSync(wt('pkg/keep.py'))).toBe(true);
  });
});

describe('untrackedAppearingSince / copyWorktreeFile', () => {
  it('lists new untracked files without deleting them', async () => {
    const before = await worktree.listDirtyPaths();
    writeFileSync(wt('generated.csv'), 'energy_MeV,xs\n', 'utf8');

    const appeared = worktree.untrackedAppearingSince(before, await worktree.listDirtyPaths());

    expect(appeared).toEqual(['generated.csv']);
    expect(existsSync(wt('generated.csv'))).toBe(true);
  });

  it('copies a worktree file to a destination outside the worktree', () => {
    writeFileSync(wt('generated.csv'), 'payload\n', 'utf8');
    const dest = path.join(tmpRoot, 'outside-copy', 'generated.csv');

    worktree.copyWorktreeFile('generated.csv', dest);

    expect(readFileSync(dest, 'utf8')).toBe('payload\n');
    expect(existsSync(wt('generated.csv'))).toBe(true);
  });
});

describe('readFileIfExists / pathExists', () => {
  it('reads a plain file', () => {
    expect(worktree.readFileIfExists('existing.txt')).toBe('original\n');
  });

  it('returns null for a missing path', () => {
    expect(worktree.readFileIfExists('nope.txt')).toBeNull();
  });

  // Diligence probes for test layout by directory name (e.g. 'tests'), which used to crash
  // readFileIfExists with EISDIR instead of reporting the path as unreadable.
  it('returns null rather than throwing when the path is a directory', () => {
    mkdirSync(wt('tests'), { recursive: true });
    expect(() => worktree.readFileIfExists('tests')).not.toThrow();
    expect(worktree.readFileIfExists('tests')).toBeNull();
  });

  it('pathExists reports directories as present', () => {
    mkdirSync(wt('tests'), { recursive: true });
    expect(worktree.pathExists('tests')).toBe(true);
    expect(worktree.pathExists('existing.txt')).toBe(true);
    expect(worktree.pathExists('nope')).toBe(false);
  });
});

describe('listFiles', () => {
  it('lists nested files by worktree-relative path', () => {
    mkdirSync(wt('data/Fe'), { recursive: true });
    writeFileSync(wt('data/Fe/Fe_dpa_nrt.csv'), 'energy_eV,xs\n1,2\n', 'utf8');

    const { paths, truncated } = worktree.listFiles();

    expect(paths).toContain('data/Fe/Fe_dpa_nrt.csv');
    expect(paths).toContain('existing.txt');
    expect(truncated).toBe(false);
  });

  // The whole point is discovery: an implementer that is never told a file exists cannot read
  // it, which is how a benchmark run came to fabricate nuclear data already present on disk.
  it('surfaces supplied data an agent would otherwise never know to read', () => {
    mkdirSync(wt('data/Cr'), { recursive: true });
    writeFileSync(wt('data/Cr/Cr_dpa_nrt.csv'), 'energy_eV,xs\n', 'utf8');
    writeFileSync(wt('data/Cr/PROVENANCE.md'), '# source\n', 'utf8');

    const { paths } = worktree.listFiles();

    expect(paths).toEqual(expect.arrayContaining(['data/Cr/Cr_dpa_nrt.csv', 'data/Cr/PROVENANCE.md']));
  });

  // `.git` is excluded too, but a git worktree stores it as a file rather than a directory,
  // so it cannot be staged the same way here — the name-based ignore covers both shapes.
  it('omits directories that crowd out real code', () => {
    for (const noise of ['node_modules', '__pycache__', '.pytest_cache', '.venv', 'dist']) {
      mkdirSync(wt(`${noise}/inner`), { recursive: true });
      writeFileSync(wt(`${noise}/inner/junk.txt`), 'x', 'utf8');
    }

    const { paths } = worktree.listFiles();

    expect(paths.filter((p) => p.includes('junk.txt'))).toEqual([]);
    expect(paths.filter((p) => p.startsWith('.git/'))).toEqual([]);
    // .gitignore is a real file an agent benefits from reading — excluding `.git` must not eat it.
    expect(paths).toContain('.gitignore');
    expect(paths).toContain('existing.txt');
  });

  it('reports truncation rather than silently returning a partial repository', () => {
    mkdirSync(wt('many'), { recursive: true });
    for (let i = 0; i < 12; i += 1) writeFileSync(wt(`many/file-${i}.txt`), 'x', 'utf8');

    const { paths, truncated } = worktree.listFiles(5);

    expect(paths).toHaveLength(5);
    expect(truncated).toBe(true);
  });

  it('returns directory names nowhere in the listing — only files are readable', () => {
    mkdirSync(wt('emptydir'), { recursive: true });

    const { paths } = worktree.listFiles();

    expect(paths).not.toContain('emptydir');
  });
});

// A real run lost `plotting` to six rejections, the reviewer naming the cause on the fifth: the
// implementer assumed composition.py exposed `load_alloy` and it did not. The listing told it the
// file existed; nothing told it what to call.
describe('RepoWorktree.publicInterfaces', () => {
  it('reports the definitions a caller can actually use', () => {
    worktree.applyFileOps([
      {
        op: 'write',
        path: 'alloydamage/composition.py',
        content: 'import yaml\n\n\nclass Alloy:\n    pass\n\n\ndef load_alloy(path):\n    return None\n',
      },
    ]);

    expect(worktree.publicInterfaces()['alloydamage/composition.py']).toEqual(['class Alloy', 'def load_alloy(path)']);
  });

  it('leaves private helpers out, so the surface is the contract', () => {
    worktree.applyFileOps([{ op: 'write', path: 'm.py', content: 'def public(a):\n    pass\n\n\ndef _private():\n    pass\n' }]);

    expect(worktree.publicInterfaces()['m.py']).toEqual(['def public(a)']);
  });

  it('ignores files that define nothing, and non-Python files', () => {
    worktree.applyFileOps([
      { op: 'write', path: 'empty.py', content: 'X = 1\n' },
      { op: 'write', path: 'notes.md', content: '# def not_code(x)\n' },
    ]);
    const surface = worktree.publicInterfaces();

    expect(surface['empty.py']).toBeUndefined();
    expect(surface['notes.md']).toBeUndefined();
  });

  it('returns an empty surface for a repository with no source yet', () => {
    expect(Object.keys(worktree.publicInterfaces())).toHaveLength(0);
  });
});
