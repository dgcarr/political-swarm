export type Verdict = 'approve' | 'reject' | 'flag';

type FileOpFields =
  | { op: 'write'; content: string }
  | { op: 'edit'; find: string; replace: string }
  | { op: 'delete' };

export type FileOpWithPathKey<PathKey extends string> = FileOpFields & Record<PathKey, string>;

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export const MISSING_RATIONALE = '(the implementer gave no rationale)';

/**
 * An implementer's rationale is commentary on its fileOps, which reviewers judge on their own merits.
 * Models drop the field often enough that rejecting the whole response for it failed tasks outright
 * (2026-10-03 A/B: 3 of 5 implementer JSON failures), so a missing one is filled in place instead.
 */
export function fillMissingRationale(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  const v = value as { rationale?: unknown };
  if (!isNonEmptyString(v.rationale)) v.rationale = MISSING_RATIONALE;
}

export function isSafeRelativePath(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  return !value.split(/[/\\]/).includes('..');
}

export function isValidFileOpShape<PathKey extends string>(
  value: unknown,
  pathKey: PathKey,
): value is FileOpWithPathKey<PathKey> {
  if (typeof value !== 'object' || value === null) return false;
  const op = value as Record<string, unknown>;
  if (!isNonEmptyString(op[pathKey])) return false;
  if (op.op === 'write') return typeof op.content === 'string';
  if (op.op === 'edit') return typeof op.find === 'string' && typeof op.replace === 'string';
  return op.op === 'delete';
}

export function isValidVerdict(value: unknown): value is Verdict {
  return value === 'approve' || value === 'reject' || value === 'flag';
}
