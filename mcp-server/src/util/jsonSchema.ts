const MAX_DIAGNOSTIC_TEXT_LENGTH = 200;

// Cheap models very commonly emit multi-line file content as a JSON string value with the
// newlines left literal instead of escaped as \n, which makes JSON.parse fail hard (not just
// on formatting, but structurally). This walks the text tracking whether we're inside a
// double-quoted string (respecting backslash escapes) and escapes stray control characters
// found there, without touching whitespace that's structurally between tokens.
function escapeStrayControlCharsInStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === '\\') {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        out += ch;
        inString = false;
      } else if (ch === '\n') {
        out += '\\n';
      } else if (ch === '\r') {
        out += '\\r';
      } else if (ch === '\t') {
        out += '\\t';
      } else {
        out += ch;
      }
    } else {
      out += ch;
      if (ch === '"') inString = true;
    }
  }
  return out;
}

// Repair only unambiguous delimiter slips outside JSON strings. Source code in a `content`
// string is copied byte-for-byte, even when it contains the same character sequences.
function repairUnambiguousDelimiters(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  const containers: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') containers.push(ch);
    else if (ch === ',') {
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next]!)) next += 1;
      if (text[next] === '}' || text[next] === ']') continue;
      // A root-object array of file operations sometimes ends after its last object without
      // the closing bracket. A quoted key followed by a colon cannot be the next array item.
      if (containers.length === 2 && containers[0] === '{' && containers[1] === '[' &&
        out.trimEnd().endsWith('}') && text[next] === '"') {
        let keyEnd = next + 1;
        while (keyEnd < text.length) {
          if (text[keyEnd] === '\\') keyEnd += 2;
          else if (text[keyEnd] === '"') break;
          else keyEnd += 1;
        }
        let afterKey = keyEnd + 1;
        while (afterKey < text.length && /\s/.test(text[afterKey]!)) afterKey += 1;
        if (text[afterKey] === ':') {
          out += ']';
          containers.pop();
        }
      }
    }
    else if (ch === '}' || ch === ']') {
      if (containers.at(-1) === (ch === '}' ? '{' : '[')) containers.pop();
      if (ch === '}' && containers.at(-1) === '[' && text[i + 1] === '"') {
        let next = i + 2;
        while (next < text.length && /\s/.test(text[next]!)) next += 1;
        if (text[next] === ']') {
          out += ch;
          i += 1;
          continue;
        }
      }
    }
    out += ch;
  }
  return out;
}

// Extracts and parses a single JSON object/array from a model's raw text response.
// Cheap models frequently wrap JSON in prose or markdown fences, or leave newlines
// unescaped inside string values, despite instructions; this recovers the payload rather
// than failing on the first formatting slip.
//
// The order below matters, and it is the whole point of this function. Text that already parses is
// returned untouched, before any fence hunting happens at all — because an implementer's fileOps
// carry source code, models routinely wrap that code in a fence *inside* the "content" string, and
// searching the document for a fence would find that inner one and tear the surrounding JSON apart.
// That is not hypothetical: it was throwing on the implementer role of every doctrine, and the
// resulting corrective retries and fallbacks were being read as model flakiness.
//
// A fence that genuinely wraps the response encloses the whole of it, so it is only honoured at the
// start of the text, and any language tag is allowed — a model that writes ```typescript around an
// object is still handing us that object.
export function extractJson(raw: string): unknown {
  const rawTrimmed = raw.trim();
  const attempts: string[] = [rawTrimmed];

  const fenced = rawTrimmed.match(/^```[a-zA-Z0-9_+-]*[ \t]*\r?\n?([\s\S]*?)```\s*$/);
  const trimmed = fenced ? fenced[1].trim() : rawTrimmed;
  if (trimmed !== rawTrimmed) attempts.push(trimmed);

  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  const arrMatch = trimmed.match(/\[[\s\S]*\]/);
  const span = objMatch?.[0] ?? arrMatch?.[0];
  if (span && span !== trimmed) attempts.push(span);

  let lastErr: unknown;
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch (err) {
      lastErr = err;
    }
    // Second chance on the same candidate: repair stray literal control characters inside strings.
    try {
      return JSON.parse(escapeStrayControlCharsInStrings(attempt));
    } catch (err) {
      lastErr = err;
    }
    const repaired = repairUnambiguousDelimiters(escapeStrayControlCharsInStrings(attempt));
    if (repaired !== attempt) {
      try {
        return JSON.parse(repaired);
      } catch (err) {
        lastErr = err;
      }
    }
  }
  throw new Error(
    `No parseable JSON object/array found in model output (${String(lastErr)}): ${trimmed.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH)}`,
  );
}

export class JsonValidationError extends Error {
  constructor(message: string, public readonly rawOutput: string) {
    super(message);
    this.name = 'JsonValidationError';
  }
}
