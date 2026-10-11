// Shared by the doctrine milestone tables and strategies/milestones.ts, kept apart from the
// latter so the doctrine tables do not import the module that imports them.

/** Turns one ledger entry's data into a headline, or undefined to stay silent. */
export type Milestone = (data: Record<string, any>) => string | undefined;
export type Milestones = Readonly<Record<string, Milestone>>;

const HEADLINE_MAX = 160;

/** Shortens model-written text to one line for a headline. */
export function clip(text: unknown, max = HEADLINE_MAX): string {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function list(items: unknown, max = 6): string {
  const values = Array.isArray(items) ? items.map(String) : [];
  return values.length > max ? `${values.slice(0, max).join(', ')} +${values.length - max} more` : values.join(', ');
}

/** "1 file change", "3 file changes". */
export function count(n: unknown, noun: string): string {
  return `${n} ${noun}${Number(n) === 1 ? '' : 's'}`;
}
