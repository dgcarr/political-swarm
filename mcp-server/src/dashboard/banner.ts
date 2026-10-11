// The propaganda banner: a rotating frieze of posters, in the idiom of whichever tradition is
// governing the run on screen.
//
// This module owns two things and nothing else: what counts as a poster, and how a request path
// maps back to a file on disk. Both are security boundaries. The library directory is written to
// by a fetch script and by hand — so it is untrusted input to this server in the same way a run's
// ledger is — and it sits outside `public/`, so it cannot ride on the flat `/assets/` route's
// regex. Everything the HTTP layer needs to refuse a bad request is decided here.

import path from 'node:path';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { defaultPropagandaDir } from './paths.js';

/** The traditions with a poster tradition. `noop` has no propaganda, which is the joke. */
export const BANNER_STRATEGIES = ['socialist', 'democratic', 'capitalist'] as const;

export type BannerStrategy = (typeof BANNER_STRATEGIES)[number];

/**
 * Extensions served from the poster library, and the type each is served as.
 *
 * SVG is included because the bundled posters are drawn as SVG. It is safe here and only here:
 * the page loads posters through `<img>`, which does not execute script in an SVG document, and a
 * response served from this route still carries the dashboard's CSP and `nosniff`, so a poster
 * opened directly in a tab cannot run inline script either.
 */
const IMAGE_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

/**
 * Filenames the route will consider at all.
 *
 * No path separators, no leading dot, and nothing that could be a traversal segment. This runs
 * before any filesystem access; `resolvePoster` then re-checks the resolved path, because a
 * charset test alone is not a containment proof once symlinks exist.
 */
const POSTER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Provenance for one poster, as recorded in a library directory's `credits.json`. */
export interface PosterCredit {
  title?: string;
  credit?: string;
  source?: string;
}

export interface Poster {
  /** Filename within the strategy's directory. */
  file: string;
  /** Path the page loads it from. */
  url: string;
  title: string;
  credit: string;
  /** Page the image came from, when it came from somewhere. Shown as text, never linked. */
  source: string;
}

export interface BannerManifest {
  strategy: BannerStrategy;
  intervalMs: number;
  posters: Poster[];
}

export function isBannerStrategy(value: string): value is BannerStrategy {
  return (BANNER_STRATEGIES as readonly string[]).includes(value);
}

export function bannerRoot(configured?: string): string {
  return configured ? path.resolve(configured) : defaultPropagandaDir;
}

export function contentTypeFor(file: string): string | null {
  return IMAGE_TYPES[path.extname(file).toLowerCase()] ?? null;
}

/**
 * Turns a filename into the title shown under the poster.
 *
 * Only a fallback: anything fetched from Commons arrives with a real title in `credits.json`.
 * This is for the posters a user simply dropped into the directory, where the filename is the
 * only description that exists.
 */
export function titleFromFilename(file: string): string {
  const stem = file.slice(0, file.length - path.extname(file).length);
  const words = stem
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (words.length === 0) return file;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Reads a library directory's `credits.json`, tolerating its absence or a broken write. */
function readCredits(dir: string): Record<string, PosterCredit> {
  const file = path.join(dir, 'credits.json');
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, PosterCredit>;
  } catch {
    // A hand-edited or half-written credits file costs captions, not the banner.
    return {};
  }
}

/** Everything in one tradition's directory that this server is willing to serve, in name order. */
export function listPosters(strategy: BannerStrategy, root: string): Poster[] {
  const dir = path.join(root, strategy);
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const credits = readCredits(dir);
  const posters: Poster[] = [];

  for (const file of entries.sort()) {
    if (!POSTER_NAME.test(file) || contentTypeFor(file) === null) continue;
    // Skips directories, and anything a symlink points at outside the library.
    if (resolvePoster(strategy, file, root) === null) continue;

    const credit = credits[file] ?? {};
    posters.push({
      file,
      url: `/banner/${strategy}/${encodeURIComponent(file)}`,
      title: credit.title?.trim() || titleFromFilename(file),
      credit: credit.credit?.trim() ?? '',
      source: credit.source?.trim() ?? '',
    });
  }

  return posters;
}

/**
 * Maps a requested poster to a readable file, or null if it is not one.
 *
 * The containment check is on the *real* path, so a symlink planted in the library pointing at
 * `~/.ssh/id_rsa` is refused even though its own filename passes the charset test.
 */
export function resolvePoster(strategy: string, file: string, root: string): string | null {
  if (!isBannerStrategy(strategy) || !POSTER_NAME.test(file) || contentTypeFor(file) === null) return null;

  const dir = path.join(root, strategy);
  const target = path.join(dir, file);

  try {
    if (!statSync(target).isFile()) return null;
    // A charset test proves nothing about where a symlink points, so compare real paths.
    const real = realpathSync(target);
    const realDir = realpathSync(dir);
    if (!real.startsWith(realDir + path.sep)) return null;
    return real;
  } catch {
    return null;
  }
}

export function buildManifest(strategy: BannerStrategy, root: string, intervalMs: number): BannerManifest {
  return { strategy, intervalMs, posters: listPosters(strategy, root) };
}
