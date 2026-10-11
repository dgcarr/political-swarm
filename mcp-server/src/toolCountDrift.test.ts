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

  it('matches the Development status count in README.md', () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    const documentedToolCount = extractDocumentedToolCount(
      readme,
      /## Development status\s+[^\n]*?\b([0-9]+) MCP tools?\b/,
      'the MCP tool count in the first paragraph of the Development status section of README.md',
    );

    expect(documentedToolCount).toBe(registeredToolCount);
  });

  it('lists exactly the registered tool names in README.md', () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    const documentedList = readme.match(/The registered MCP tools are: ([^\n]+)/)?.[1];
    expect(documentedList).toBeDefined();
    const documentedNames = [...documentedList!.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    const registeredNames = [...serverSource.matchAll(/server\.registerTool\(\s*'([^']+)'/g)].map((match) => match[1]);
    expect(documentedNames.sort()).toEqual(registeredNames.sort());
  });
});
