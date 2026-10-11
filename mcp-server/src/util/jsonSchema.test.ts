import { describe, expect, it } from 'vitest';
import { extractJson } from './jsonSchema.js';

// The regression this file exists for: extractJson used to search anywhere in the text for a
// markdown fence and treat whatever followed as the payload. An implementer's fileOps carry source
// code, models routinely wrap that code in a fence inside the "content" string, and the search
// found *that* fence — tearing apart a document that had parsed perfectly well a moment earlier.
// It threw on the implementer role of every doctrine, and the corrective retries and fallbacks that
// followed were being read as model flakiness.

describe('text that is already valid JSON', () => {
  it('is returned untouched, even when a string value contains a markdown fence', () => {
    const value = {
      fileOps: [
        {
          op: 'write',
          path: 'src/validation.ts',
          content: '```typescript\nimport { Request } from "express";\nexport const ok = true;\n```',
        },
      ],
      rationale: 'Added validation.',
      filesChanged: ['src/validation.ts'],
      unresolvedUncertainty: 'none',
    };
    expect(extractJson(JSON.stringify(value))).toEqual(value);
  });

  it('survives a bare triple backtick inside a string value', () => {
    expect(extractJson(JSON.stringify({ note: 'use ``` to fence' }))).toEqual({ note: 'use ``` to fence' });
  });

  it('handles the top-level array form the socialist planner still accepts', () => {
    expect(extractJson('[{"id":"a"}]')).toEqual([{ id: 'a' }]);
  });
});

describe('a fence that genuinely wraps the response', () => {
  it('is stripped when tagged json', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('is stripped when untagged', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  // A model that writes ```typescript around an object is still handing us that object.
  it('is stripped whatever language it claims', () => {
    expect(extractJson('```typescript\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```JSON\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('is only honoured at the start, not mid-document', () => {
    // Prose, then a fenced object: the object is still found by the brace span.
    expect(extractJson('Here is the result:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
});

describe('recovering a payload from imperfect output', () => {
  it('digs an object out of surrounding prose', () => {
    expect(extractJson('Sure! {"a":1} — hope that helps.')).toEqual({ a: 1 });
  });

  it('repairs a literal newline inside a string value', () => {
    expect(extractJson('{"a":"one\ntwo"}')).toEqual({ a: 'one\ntwo' });
  });

  it('removes an extra quote after an array object without changing file content', () => {
    const content = 'const text = `}" ]`;\nconsole.log(text);\n';
    const value = { fileOps: [{ op: 'write', path: 'src/example.ts', content }], rationale: 'done' };
    const malformed = JSON.stringify(value).replace('}],"rationale"', '}"],"rationale"');
    expect(extractJson(malformed)).toEqual(value);
  });

  it('removes trailing commas outside strings without rewriting source text', () => {
    const content = 'const exact = ",}";\nconst list = [1, ];\n';
    const value = { fileOps: [{ op: 'write', path: 'src/example.ts', content }], rationale: 'done' };
    const malformed = JSON.stringify(value).replace('"}],"rationale"', '",}],"rationale"');
    expect(extractJson(malformed)).toEqual(value);
  });

  it('closes a root array when the next token is an object field', () => {
    const content = 'example }, "rationale": sample';
    const value = { fileOps: [{ op: 'write', path: 'src/example.ts', content }], rationale: 'done' };
    const malformed = JSON.stringify(value).replace('}],"rationale"', '},"rationale"');
    expect(extractJson(malformed)).toEqual(value);
  });

  it('does not guess how to fix an incomplete file operation', () => {
    expect(() => extractJson('{"fileOps":[{"op":"write","path":"src/example.ts"},"],"rationale":"done"}'))
      .toThrow(/No parseable JSON/);
  });
});

describe('output with no payload at all', () => {
  it('throws, rather than returning something invented', () => {
    expect(() => extractJson('I cannot help with that.')).toThrow(/No parseable JSON/);
    expect(() => extractJson('```typescript\nconst x = 1;\n```')).toThrow(/No parseable JSON/);
  });

  it('quotes the offending text so the failure can be diagnosed', () => {
    expect(() => extractJson('nope')).toThrow(/nope/);
  });
});
