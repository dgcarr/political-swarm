const MINIMUM_REPAIR_LENGTH = 32;
const MINIMUM_ESCAPED_NEWLINES = 2;
const FORBIDDEN_SOURCE_CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

interface FileOpLike {
  op?: unknown;
  path?: unknown;
  content?: unknown;
  find?: unknown;
  replace?: unknown;
}

export function pathsWithForbiddenControlCharacters(value: unknown): string[] {
  const fileOps = (value as { fileOps?: unknown } | null)?.fileOps;
  if (!Array.isArray(fileOps)) return [];
  const paths = new Set<string>();
  for (const candidate of fileOps) {
    if (!candidate || typeof candidate !== 'object') continue;
    const operation = candidate as FileOpLike;
    const textFields = [operation.content, operation.find, operation.replace];
    if (
      typeof operation.path === 'string' &&
      textFields.some((field) => typeof field === 'string' && FORBIDDEN_SOURCE_CONTROL_CHARACTER.test(field))
    ) {
      paths.add(operation.path);
    }
  }
  return [...paths];
}

function hasOverEscapedSignature(content: string): boolean {
  if (content.length < MINIMUM_REPAIR_LENGTH || content.includes('\n') || content.includes('\r')) {
    return false;
  }

  let escapedNewlines = 0;
  for (let index = 0; index < content.length - 1; index += 1) {
    if (content[index] === '\\' && content[index + 1] === 'n') {
      escapedNewlines += 1;
      // Two escaped line breaks is a deliberately small threshold: it catches compact source
      // blocks while the length guard excludes ordinary one-line expressions with an escape.
      if (escapedNewlines >= MINIMUM_ESCAPED_NEWLINES) return true;
    }
  }

  return false;
}

export function repairOverEscapedContent(content: string): string;
export function repairOverEscapedContent(content: null): null;
export function repairOverEscapedContent(content: undefined): undefined;
export function repairOverEscapedContent(content: string | null | undefined): string | null | undefined {
  if (typeof content !== 'string' || !hasOverEscapedSignature(content)) return content;

  let repaired = '';
  for (let index = 0; index < content.length; index += 1) {
    const current = content[index];
    if (current !== '\\' || index + 1 >= content.length) {
      repaired += current;
      continue;
    }

    const escaped = content[index + 1];
    switch (escaped) {
      case 'n':
        repaired += '\n';
        index += 1;
        break;
      case 't':
        repaired += '\t';
        index += 1;
        break;
      case 'r':
        repaired += '\r';
        index += 1;
        break;
      case '"':
        repaired += '"';
        index += 1;
        break;
      case '\\':
        repaired += '\\';
        index += 1;
        break;
      default:
        repaired += current;
    }
  }

  return repaired;
}
