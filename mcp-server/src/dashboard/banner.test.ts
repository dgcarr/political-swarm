import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildManifest,
  contentTypeFor,
  isBannerStrategy,
  listPosters,
  resolvePoster,
  titleFromFilename,
} from './banner.js';

let root: string;
/** A file outside the library, standing in for anything on the machine worth stealing. */
let secretFile: string;

beforeAll(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'swarm-banner-'));
  root = path.join(base, 'propaganda');
  secretFile = path.join(base, 'secret.png');
  writeFileSync(secretFile, 'not a poster', 'utf8');

  const socialist = path.join(root, 'socialist');
  mkdirSync(socialist, { recursive: true });
  writeFileSync(path.join(socialist, 'one-plan.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8');
  writeFileSync(path.join(socialist, 'red_dawn.jpg'), 'jpeg bytes', 'utf8');
  // Not an image: must not be listed, and must not be servable either.
  writeFileSync(path.join(socialist, 'notes.txt'), 'hello', 'utf8');
  writeFileSync(path.join(socialist, '.hidden.png'), 'hidden', 'utf8');
  mkdirSync(path.join(socialist, 'subdir.png'));
  writeFileSync(
    path.join(socialist, 'credits.json'),
    JSON.stringify({ 'one-plan.svg': { title: 'One Plan', credit: 'Drawn here', source: 'political-swarm' } }),
    'utf8',
  );

  mkdirSync(path.join(root, 'democratic'), { recursive: true });
  writeFileSync(path.join(root, 'democratic', 'vote.png'), 'png bytes', 'utf8');
  // A planted symlink whose own name is perfectly respectable.
  symlinkSync(secretFile, path.join(root, 'democratic', 'innocent.png'));

  // capitalist directory deliberately absent: an unfilled library is a normal state.
});

afterAll(() => rmSync(path.dirname(root), { recursive: true, force: true }));

describe('strategy names', () => {
  it('accepts the three traditions with posters', () => {
    expect(isBannerStrategy('socialist')).toBe(true);
    expect(isBannerStrategy('democratic')).toBe(true);
    expect(isBannerStrategy('capitalist')).toBe(true);
  });

  it('rejects anything else, including a traversal dressed as a strategy', () => {
    expect(isBannerStrategy('noop')).toBe(false);
    expect(isBannerStrategy('../../etc')).toBe(false);
    expect(isBannerStrategy('')).toBe(false);
  });
});

describe('listPosters', () => {
  it('lists only servable images, in name order', () => {
    const posters = listPosters('socialist', root);
    expect(posters.map((p) => p.file)).toEqual(['one-plan.svg', 'red_dawn.jpg']);
  });

  it('takes captions from credits.json and falls back to the filename', () => {
    const posters = listPosters('socialist', root);
    expect(posters[0]).toMatchObject({ title: 'One Plan', credit: 'Drawn here', source: 'political-swarm' });
    // No credits entry for this one, so the filename becomes the caption.
    expect(posters[1].title).toBe('Red dawn');
    expect(posters[1].credit).toBe('');
  });

  it('builds urls the poster route can parse back', () => {
    expect(listPosters('socialist', root)[0].url).toBe('/banner/socialist/one-plan.svg');
  });

  it('omits a symlink that escapes the library, even with an innocent name', () => {
    expect(listPosters('democratic', root).map((p) => p.file)).toEqual(['vote.png']);
  });

  it('returns nothing for a tradition with no directory', () => {
    expect(listPosters('capitalist', root)).toEqual([]);
  });
});

describe('resolvePoster', () => {
  it('resolves a real poster to a readable path', () => {
    const resolved = resolvePoster('socialist', 'one-plan.svg', root);
    expect(resolved).not.toBeNull();
    expect(resolved?.endsWith(path.join('socialist', 'one-plan.svg'))).toBe(true);
  });

  it.each([
    ['..', 'a bare traversal segment'],
    ['../../../../etc/passwd', 'a deep traversal'],
    ['..%2fsecret.png', 'an encoded traversal that arrived already decoded'],
    ['sub/one-plan.svg', 'a nested path'],
    ['.hidden.png', 'a dotfile'],
    ['notes.txt', 'a non-image'],
    ['subdir.png', 'a directory named like an image'],
    ['', 'an empty name'],
  ])('refuses %s (%s)', (file) => {
    expect(resolvePoster('socialist', file, root)).toBeNull();
  });

  it('refuses a symlink pointing outside the library', () => {
    expect(resolvePoster('democratic', 'innocent.png', root)).toBeNull();
  });

  it('refuses an unknown tradition even when the file exists', () => {
    expect(resolvePoster('noop', 'one-plan.svg', root)).toBeNull();
    expect(resolvePoster('../socialist', 'one-plan.svg', root)).toBeNull();
  });
});

describe('helpers', () => {
  it('maps extensions to image types and nothing else', () => {
    expect(contentTypeFor('a.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('a.JPG')).toBe('image/jpeg');
    expect(contentTypeFor('a.txt')).toBeNull();
    expect(contentTypeFor('a.html')).toBeNull();
  });

  it('turns a filename into a readable title', () => {
    expect(titleFromFilename('soviet_may-day_1934.jpg')).toBe('Soviet may day 1934');
  });

  it('carries the rotation interval into the manifest', () => {
    const manifest = buildManifest('socialist', root, 2500);
    expect(manifest.intervalMs).toBe(2500);
    expect(manifest.posters).toHaveLength(2);
  });
});
