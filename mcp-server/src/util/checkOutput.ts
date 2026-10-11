// Check output is read by models, and test runners put the actionable part at the end: pytest's
// `E   ValueError: …` lines and its short test summary come after a session header and source
// listings. Every cut used to keep the head, so a long failure reached the implementer as a header
// with the error trimmed off. Colour escapes from a TTY-styled runner also ate the budget.

const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Share of a clipped output given to its start; the rest goes to its end, where the error is. */
const HEAD_SHARE = 0.25;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

/** Strips colour codes and, when still too long, keeps the start and the end with a marker between. */
export function clipCheckOutput(text: string, maxChars: number): string {
  const plain = stripAnsi(text);
  if (plain.length <= maxChars) return plain;
  const marker = `\n…[${plain.length - maxChars} chars omitted]…\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.floor(budget * HEAD_SHARE);
  return `${plain.slice(0, head)}${marker}${plain.slice(plain.length - (budget - head))}`;
}
