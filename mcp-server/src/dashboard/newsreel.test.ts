import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildReelManifest, contentTypeFor, listClips, resolveClip } from './newsreel.js';

let root: string;
/** A file outside the library, standing in for anything on the machine worth stealing. */
let secretFile: string;

beforeAll(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'swarm-newsreel-'));
  root = path.join(base, 'newsreel');
  secretFile = path.join(base, 'secret.webm');
  writeFileSync(secretFile, 'not a clip', 'utf8');

  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'byrnes.webm'), 'webm bytes', 'utf8');
  writeFileSync(path.join(root, 'reagan.webm'), 'webm bytes', 'utf8');
  // Not a video: must not be listed, and must not be servable either.
  writeFileSync(path.join(root, 'notes.txt'), 'hello', 'utf8');
  writeFileSync(path.join(root, '.hidden.webm'), 'hidden', 'utf8');
  mkdirSync(path.join(root, 'subdir.webm'));
  // A planted symlink whose own name is perfectly respectable.
  symlinkSync(secretFile, path.join(root, 'innocent.webm'));

  writeFileSync(
    path.join(root, 'credits.json'),
    JSON.stringify({
      'byrnes.webm': { title: 'Byrnes Sets US Policy for Germany (1946)', credit: 'Public domain', source: 'Wikimedia Commons' },
    }),
    'utf8',
  );
});

afterAll(() => rmSync(path.dirname(root), { recursive: true, force: true }));

describe('listClips', () => {
  it('lists only servable video files, in name order', () => {
    expect(listClips(root).map((c) => c.file)).toEqual(['byrnes.webm', 'reagan.webm']);
  });

  it('takes captions from credits.json and falls back to the filename', () => {
    const clips = listClips(root);
    expect(clips[0]).toMatchObject({
      title: 'Byrnes Sets US Policy for Germany (1946)',
      credit: 'Public domain',
      source: 'Wikimedia Commons',
    });
    // No credits entry for this one, so the filename becomes the title.
    expect(clips[1].title).toBe('reagan.webm');
    expect(clips[1].credit).toBe('');
  });

  it('builds urls the clip route can parse back', () => {
    expect(listClips(root)[0].url).toBe('/newsreel/byrnes.webm');
  });

  it('omits a symlink that escapes the library, even with an innocent name', () => {
    expect(listClips(root).map((c) => c.file)).not.toContain('innocent.webm');
  });

  it('returns nothing for a library with no directory', () => {
    expect(listClips(path.join(root, 'does-not-exist'))).toEqual([]);
  });
});

describe('resolveClip', () => {
  it('resolves a real clip to a readable path', () => {
    const resolved = resolveClip('byrnes.webm', root);
    expect(resolved).not.toBeNull();
    expect(resolved?.endsWith(path.join('newsreel', 'byrnes.webm'))).toBe(true);
  });

  it.each([
    ['..', 'a bare traversal segment'],
    ['../../../../etc/passwd', 'a deep traversal'],
    ['..%2fsecret.webm', 'an encoded traversal that arrived already decoded'],
    ['sub/byrnes.webm', 'a nested path'],
    ['.hidden.webm', 'a dotfile'],
    ['notes.txt', 'a non-video'],
    ['subdir.webm', 'a directory named like a clip'],
    ['', 'an empty name'],
  ])('refuses %s (%s)', (file) => {
    expect(resolveClip(file, root)).toBeNull();
  });

  it('refuses a symlink pointing outside the library', () => {
    expect(resolveClip('innocent.webm', root)).toBeNull();
  });
});

describe('helpers', () => {
  it('maps extensions to video types and nothing else', () => {
    expect(contentTypeFor('a.webm')).toBe('video/webm');
    expect(contentTypeFor('a.WEBM')).toBe('video/webm');
    expect(contentTypeFor('a.mp4')).toBeNull();
    expect(contentTypeFor('a.txt')).toBeNull();
  });

  it('builds a manifest from the library', () => {
    const manifest = buildReelManifest(root);
    expect(manifest.clips).toHaveLength(2);
  });
});
