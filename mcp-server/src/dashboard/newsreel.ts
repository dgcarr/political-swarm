// The newsreel reel: a handful of muted archival clips, playing behind the masthead regardless of
// which tradition is on screen.
//
// Unlike the propaganda banner, this library is not one directory per tradition. The clips that
// clear a real licence check skew heavily Western — see assets/newsreel/credits.json — and forcing
// them into three even piles would misrepresent that as balance. So there is one flat library, and
// this module owns the same two things banner.ts owns for posters: what counts as a clip, and how a
// request path maps back to a file on disk.

import path from 'node:path';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { defaultNewsreelDir } from './paths.js';

/** Extensions served from the reel library, and the type each is served as. */
const VIDEO_TYPES: Record<string, string> = {
  '.webm': 'video/webm',
};

/** Same containment discipline as banner.ts's POSTER_NAME: no separators, no traversal segments. */
const CLIP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Provenance for one clip, as recorded in the library's `credits.json`. */
export interface ClipCredit {
  title?: string;
  credit?: string;
  source?: string;
}

export interface Clip {
  /** Filename within the library. */
  file: string;
  /** Path the page loads it from. */
  url: string;
  title: string;
  credit: string;
  /** Page the clip came from. Shown as text, never linked. */
  source: string;
}

export interface ReelManifest {
  clips: Clip[];
}

export function newsreelRoot(configured?: string): string {
  return configured ? path.resolve(configured) : defaultNewsreelDir;
}

export function contentTypeFor(file: string): string | null {
  return VIDEO_TYPES[path.extname(file).toLowerCase()] ?? null;
}

function readCredits(dir: string): Record<string, ClipCredit> {
  const file = path.join(dir, 'credits.json');
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, ClipCredit>;
  } catch {
    // A hand-edited or half-written credits file costs captions, not the reel.
    return {};
  }
}

/** Everything in the library that this server is willing to serve, in name order. */
export function listClips(root: string): Clip[] {
  if (!existsSync(root)) return [];

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  const credits = readCredits(root);
  const clips: Clip[] = [];

  for (const file of entries.sort()) {
    if (!CLIP_NAME.test(file) || contentTypeFor(file) === null) continue;
    if (resolveClip(file, root) === null) continue;

    const credit = credits[file] ?? {};
    clips.push({
      file,
      url: `/newsreel/${encodeURIComponent(file)}`,
      title: credit.title?.trim() || file,
      credit: credit.credit?.trim() ?? '',
      source: credit.source?.trim() ?? '',
    });
  }

  return clips;
}

/**
 * Maps a requested clip to a readable file, or null if it is not one.
 *
 * The containment check is on the *real* path, so a symlink planted in the library pointing
 * outside it is refused even though its own filename passes the charset test.
 */
export function resolveClip(file: string, root: string): string | null {
  if (!CLIP_NAME.test(file) || contentTypeFor(file) === null) return null;

  const target = path.join(root, file);

  try {
    if (!statSync(target).isFile()) return null;
    const real = realpathSync(target);
    const realRoot = realpathSync(root);
    if (!real.startsWith(realRoot + path.sep)) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * Unlike the poster banner, there is no configured hold time here: each clip already carries its
 * own natural duration, and the client advances to the next one on the video's own `ended` event.
 */
export function buildReelManifest(root: string): ReelManifest {
  return { clips: listClips(root) };
}
