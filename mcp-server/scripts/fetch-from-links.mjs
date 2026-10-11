// Downloads the posters listed in each tradition's `links.txt` into its directory, so the banner
// (which only ever serves files it finds on disk — see dashboard/banner.ts) has something real to
// show instead of the placeholder SVGs.
//
// `links.txt` is a plain list of image URLs, one per line, curated by hand (see
// assets/propaganda/imagelinks.txt for where they came from). This script does not search for
// anything; it just fetches what's listed, the same way fetch-propaganda.mjs fetches what Commons
// returns. A URL that 404s, redirects to an HTML page, or serves something over the size cap is
// skipped and logged, not fatal to the run.
//
// Usage:
//   node scripts/fetch-from-links.mjs                       # all three traditions
//   node scripts/fetch-from-links.mjs --strategy=socialist
//   node scripts/fetch-from-links.mjs --dry-run              # show what would be fetched
//   node scripts/fetch-from-links.mjs --clean                # drop downloads, keep links.txt + SVGs

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, '..', '..');
const DEFAULT_DIR = path.join(pluginRoot, 'assets', 'propaganda');

const STRATEGIES = ['socialist', 'democratic', 'capitalist'];

const USER_AGENT =
  'political-swarm-dashboard/0.1 (poster library for a local dashboard; https://github.com/dgcarr/political-swarm)';

/** Must match banner.ts's IMAGE_TYPES — anything else is served by nothing, so there's no point taking it. */
const EXT_FOR_MIME = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg', // non-standard, but some servers (canva) send it for real JPEGs
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
};

const MAX_BYTES = 4 * 1024 * 1024; // matches fetch-propaganda.mjs — a poster this big is a scan, not a banner image

/**
 * Every poster lands on the same canvas, matching `.banner-cell`'s `aspect-ratio: 3 / 4` in
 * styles.css exactly. Fetched posters arrive at wildly different sizes and shapes — a fixed
 * canvas is what makes them read as one series instead of a folder of mismatched downloads.
 *
 * `-resize WxH` (no `^` or `!`) fits the source inside the box without cropping — cropping a
 * poster through its own slogan defeats the point of it being a poster — and is allowed to
 * enlarge, since a tiny source is going to be upscaled by the browser regardless and a
 * letterboxed sliver of it looks worse than a soft fill. `-extent` then pads onto the banner's
 * own ground colour so the bars blend into the strip rather than reading as an obvious border.
 */
const POSTER_WIDTH = 900;
const POSTER_HEIGHT = 1200;
const POSTER_BACKGROUND = '#06070a'; // matches .banner's background in styles.css

/** Vector originals are left alone — resizing/padding a vector as if it were a bitmap makes no sense. */
async function normalize(filePath) {
  await execFileAsync('magick', [
    'mogrify',
    '-auto-orient',
    '-colorspace', 'sRGB',
    '-resize', `${POSTER_WIDTH}x${POSTER_HEIGHT}`,
    '-background', POSTER_BACKGROUND,
    '-gravity', 'center',
    '-extent', `${POSTER_WIDTH}x${POSTER_HEIGHT}`,
    '-quality', '88',
    '-strip',
    filePath,
  ]);
}

function parseArgs(argv) {
  const args = {
    dir: DEFAULT_DIR,
    strategies: STRATEGIES,
    workers: 4,
    dryRun: false,
    clean: false,
  };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'dir') args.dir = path.resolve(value);
    else if (key === 'strategy') args.strategies = value.split(',').filter((s) => STRATEGIES.includes(s));
    else if (key === 'workers') args.workers = Math.max(1, Math.min(8, Number(value) || 4));
    else if (key === 'dry-run') args.dryRun = true;
    else if (key === 'clean') args.clean = true;
    else if (key === 'help') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 16).join('\n'));
      process.exit(0);
    }
  }
  if (args.strategies.length === 0) {
    console.error(`No such tradition. Known: ${STRATEGIES.join(', ')}`);
    process.exit(1);
  }
  return args;
}

/**
 * Turns a URL into a filename that satisfies banner.ts's POSTER_NAME charset
 * (`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`).
 *
 * Built from the URL rather than the eventual bytes, so re-running the script against an
 * unchanged links.txt always lands on the same filename and `existsSync` can skip work already
 * done. The hash suffix is what keeps two different URLs from colliding when their last path
 * segment is generic (`images`, `s-l1200`, an encrypted thumbnail id).
 */
function slugFromUrl(url, ext) {
  let stem = 'poster';
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').split('.')[0];
    const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '')
      .replace(/\.[a-z0-9]+$/i, '');
    stem = [host, last].filter(Boolean).join('-');
  } catch {
    // Malformed URL — the hash alone still makes a valid, unique filename.
  }
  const cleaned = stem
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 8);
  const safe = /^[A-Za-z0-9]/.test(cleaned) ? cleaned : `poster-${cleaned}`;
  return `${safe || 'poster'}-${hash}${ext}`;
}

function readLinks(dir) {
  const file = path.join(dir, 'links.txt');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function loadCredits(dir) {
  const file = path.join(dir, 'credits.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** Merged, never overwritten: entries for posters this script didn't add have to survive a rerun. */
function saveCredits(dir, credits) {
  const sorted = Object.fromEntries(Object.entries(credits).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path.join(dir, 'credits.json'), `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

function cleanDownloads(dir) {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  const credits = loadCredits(dir);
  for (const file of readdirSync(dir)) {
    if (file === 'credits.json' || file === 'links.txt' || file.toLowerCase().endsWith('.svg')) continue;
    if (!statSync(path.join(dir, file)).isFile()) continue;
    rmSync(path.join(dir, file));
    delete credits[file];
    removed += 1;
  }
  saveCredits(dir, credits);
  return removed;
}

/** Runs `worker` over `items` with a fixed number in flight — independent fetches, worth overlapping. */
async function pool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

async function download(url, dir, seenUrls) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

  const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const ext = EXT_FOR_MIME[mime];
  if (!ext) throw new Error(`not a servable image (content-type: ${mime || 'unknown'})`);

  const body = Buffer.from(await res.arrayBuffer());
  if (body.byteLength === 0) throw new Error('empty response');
  if (body.byteLength > MAX_BYTES) throw new Error(`${(body.byteLength / 1e6).toFixed(1)} MB — too large`);

  const file = slugFromUrl(url, ext);
  if (seenUrls.has(file)) throw new Error('duplicate of an already-taken poster');
  const target = path.join(dir, file);
  writeFileSync(target, body);

  if (ext !== '.svg') {
    try {
      await normalize(target);
    } catch (err) {
      // ImageMagick missing, or a corrupt download it can't decode — the raw file is still a
      // usable poster (banner.ts serves any recognised extension), just not on the shared canvas.
      console.warn(`[normalize] ${file}: ${err.message}`);
    }
  }

  return { file, bytes: statSync(target).size };
}

async function fetchStrategy(strategy, args, started) {
  const dir = path.join(args.dir, strategy);
  mkdirSync(dir, { recursive: true });

  if (args.clean) {
    console.log(`[${strategy}] removed ${cleanDownloads(dir)} downloaded posters`);
    return;
  }

  const links = readLinks(dir);
  if (links.length === 0) {
    console.log(`[${strategy}] no links.txt (or it's empty) — nothing to fetch`);
    return;
  }

  const credits = loadCredits(dir);
  const existing = new Set(readdirSync(dir));

  if (args.dryRun) {
    for (const url of links) console.log(`[${strategy}] would fetch ${url}`);
    return;
  }

  let done = 0;
  let skipped = 0;
  let failed = 0;

  await pool(links, args.workers, async (url) => {
    try {
      const { file, bytes } = await download(url, dir, existing);
      existing.add(file);
      credits[file] = {
        title: slugFromUrl(url, '').replace(/-[0-9a-f]{8}$/, '').replace(/-/g, ' '),
        credit: 'Unknown — source unverified',
        source: new URL(url).hostname,
        sourceUrl: url,
      };
      done += 1;
      const elapsed = (Date.now() - started) / 1000;
      console.log(
        `[${strategy}] ${done + failed + skipped}/${links.length} fetched ${file} ` +
          `(${(bytes / 1024).toFixed(0)} kB, ${elapsed.toFixed(0)}s elapsed)`,
      );
    } catch (err) {
      if (err.message === 'duplicate of an already-taken poster') {
        skipped += 1;
      } else {
        failed += 1;
        console.warn(`[${strategy}] skipped ${url}: ${err.message}`);
      }
    }
  });

  saveCredits(dir, credits);
  console.log(`[${strategy}] done — ${done} taken, ${skipped} already had, ${failed} failed, into ${path.relative(pluginRoot, dir)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();

  console.log(
    args.clean
      ? `Clearing downloaded posters from ${path.relative(pluginRoot, args.dir)}`
      : `Fetching links.txt posters into ${path.relative(pluginRoot, args.dir)} (${args.workers} downloads in flight)`,
  );

  // One tradition after another: each tradition's own list is already fetched in parallel by the
  // pool above, and there's no shared host here worth serializing across.
  for (const strategy of args.strategies) {
    await fetchStrategy(strategy, args, started);
  }

  console.log(`All done in ${((Date.now() - started) / 1000).toFixed(0)}s.`);
  if (!args.clean && !args.dryRun) {
    console.log('Reload the dashboard — the banner picks up new posters on the next strategy change or refresh.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
