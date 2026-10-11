import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  rmSync,
  readdirSync,
  realpathSync,
  copyFileSync,
  cpSync,
  mkdtempSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FileOp, TestResult } from './types.js';
import { matchesAnyGlob } from '../util/glob.js';
import { repairOverEscapedContent } from './fileOpHygiene.js';
import { locateEditTarget } from './editMatch.js';
import { logger } from '../util/logger.js';
import { checkEnv, gitEnv } from '../util/childEnv.js';
import { sandboxInvocation, type CheckSandbox } from '../util/sandbox.js';

export interface FileSnapshot {
  path: string;
  existed: boolean;
  content?: string;
}

/** git reports forward slashes; FileOp paths may use either separator, plus a "./" prefix. */
function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

const execFileAsync = promisify(execFile);

/** Directories whose contents tell an agent nothing about the code it is changing, and which
 * are large enough to crowd out the files that do. */
const LISTING_IGNORED_NAMES = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
  '.mypy_cache',
  '.ruff_cache',
  'dist',
  'build',
  '.DS_Store',
]);

/** Enough to cover a benchmark-sized repository whole; small enough that a pathological one
 * cannot dominate the prompt. */
const LISTING_MAX_ENTRIES = 400;
/** Enough to describe a package's contract without crowding out the task. */
const INTERFACE_MAX_FILES = 40;
const INTERFACE_MAX_DEFS_PER_FILE = 40;
const REPOSITORY_PAGE_SIZE = 100;
const REPOSITORY_READ_MAX_LINES = 400;
const REPOSITORY_SEARCH_MAX_MATCHES = 100;
/** Repository tools read a file whole before slicing it; past this a read is refused and a search skips the file. */
export const REPOSITORY_FILE_MAX_BYTES = 1024 * 1024;
/** No source file a task writes is this large; one that is would be generated output or a runaway model. */
export const FILE_OP_MAX_BYTES = 2 * 1024 * 1024;

/**
 * One task's view of files that are not in the shared tree: its reworked attempt, kept for it to edit
 * (TaskNode.retainedAttempt). A path mapped to null is one that attempt deleted. Only the reading
 * tools honour it; nothing is written through it.
 */
export type RepositoryOverlay = ReadonlyMap<string, string | null>;

export interface RepositoryToolResult {
  content: string;
  bytes: number;
  truncated: boolean;
  totalLines?: number;
  path?: string;
  paths?: string[];
  nextCursor?: string;
}

/** Prepended to every engine git invocation. The worktree's files are model-written, and git would
 * otherwise run repository-controlled code on our behalf: a hook directory the repo points
 * core.hooksPath at (.husky, say) or an fsmonitor command. Command-line -c outranks every config file. */
const GIT_SAFETY_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...GIT_SAFETY_CONFIG, ...args], {
    cwd,
    env: gitEnv(),
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

// Isolates all swarm work in a dedicated git worktree/branch inside the user's REAL target
// repo (never the plugin's own repo). Workers never emit raw diffs or shell commands — they
// return structured FileOp[] JSON; this class applies those and computes the real `git diff`
// afterward. Test/build execution is restricted to a single allow-listed command, never
// LLM-authored shell text, closing the obvious injection path.
export class RepoWorktree {
  public readonly worktreePath: string;
  public readonly branch: string;
  constructor(private readonly repoPath: string, private readonly runDir: string, runId: string) {
    this.worktreePath = path.join(runDir, 'wt');
    this.branch = `swarm/${runId}`;
  }

  async create(baseBranch: string): Promise<void> {
    mkdirSync(this.runDir, { recursive: true });
    await git(this.repoPath, ['worktree', 'add', '-b', this.branch, this.worktreePath, baseBranch]);
    logger.info('Created isolated worktree', { worktreePath: this.worktreePath, branch: this.branch });
  }

  /** Captures pre-task content for every path a task's fileOps will touch, so a rejected task's
   * changes can be undone precisely — there's no per-task git commit to `checkout` back to, since
   * approved tasks accumulate as uncommitted changes across the whole run until swarm_apply. */
  snapshotFileOps(fileOps: FileOp[]): FileSnapshot[] {
    const paths = [...new Set(fileOps.map((op) => op.path))];
    return paths.map((p) => {
      const target = this.resolveSafePath(p);
      const existed = existsSync(target);
      return { path: p, existed, content: existed ? readFileSync(target, 'utf8') : undefined };
    });
  }

  revertFileOps(snapshots: FileSnapshot[]): void {
    for (const s of snapshots) {
      const target = this.resolveSafePath(s.path);
      if (s.existed) {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, s.content!, 'utf8');
      } else if (existsSync(target)) {
        rmSync(target);
      }
    }
  }

  /**
   * Worktree paths git considers dirty (modified or untracked), keyed to their two-char status.
   *
   * Scoped through git rather than a raw directory walk on purpose: .gitignored build noise is
   * invisible here, which is exactly right — anything git ignores can never reach `diff.patch`,
   * so it is not ours to clean, and skipping it also avoids walking node_modules-sized trees.
   */
  async listDirtyPaths(): Promise<Map<string, string>> {
    // -z avoids git's path quoting for names with spaces/unicode; -uall lists files inside new dirs.
    const out = await git(this.worktreePath, ['status', '--porcelain', '-z', '-uall']);
    const dirty = new Map<string, string>();
    for (const entry of out.split('\0')) {
      if (entry.length < 4) continue;
      dirty.set(entry.slice(3), entry.slice(0, 2));
    }
    return dirty;
  }

  /**
   * Untracked paths that appeared between two listDirtyPaths() snapshots. Used to distinguish
   * check-generated files from authored FileOps before those files are copied or deleted.
   */
  untrackedAppearingSince(
    before: Map<string, string>,
    after: Map<string, string>,
    preservePaths: Iterable<string> = [],
  ): string[] {
    const keep = new Set<string>();
    for (const p of preservePaths) keep.add(normalizeRelPath(p));

    const appeared: string[] = [];
    for (const [relPath, status] of after) {
      if (before.has(relPath)) continue;
      if (status.trim() !== '??') continue;
      if (keep.has(normalizeRelPath(relPath))) continue;
      appeared.push(relPath);
    }
    return appeared;
  }

  /**
   * Deletes untracked files that appeared between two listDirtyPaths() snapshots, plus any
   * directories left empty. Used after a rejected task: reverting the implementer's fileOps does
   * not undo files the *check command* generated as a side effect (pytest's __pycache__/*.pyc,
   * for instance), which would otherwise survive into the run's final diff as phantom changes
   * attributable to no task at all.
   */
  removeUntrackedSince(
    before: Map<string, string>,
    after: Map<string, string>,
    preservePaths: Iterable<string> = [],
  ): string[] {
    const removed: string[] = [];
    for (const relPath of this.untrackedAppearingSince(before, after, preservePaths)) {
      const target = this.resolveSafePath(relPath);
      if (!existsSync(target)) continue;
      rmSync(target, { recursive: true, force: true });
      removed.push(relPath);
      this.pruneEmptyDirs(path.dirname(target));
    }
    return removed;
  }

  /** Copies a worktree file to an absolute destination outside the worktree, for check-artifact evidence. */
  copyWorktreeFile(relPath: string, destAbs: string): void {
    const src = this.resolveSafePath(relPath);
    if (!existsSync(src) || !statSync(src).isFile()) {
      throw new Error(`Worktree file not found: ${relPath}`);
    }
    mkdirSync(path.dirname(destAbs), { recursive: true });
    copyFileSync(src, destAbs);
  }

  /** Removes now-empty ancestor dirs (e.g. the __pycache__ dir itself), stopping at the worktree root. */
  private pruneEmptyDirs(startDir: string): void {
    const root = path.resolve(this.worktreePath);
    let dir = path.resolve(startDir);
    while (dir.startsWith(root + path.sep) && dir !== root) {
      if (!existsSync(dir) || readdirSync(dir).length > 0) return;
      rmSync(dir, { recursive: true, force: true });
      dir = path.dirname(dir);
    }
  }

  applyFileOps(fileOps: FileOp[]): string[] {
    const touched: string[] = [];
    for (const op of fileOps) {
      const target = this.resolveSafePath(op.path);
      const text = op.op === 'write' ? op.content : op.op === 'edit' ? op.replace : '';
      if (Buffer.byteLength(text) > FILE_OP_MAX_BYTES) {
        throw new Error(`FileOp content for ${op.path} is ${Buffer.byteLength(text)} bytes, over the ${FILE_OP_MAX_BYTES}-byte limit`);
      }
      touched.push(op.path);
      if (op.op === 'write') {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, this.repairModelContent(op.content, op.path), 'utf8');
      } else if (op.op === 'edit') {
        if (!existsSync(target)) throw new Error(`Cannot edit nonexistent file: ${op.path}`);
        const current = readFileSync(target, 'utf8');
        const slice = locateEditTarget(current, op.find);
        if (slice === undefined) {
          throw new Error(`Edit find-text not found in ${op.path}: ${op.find.slice(0, 120)}`);
        }
        const replacement = this.repairModelContent(op.replace, op.path);
        // A function replacer: a string one reads "$&", "$1" and friends in source code as patterns.
        writeFileSync(target, current.replace(slice, () => replacement), 'utf8');
      } else if (op.op === 'delete') {
        if (existsSync(target)) rmSync(target);
      }
    }
    return touched;
  }

  private repairModelContent(content: string, filePath: string): string {
    // Double-escaped model JSON otherwise reaches disk as invalid, single-line source; repair it
    // here so every filesystem write receives the same narrowly guarded protection.
    const repaired = repairOverEscapedContent(content);
    if (repaired !== content) {
      logger.warn('Repaired over-escaped FileOp content', { path: filePath });
    }
    return repaired;
  }

  /** Rejects any path that would escape the worktree — the one place raw model-supplied paths meet the filesystem.
   * A `.git` segment is refused too: the worktree's `.git` is a pointer into the user's REAL repository
   * metadata, so writing through it (or replacing it) would reach hooks and config outside the worktree. */
  resolveSafePath(relPath: string): string {
    if (path.isAbsolute(relPath)) throw new Error(`FileOp path must be relative: ${relPath}`);
    if (relPath.split(/[\\/]/).some((segment) => segment.toLowerCase().replace(/[. ]+$/, '') === '.git')) {
      throw new Error(`FileOp path must not touch git metadata: ${relPath}`);
    }
    const worktreeRoot = path.resolve(this.worktreePath);
    const resolved = path.resolve(worktreeRoot, relPath);
    if (!resolved.startsWith(worktreeRoot + path.sep)) {
      throw new Error(`FileOp path escapes the worktree: ${relPath}`);
    }

    let existingAncestor = resolved;
    while (!existsSync(existingAncestor)) existingAncestor = path.dirname(existingAncestor);

    const realWorktreeRoot = realpathSync(worktreeRoot);
    const realAncestor = realpathSync(existingAncestor);
    if (realAncestor !== realWorktreeRoot && !realAncestor.startsWith(realWorktreeRoot + path.sep)) {
      throw new Error(`FileOp path escapes the worktree: ${relPath}`);
    }
    return resolved;
  }

  listRepositoryFiles(glob?: string, cursor?: string, overlay?: RepositoryOverlay): RepositoryToolResult {
    const all = this.overlaidFiles(overlay).filter((file) => !glob || matchesAnyGlob(file, [glob]));
    const offset = this.parseCursor(cursor, all.length);
    const paths = all.slice(offset, offset + REPOSITORY_PAGE_SIZE);
    const nextOffset = offset + paths.length;
    const content = JSON.stringify({ paths, ...(nextOffset < all.length ? { nextCursor: String(nextOffset) } : {}) });
    return {
      content,
      bytes: Buffer.byteLength(content),
      truncated: nextOffset < all.length,
      paths,
      ...(nextOffset < all.length ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  readRepositoryFile(relPath: string, startLine = 1, endLine?: number, overlay?: RepositoryOverlay): RepositoryToolResult {
    const overlaid = overlay?.get(normalizeRelPath(relPath));
    let text: string;
    if (overlaid === null) {
      throw new Error(`Repository file not found: ${relPath}`);
    } else if (overlaid !== undefined) {
      this.resolveSafePath(relPath);
      text = overlaid;
    } else {
      const target = this.resolveSafePath(relPath);
      if (!existsSync(target) || !statSync(target).isFile()) throw new Error(`Repository file not found: ${relPath}`);
      const size = statSync(target).size;
      if (size > REPOSITORY_FILE_MAX_BYTES) {
        throw new Error(`Repository file is too large to read (${size} bytes, limit ${REPOSITORY_FILE_MAX_BYTES}): ${relPath}`);
      }
      const data = readFileSync(target);
      if (data.includes(0)) throw new Error(`Repository file is binary: ${relPath}`);
      text = data.toString('utf8');
    }
    const lines = text.split('\n');
    const totalLines = Math.max(0, lines.length - (text.endsWith('\n') ? 1 : 0));
    const first = Math.max(1, Math.floor(startLine));
    const requestedEnd = Math.max(first, Math.floor(endLine ?? first + REPOSITORY_READ_MAX_LINES - 1));
    const last = Math.min(lines.length, requestedEnd, first + REPOSITORY_READ_MAX_LINES - 1);
    const body = lines.slice(first - 1, last).map((line, index) => `${first + index}: ${line}`).join('\n');
    return {
      content: body,
      bytes: Buffer.byteLength(body),
      truncated: last < requestedEnd || last < lines.length,
      totalLines,
      path: relPath,
    };
  }

  searchRepository(query: string, glob?: string, cursor?: string, overlay?: RepositoryOverlay): RepositoryToolResult {
    if (!query) throw new Error('Repository search query must not be empty');
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const skippedLargeFiles: string[] = [];
    for (const relPath of this.overlaidFiles(overlay)) {
      if (glob && !matchesAnyGlob(relPath, [glob])) continue;
      let data: Buffer;
      const overlaid = overlay?.get(relPath);
      try {
        if (typeof overlaid === 'string') {
          data = Buffer.from(overlaid, 'utf8');
          if (data.length > REPOSITORY_FILE_MAX_BYTES) {
            skippedLargeFiles.push(relPath);
            continue;
          }
        } else {
          const target = this.resolveSafePath(relPath);
          if (statSync(target).size > REPOSITORY_FILE_MAX_BYTES) {
            skippedLargeFiles.push(relPath);
            continue;
          }
          data = readFileSync(target);
        }
      } catch {
        continue;
      }
      if (data.includes(0)) continue;
      for (const [index, line] of data.toString('utf8').split('\n').entries()) {
        if (line.includes(query)) matches.push({ path: relPath, line: index + 1, text: line.slice(0, 500) });
      }
    }
    const offset = this.parseCursor(cursor, matches.length);
    const page = matches.slice(offset, offset + REPOSITORY_SEARCH_MAX_MATCHES);
    const nextOffset = offset + page.length;
    const content = JSON.stringify({
      matches: page,
      ...(nextOffset < matches.length ? { nextCursor: String(nextOffset) } : {}),
      ...(skippedLargeFiles.length > 0
        ? { skippedLargeFiles, note: `Files over ${REPOSITORY_FILE_MAX_BYTES} bytes were not searched.` }
        : {}),
    });
    return {
      content,
      bytes: Buffer.byteLength(content),
      truncated: nextOffset < matches.length,
      paths: [...new Set(page.map((match) => match.path))],
      ...(nextOffset < matches.length ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  fallbackRepositoryBundle(paths: string[], prompt: string, byteLimit = 64 * 1024): string {
    const inventory = this.listFiles().paths;
    const selected = new Set<string>();
    const manifestNames = new Set(['package.json', 'pyproject.toml', 'requirements.txt', 'README.md', 'TASK.md']);
    for (const file of inventory) {
      if (manifestNames.has(path.basename(file))) selected.add(file);
      if (paths.some((owned) => owned === file || matchesAnyGlob(file, [owned]))) selected.add(file);
      if (prompt.includes(file)) selected.add(file);
      if (/\.(csv|tsv)$/i.test(file)) selected.add(file);
    }

    const chunks: string[] = [`FILES\n${inventory.join('\n')}`];
    let bytes = Buffer.byteLength(chunks[0]);
    for (const file of selected) {
      if (bytes >= byteLimit) break;
      let result: RepositoryToolResult;
      try {
        result = this.readRepositoryFile(file, 1, /\.(csv|tsv)$/i.test(file) ? 5 : REPOSITORY_READ_MAX_LINES);
      } catch {
        continue;
      }
      const isTabular = /\.(csv|tsv)$/i.test(file);
      const previewNotice = isTabular && result.truncated
        ? `PREVIEW ONLY — showing the first ${Math.min(5, result.totalLines ?? 5)} of ` +
          `${result.totalLines ?? 'more than 5'} physical lines (${Math.max(0, (result.totalLines ?? 1) - 1)} data rows ` +
          `after the header when the file is well-formed). The complete file on disk is authoritative. ` +
          `Never infer row counts, grid sizes, final values, or full coverage from this preview.\n`
        : '';
      const header = `\n\nFILE ${file}\n${previewNotice}`;
      const remaining = byteLimit - bytes - Buffer.byteLength(header);
      if (remaining <= 0) break;
      const content = Buffer.from(result.content).subarray(0, remaining).toString('utf8');
      chunks.push(header + content);
      bytes += Buffer.byteLength(header + content);
    }
    return Buffer.from(chunks.join('')).subarray(0, byteLimit).toString('utf8');
  }

  /** Every listed file with the overlay laid over it: its deletions removed, its new files added. */
  private overlaidFiles(overlay?: RepositoryOverlay): string[] {
    const files = this.listFiles(Number.MAX_SAFE_INTEGER).paths;
    if (!overlay?.size) return files;
    const merged = new Set(files);
    for (const [relPath, content] of overlay) {
      if (content === null) merged.delete(relPath);
      else merged.add(relPath);
    }
    return [...merged].sort((a, b) => a.localeCompare(b));
  }

  private parseCursor(cursor: string | undefined, upperBound: number): number {
    if (cursor === undefined) return 0;
    if (!/^\d+$/.test(cursor)) throw new Error('Repository cursor is invalid');
    const offset = Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > upperBound) throw new Error('Repository cursor is invalid');
    return offset;
  }

  /** Current content of a worktree path, or null when it doesn't exist (or is a directory —
   * diligence probes for directories like 'tests' by name, not just files). Used by the
   * test-integrity floor to compare proposed fileOps against what is actually on disk before
   * applying them. */
  readFileIfExists(relPath: string): string | null {
    const target = this.resolveSafePath(relPath);
    return existsSync(target) && statSync(target).isFile() ? readFileSync(target, 'utf8') : null;
  }

  /** Whether a worktree-relative path exists at all, file or directory. Diligence probes for
   * test layout by directory name ('tests', 'spec', ...), which readFileIfExists alone can't
   * confirm since it deliberately returns null for anything that isn't a plain file. */
  pathExists(relPath: string): boolean {
    return existsSync(this.resolveSafePath(relPath));
  }

  /** Worktree-relative paths of every file an agent could usefully read, depth-first and sorted.
   *
   * Exists because agents were writing code blind. readFileIfExists and pathExists both require
   * already knowing a path, so an implementer that was never told a file exists cannot discover
   * it — and in the benchmark that meant fabricating nuclear data that was sitting unread in the
   * same worktree under data/<element>/. An inventory is the smallest thing that closes that gap:
   * agents can already read anything they can name.
   *
   * Capped rather than complete. A listing that swamps the prompt costs more than the visibility
   * is worth, and the cap is reported to the caller so a truncated inventory is never mistaken
   * for the whole repository. */
  /**
   * Public top-level definitions of the source files already in the tree, keyed by path.
   *
   * An implementer authoring against a module a different task wrote could see that the file
   * existed but not what it exposed, so it guessed — and guessed wrong. A real run lost `plotting`
   * to six rejections, the reviewer naming the cause on the fifth: "The change is built on a false
   * premise about the repository API. The implementer's rationale explicitly claims
   * composition.py exposes load_alloy, but the test run proves otherwise." An earlier run lost
   * `damage` the same way, importing a NuclearDataReader that was never written.
   *
   * Signatures only, never bodies: the point is the contract to call, and inlining whole modules
   * would crowd out the task itself.
   */
  publicInterfaces(limit = INTERFACE_MAX_FILES): Record<string, string[]> {
    const surface: Record<string, string[]> = {};
    for (const rel of this.listFiles().paths) {
      if (Object.keys(surface).length >= limit) break;
      if (!rel.endsWith('.py')) continue;
      let text;
      try {
        text = readFileSync(path.join(this.worktreePath, rel), 'utf8');
      } catch {
        continue; // a file that vanished between listing and reading is not worth failing on
      }
      const defs = text
        .split('\n')
        .filter((line) => /^(class |def |async def )/.test(line))
        .map((line) => line.replace(/:\s*$/, '').trim())
        .filter((line) => !/^(def|async def) _/.test(line))
        .slice(0, INTERFACE_MAX_DEFS_PER_FILE);
      if (defs.length > 0) surface[rel] = defs;
    }
    return surface;
  }

  listFiles(limit = LISTING_MAX_ENTRIES): { paths: string[]; truncated: boolean } {
    const found: string[] = [];
    let truncated = false;

    const walk = (absDir: string, relDir: string): void => {
      if (truncated) return;
      let entries;
      try {
        entries = readdirSync(absDir, { withFileTypes: true });
      } catch {
        return; // an unreadable directory is not worth failing an entire dispatch over
      }
      for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
        if (LISTING_IGNORED_NAMES.has(entry.name)) continue;
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(absDir, entry.name), rel);
          if (truncated) return;
        } else if (entry.isFile()) {
          if (found.length >= limit) {
            truncated = true;
            return;
          }
          found.push(rel);
        }
      }
    };

    walk(this.worktreePath, '');
    return { paths: found, truncated };
  }

  /** The revision the run branched from, carried in every synchronization and delivery packet so a
   * resumed agent instance knows which base its context describes. */
  async baseRevision(): Promise<string> {
    try {
      return (await git(this.worktreePath, ['rev-parse', 'HEAD'])).trim();
    } catch (err) {
      logger.warn('Could not read base revision', { error: String(err) });
      return 'unknown';
    }
  }

  async validateForResume(expectedBaseRevision?: string): Promise<{ valid: boolean; reason?: string }> {
    if (!existsSync(this.worktreePath)) return { valid: false, reason: 'worktree directory is missing' };
    try {
      const inside = (await git(this.worktreePath, ['rev-parse', '--is-inside-work-tree'])).trim();
      if (inside !== 'true') return { valid: false, reason: 'path is not a git worktree' };
      if (expectedBaseRevision) {
        await git(this.worktreePath, ['merge-base', '--is-ancestor', expectedBaseRevision, 'HEAD']);
      }
      return { valid: true };
    } catch (error) {
      return { valid: false, reason: String(error) };
    }
  }

  async diff(excludedPathspecs: string[] = []): Promise<{ diffText: string; filesChanged: string[]; treeId: string }> {
    const treeId = await this.snapshotTree();
    const parent = (await git(this.worktreePath, ['rev-parse', 'HEAD'])).trim();
    const paths = excludedPathspecs.length > 0
      ? ['--', '.', ...excludedPathspecs.map((pattern) => `:(exclude,glob)${pattern}`)]
      : [];
    const diffText = await git(this.worktreePath, ['diff', parent, treeId, ...paths]);
    const nameStatus = await git(this.worktreePath, ['diff', '--name-only', parent, treeId, ...paths]);
    const filesChanged = nameStatus.split('\n').filter(Boolean);
    return { diffText, filesChanged, treeId };
  }

  async snapshotTree(): Promise<string> {
    await git(this.worktreePath, ['add', '-A']);
    return (await git(this.worktreePath, ['write-tree'])).trim();
  }

  /** Git's compare-and-swap reference update serializes resume across server processes. */
  async withResumeLock<T>(resume: () => Promise<T>): Promise<T> {
    const ref = `refs/political-swarm/resume/${this.branch.slice('swarm/'.length)}`;
    const previous = await git(this.repoPath, ['rev-parse', '--verify', ref]).then((value) => value.trim(), () => '');
    if (previous) {
      const owner = JSON.parse(await git(this.repoPath, ['show', '-s', '--format=%B', previous])) as { pid: number; hostname: string };
      let alive = true;
      if (owner.hostname === os.hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); } catch (error) {
          alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
      }
      if (alive) throw new Error('Run resume is already locked by another engine.');
    }
    const tree = (await git(this.repoPath, ['rev-parse', 'HEAD^{tree}'])).trim();
    const owner = JSON.stringify({ pid: process.pid, hostname: os.hostname(), nonce: randomUUID() });
    const token = (await git(this.repoPath, ['-c', 'user.name=Political Swarm', '-c', 'user.email=swarm@localhost', 'commit-tree', tree, '-m', owner])).trim();
    try {
      await git(this.repoPath, ['update-ref', ref, token, previous]);
    } catch {
      throw new Error('Run resume is already locked by another engine.');
    }
    try {
      return await resume();
    } finally {
      await git(this.repoPath, ['update-ref', '-d', ref, token]);
    }
  }

  async commit(message: string, expectedTree?: string): Promise<string> {
    if (expectedTree) {
      if (await this.snapshotTree() !== expectedTree) {
        throw new Error('Worktree changed since delivery acceptance. Restore the reviewed files or start a new run before applying.');
      }
      const parent = (await git(this.worktreePath, ['rev-parse', 'HEAD'])).trim();
      // Commit the reviewed object, not a mutable index that another process could restage.
      const commit = (await git(this.worktreePath, ['commit-tree', expectedTree, '-p', parent, '-m', message])).trim();
      await git(this.worktreePath, ['update-ref', `refs/heads/${this.branch}`, commit, parent]);
      return commit;
    }
    await git(this.worktreePath, ['add', '-A']);
    await git(this.worktreePath, ['commit', '-m', message, '--allow-empty']);
    const sha = (await git(this.worktreePath, ['rev-parse', 'HEAD'])).trim();
    return sha;
  }

  /**
   * Runs a single allow-listed command (e.g. from package.json scripts.test), never
   * model-authored shell text — command/args always come from engine-internal call sites.
   * On win32, known package-manager commands are .cmd shims; execFile can't invoke a .cmd
   * directly (throws EINVAL) even when named explicitly (e.g. "npm.cmd") — Windows requires
   * cmd.exe itself to be the spawned process, with the shim name passed as an argument.
   * cmd.exe does its own PATH/PATHEXT lookup, so "npm" resolves correctly under it.
   * The command still executes model-written code (the tests it runs), so it gets a scrubbed
   * environment — never the server's own, which carries OPENROUTER_API_KEY.
   */
  async runAllowListedCommand(
    command: string,
    args: string[],
    timeoutMs: number,
    options: { sandbox?: CheckSandbox; cwd?: string } = {},
  ): Promise<TestResult> {
    const cwd = options.cwd ?? this.worktreePath;
    const resolved = this.resolveWindowsInvocation(command, args);
    const confined = sandboxInvocation(options.sandbox ?? 'none', cwd, resolved.cmd, resolved.cmdArgs);
    if ('unavailable' in confined) {
      // Fail closed: an unconfined run of a check the configuration says must be confined is not
      // evidence, and a skipped required check blocks acceptance.
      return { ran: false, passed: false, command: [command, ...args].join(' '), output: confined.unavailable };
    }
    const { cmd, cmdArgs } = confined;
    try {
      const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        let timedOut = false;
        let bufferExceeded = false;
        let spawnError: Error | undefined;
        const maxBufferBytes = 16 * 1024 * 1024;
        const output: Buffer[] = [];
        const errors: Buffer[] = [];
        let capturedBytes = 0;
        const child = spawn(cmd, cmdArgs, {
          cwd,
          env: checkEnv(),
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const terminateTree = () => {
          if (child.pid === undefined) return;
          try {
            if (process.platform === 'win32') child.kill('SIGKILL');
            else process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
              logger.warn('Could not terminate check process group', { command, pid: child.pid, error: String(error) });
              child.kill('SIGKILL');
            }
          }
        };
        const capture = (chunk: Buffer, chunks: Buffer[]) => {
          const remaining = maxBufferBytes - capturedBytes;
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
          capturedBytes += chunk.length;
          if (capturedBytes > maxBufferBytes && !bufferExceeded) {
            bufferExceeded = true;
            terminateTree();
          }
        };
        child.stdout.on('data', (chunk: Buffer) => capture(chunk, output));
        child.stderr.on('data', (chunk: Buffer) => capture(chunk, errors));
        child.once('error', (error) => {
          spawnError = error;
        });
        const timer = setTimeout(() => {
          timedOut = true;
          terminateTree();
        }, timeoutMs);
        child.once('close', (exitCode) => {
          clearTimeout(timer);
          const stdout = Buffer.concat(output).toString('utf8');
          const stderr = Buffer.concat(errors).toString('utf8');
          if (!spawnError && !timedOut && !bufferExceeded && exitCode === 0) {
            resolve({ stdout, stderr });
            return;
          }
          const failure = spawnError ?? new Error(timedOut
            ? `Command exceeded its ${timeoutMs}ms timeout: ${command}`
            : bufferExceeded
              ? `Command output exceeded ${maxBufferBytes} bytes: ${command}`
              : `Command failed with exit code ${exitCode}: ${command}`);
          reject(Object.assign(failure, { stdout, stderr }));
        });
      });
      return { ran: true, passed: true, command: [command, ...args].join(' '), output: stdout + stderr };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string; code?: string };
      if (e.code === 'ENOENT') {
        // The command itself couldn't be found/run — this is "no test evidence", not "tests failed".
        return {
          ran: false,
          passed: false,
          command: [command, ...args].join(' '),
          output: `Command not found or could not be executed: ${e.message}`,
        };
      }
      return {
        ran: true,
        passed: false,
        command: [command, ...args].join(' '),
        output: (e.stdout ?? '') + (e.stderr ?? '') + e.message,
      };
    }
  }

  /**
   * Runs an allow-listed command in a throwaway copy of the worktree, for a critic probing the
   * change under review. The copy keeps whatever the command writes (CSV output, caches, an
   * overwritten source file) out of the tree the engine is about to accept or revert.
   */
  async runInScratchCopy(
    command: string,
    args: string[],
    timeoutMs: number,
    options: { sandbox?: CheckSandbox } = {},
  ): Promise<TestResult> {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'swarm-review-'));
    try {
      cpSync(this.worktreePath, scratch, {
        recursive: true,
        filter: (source) => path.basename(source) !== '.git',
      });
      return await this.runAllowListedCommand(command, args, timeoutMs, { ...options, cwd: scratch });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  private resolveWindowsInvocation(command: string, args: string[]): { cmd: string; cmdArgs: string[] } {
    if (process.platform !== 'win32') return { cmd: command, cmdArgs: args };
    const shimmed = new Set(['npm', 'npx', 'yarn', 'pnpm']);
    if (!shimmed.has(command)) return { cmd: command, cmdArgs: args };
    const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    return { cmd: comspec, cmdArgs: ['/d', '/s', '/c', command, ...args] };
  }

  /** Merges the run's branch back onto baseBranch in the ORIGINAL repo — the only step that touches the real tree. */
  async applyToRealRepo(baseBranch: string, revision = this.branch): Promise<{ commitSha: string }> {
    const currentBranch = (await git(this.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (currentBranch !== baseBranch) {
      throw new Error(
        `Refusing to apply: real repo is on branch "${currentBranch}", expected "${baseBranch}". ` +
          `Switch branches yourself and re-run /swarm-apply if this is intentional.`,
      );
    }
    // Fetch into FETCH_HEAD rather than a named local branch ref: the branch is checked out
    // in the worktree, and git refuses to fetch/update a ref that's checked out elsewhere.
    await git(this.repoPath, ['fetch', this.worktreePath, revision]);
    await git(this.repoPath, ['merge', '--no-edit', revision]);
    const sha = (await git(this.repoPath, ['rev-parse', 'HEAD'])).trim();
    return { commitSha: sha };
  }

  /** Files the run's committed branch changes relative to the commit it branched from. */
  async changedSinceBase(baseBranch: string, revision = 'HEAD'): Promise<string[]> {
    const base = (await git(this.worktreePath, ['merge-base', baseBranch, revision])).trim();
    return (await git(this.worktreePath, ['diff', '--name-only', base, revision])).split('\n').filter(Boolean);
  }

  /**
   * Applies only `paths` from the run's branch onto baseBranch in the ORIGINAL repo, as one new
   * commit. The patch runs from the commit the run branched from to the run's head, so later
   * commits on baseBranch are kept and a file they changed in the way of the patch stops the apply
   * rather than being overwritten. Refuses, before touching anything, when the real repo has
   * staged changes (they would ride along in the commit) or uncommitted edits to these paths.
   */
  async applyPathsToRealRepo(baseBranch: string, paths: readonly string[], options: { message: string; revision: string }): Promise<{ commitSha: string }> {
    const { message, revision } = options;
    const currentBranch = (await git(this.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (currentBranch !== baseBranch) {
      throw new Error(
        `Refusing to apply: real repo is on branch "${currentBranch}", expected "${baseBranch}". ` +
          `Switch branches yourself and re-run /swarm-apply if this is intentional.`,
      );
    }
    if ((await git(this.repoPath, ['diff', '--cached', '--name-only'])).trim()) {
      throw new Error('Refusing to apply: the real repo has staged changes, which would be committed with these tasks. Commit or unstage them first.');
    }
    const dirty = (await git(this.repoPath, ['status', '--porcelain', '--', ...paths])).trim();
    if (dirty) {
      throw new Error(`Refusing to apply: the real repo has uncommitted changes to files these tasks change:\n${dirty}`);
    }
    await git(this.repoPath, ['fetch', this.worktreePath, revision]);
    const base = (await git(this.repoPath, ['merge-base', 'HEAD', revision])).trim();
    const patch = await git(this.repoPath, ['diff', '--binary', base, revision, '--', ...paths]);
    if (!patch.trim()) throw new Error('Nothing to apply: the selected tasks changed no files.');
    const patchFile = path.join(this.runDir, `subset-${Date.now()}.patch`);
    writeFileSync(patchFile, patch, 'utf8');
    try {
      try {
        await git(this.repoPath, ['apply', '--check', '--index', patchFile]);
      } catch (err) {
        const alreadyApplied = await git(this.repoPath, ['apply', '--check', '--reverse', patchFile]).then(() => true, () => false);
        if (alreadyApplied) throw new Error(`Nothing to apply: "${baseBranch}" already has these tasks' changes.`);
        throw new Error(
          `Refusing to apply: the selected tasks' changes no longer apply cleanly to "${baseBranch}" ` +
            `(it changed the same lines since the run began). Nothing was changed. ${String((err as { stderr?: string }).stderr ?? err).trim()}`,
        );
      }
      await git(this.repoPath, ['apply', '--index', patchFile]);
      await git(this.repoPath, ['commit', '-m', message]);
    } finally {
      rmSync(patchFile, { force: true });
    }
    return { commitSha: (await git(this.repoPath, ['rev-parse', 'HEAD'])).trim() };
  }

  async cleanup(): Promise<void> {
    try {
      await git(this.repoPath, ['worktree', 'remove', '--force', this.worktreePath]);
    } catch (err) {
      logger.warn('Failed to remove worktree cleanly', { error: String(err) });
    }
  }
}
