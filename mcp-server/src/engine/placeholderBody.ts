/**
 * Detects a file delivered as finished whose body is a placeholder.
 *
 * Two doctrines shipped modules that were literally the three bytes `...` — capitalist's cli.py,
 * __main__.py, damage.py, nuclear_data.py and plotting.py in one run, democratic's nuclear_data.py
 * in another, one of them approved by its own committee. Nothing catches it downstream: an empty
 * module breaks no test until something imports it, so the checks stay green and the cost lands on
 * the next task, which is rejected for an ImportError in a file it does not own and cannot edit.
 *
 * Telling implementers not to do it was not enough — the instruction shipped, and the next run
 * produced five stub files anyway. So this is mechanical: the artifact is inspected rather than the
 * worker believed.
 *
 * Deliberately conservative. A false negative costs one more review cycle; a false positive throws
 * away real work and would corrupt a doctrine's result, so anything ambiguous is left alone. In
 * particular an empty or comment-only file is NOT flagged — a bare `__init__.py` is legitimate
 * Python — and only a body that is *nothing but* a placeholder token counts.
 */

/** A whole-file body that states, in Python, "not written yet". */
const PLACEHOLDER_BODIES = new Set(['...', 'pass', 'raise NotImplementedError', 'NotImplemented']);

const NOT_IMPLEMENTED_CALL = /^raise\s+NotImplementedError\s*\(.*\)$/s;

/** Strips one leading module docstring, so `"""Loads data."""\n...` is still seen as a stub. */
function stripLeadingDocstring(body: string): string {
  const match = /^(?:"""[\s\S]*?"""|'''[\s\S]*?''')/.exec(body.trimStart());
  if (!match) return body;
  return body.trimStart().slice(match[0].length);
}

function meaningfulLines(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** True when the file's entire content says "not written yet". */
export function isPlaceholderBody(content: string): boolean {
  const lines = meaningfulLines(stripLeadingDocstring(content));
  // An empty or comment-only file is legitimate (`__init__.py`), so it is never flagged here.
  if (lines.length !== 1) return false;
  const only = lines[0]!;
  return PLACEHOLDER_BODIES.has(only) || NOT_IMPLEMENTED_CALL.test(only);
}

/**
 * Paths in a model's output that are being written as placeholders.
 *
 * Walks the parsed value structurally rather than against one doctrine's schema: all five return
 * `{ fileOps: [{ op, path | filePath, content }] }`, but they validate it through five different
 * validators, so keying off the shape is what keeps this identical for every doctrine.
 */
export function placeholderFileWrites(value: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<object>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    if (seen.has(node)) return;
    seen.add(node);

    const record = node as Record<string, unknown>;
    const path = record.path ?? record.filePath;
    if (record.op === 'write' && typeof path === 'string' && typeof record.content === 'string') {
      if (isPlaceholderBody(record.content)) found.push(path);
    }
    Object.values(record).forEach(walk);
  };

  walk(value);
  return found;
}

/**
 * Paths an `edit` operation targets that are not in the worktree.
 *
 * applyFileOps throws on these, which reaches handleTaskError and blocks the task. It is a
 * particularly easy mistake to make on a retry: a rejected attempt has its files reverted, so an
 * implementer repairing its own previous work edits a file that no longer exists.
 */
export function editsAgainstMissingFiles(value: unknown, exists: (relPath: string) => boolean): string[] {
  const missing: string[] = [];
  const seen = new Set<object>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    if (seen.has(node)) return;
    seen.add(node);

    const record = node as Record<string, unknown>;
    const target = record.path ?? record.filePath;
    if (record.op === 'edit' && typeof target === 'string' && !exists(target)) missing.push(target);
    Object.values(record).forEach(walk);
  };

  walk(value);
  return missing;
}
