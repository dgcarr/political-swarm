import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

function extractDocumentedToolCount(
  document: string,
  pattern: RegExp,
  expectedPhrase: string,
): number {
  const match = document.match(pattern);
  if (!match) {
    throw new Error(`Could not find ${expectedPhrase}; update the drift check for the new wording.`);
  }
  return Number(match[1]);
}

describe('documented MCP tool counts', () => {
  const serverSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const registeredToolCount = serverSource.match(/server\.registerTool\(/g)?.length ?? 0;

  const operations = readFileSync(new URL('../../docs/Operations.md', import.meta.url), 'utf8');

  it('matches the MCP tools count in docs/Operations.md', () => {
    const documentedToolCount = extractDocumentedToolCount(
      operations,
      /## MCP tools\s+[^\n]*?\b([0-9]+) MCP tools?\b/,
      'the MCP tool count in the first paragraph of the MCP tools section of docs/Operations.md',
    );

    expect(documentedToolCount).toBe(registeredToolCount);
  });

  it('lists exactly the registered tool names in docs/Operations.md', () => {
    const documentedList = operations.match(/The registered MCP tools are: ([^\n]+)/)?.[1];
    expect(documentedList).toBeDefined();
    const documentedNames = [...documentedList!.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    const registeredNames = [...serverSource.matchAll(/server\.registerTool\(\s*'([^']+)'/g)].map((match) => match[1]);
    expect(documentedNames.sort()).toEqual(registeredNames.sort());
  });
});
