// Locates an edit's find-text in a file. Exact text wins; failing that, two narrow repairs for
// what models actually send (2026-10-03 archive): line-number prefixes copied from the repository
// read tool ("60: ### Install"), and indentation or trailing whitespace that differs from the file.
// A repair counts only when it matches exactly one place, so it can never pick between candidates.

const LINE_NUMBER_PREFIX = /^\s*\d+: ?/;

/** The exact slice of `content` an edit's `find` refers to, or undefined when it is not there. */
export function locateEditTarget(content: string, find: string): string | undefined {
  if (find.length === 0) return undefined;
  if (content.includes(find)) return find;
  const findLines = find.split('\n');
  if (findLines.length > 0 && findLines.filter((l) => l.trim()).every((l) => LINE_NUMBER_PREFIX.test(l))) {
    const unnumbered = findLines.map((l) => l.replace(LINE_NUMBER_PREFIX, '')).join('\n');
    if (content.includes(unnumbered) && content.indexOf(unnumbered) === content.lastIndexOf(unnumbered)) {
      return unnumbered;
    }
  }
  return uniqueWhitespaceInsensitiveSlice(content, find);
}

function uniqueWhitespaceInsensitiveSlice(content: string, find: string): string | undefined {
  const wanted = find.split('\n').map((l) => l.trim());
  while (wanted.length && !wanted[0]) wanted.shift();
  while (wanted.length && !wanted[wanted.length - 1]) wanted.pop();
  if (!wanted.length) return undefined;
  const lines = content.split('\n');
  let found: [number, number] | undefined;
  for (let i = 0; i + wanted.length <= lines.length; i += 1) {
    if (wanted.every((w, j) => lines[i + j]!.trim() === w)) {
      if (found) return undefined;
      found = [i, i + wanted.length];
    }
  }
  return found ? lines.slice(found[0], found[1]).join('\n') : undefined;
}

export interface UnmatchedEdit {
  path: string;
  find: string;
}

/**
 * Edits in a raw implementer response whose find-text is not in the file as it will stand when the
 * edit applies — earlier ops in the same response included, since ops apply in order.
 */
export function editsWithUnmatchedFind(value: unknown, read: (relPath: string) => string | null): UnmatchedEdit[] {
  const ops = (value as { fileOps?: unknown } | null)?.fileOps;
  if (!Array.isArray(ops)) return [];
  const pending = new Map<string, string | null>();
  const current = (p: string) => (pending.has(p) ? pending.get(p)! : read(p));
  const unmatched: UnmatchedEdit[] = [];
  for (const raw of ops) {
    if (typeof raw !== 'object' || raw === null) continue;
    const op = raw as Record<string, unknown>;
    const target = op.path ?? op.filePath;
    if (typeof target !== 'string') continue;
    if (op.op === 'write' && typeof op.content === 'string') pending.set(target, op.content);
    else if (op.op === 'delete') pending.set(target, null);
    else if (op.op === 'edit' && typeof op.find === 'string' && typeof op.replace === 'string') {
      const content = current(target);
      if (content === null) continue; // a missing file is editsAgainstMissingFiles' to report
      const slice = locateEditTarget(content, op.find);
      if (slice === undefined) unmatched.push({ path: target, find: op.find });
      else pending.set(target, content.replace(slice, () => op.replace as string));
    }
  }
  return unmatched;
}

/** Shown per file so a long one cannot crowd out the rest of the correction. */
const MAX_FILE_CHARS_SHOWN = 6000;

/** The corrective-retry message: which edits missed, and each file's text as the model must quote it. */
export function unmatchedEditMessage(unmatched: UnmatchedEdit[], read: (relPath: string) => string | null): string {
  const listed = unmatched.map((u) => `${u.path} (find began: ${JSON.stringify(u.find.slice(0, 80))})`).join('; ');
  const files = [...new Set(unmatched.map((u) => u.path))].map((p) => {
    const text = read(p) ?? '';
    const shown = text.length > MAX_FILE_CHARS_SHOWN
      ? `${text.slice(0, MAX_FILE_CHARS_SHOWN)}\n… (${text.length - MAX_FILE_CHARS_SHOWN} more characters)`
      : text;
    return `--- ${p} as it stands now ---\n${shown}`;
  });
  return `These edits' find text is not in the file: ${listed}. Copy each find verbatim from the file ` +
    'below, without line numbers, or replace the whole file with a write operation.\n\n' + files.join('\n\n');
}
