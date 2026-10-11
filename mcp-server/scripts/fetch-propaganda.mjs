// Fills the dashboard's poster library from Wikimedia Commons.
//
// Why Commons and not an image search: the dashboard serves posters from its own origin under a
// CSP of `img-src 'self'`, so they have to exist as files on disk, and the page must never make a
// request to a third party — the whole point of the loopback bind is that a run's record does not
// leave the machine. Commons is the one source that is fetchable by API, gives a stable direct
// URL per file, and states a licence per file that this script can check before downloading.
//
// Nothing here is required: the library ships with hand-drawn posters and works without ever
// running this. It exists so the banner can carry the real thing.
//
// Usage:
//   node scripts/fetch-propaganda.mjs                    # ~12 posters per tradition
//   node scripts/fetch-propaganda.mjs --count=30
//   node scripts/fetch-propaganda.mjs --strategy=socialist --count=40
//   node scripts/fetch-propaganda.mjs --dry-run          # list what it would take
//   node scripts/fetch-propaganda.mjs --clean            # drop downloads, keep the drawn posters
//   node scripts/fetch-propaganda.mjs --no-filter        # include slur-titled wartime posters
//
// What comes back is real historical propaganda: wartime posters, some of them violent, and some
// carrying the racial language of the states that printed them. Anything already on disk is
// yours to curate — deleting a file removes it from the banner, and nothing re-adds it.

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, '..', '..');
const DEFAULT_DIR = path.join(pluginRoot, 'assets', 'propaganda');

const API = 'https://commons.wikimedia.org/w/api.php';

// Commons asks every automated client to identify itself and to stay under one request at a time
// against the API. The download pool below is against upload.wikimedia.org, which is a CDN.
const USER_AGENT =
  'political-swarm-dashboard/0.1 (poster library for a local dashboard; https://github.com/dgcarr/political-swarm)';

/**
 * The searches, one set per tradition. Deliberately several per strategy and shallow rather than
 * one deep: a single query returns the same twenty files everyone else has seen, and the banner
 * wants variety more than it wants relevance rank.
 */
const QUERIES = {
  socialist: [
    'soviet propaganda poster',
    'communist propaganda poster',
    'socialist realism poster',
    'first five year plan poster',
    'may day poster ussr',
  ],
  democratic: [
    'american propaganda poster world war ii',
    'vote election poster',
    'democracy poster',
    'suffrage poster',
    'civil defense poster united states',
  ],
  capitalist: [
    'anti-communist propaganda poster',
    'cold war propaganda poster american',
    'war production poster industry',
    'advertising poster art deco',
    'world fair poster',
  ],
};

/**
 * Posters are printed portrait, and the banner's cells are portrait.
 *
 * Without this the searches return photographs *of* posters on walls, station signs and shop
 * fronts — all landscape, all letterboxed down to a sliver in a portrait cell. Shape turns out to
 * be a better filter for "is this a poster" than any wording of the query.
 */
const MIN_PORTRAIT_RATIO = 1.15;

/** Licences this script is willing to put on disk. Anything else is skipped, loudly. */
const ALLOWED_LICENCE = /^(public domain|pd|cc0|cc[ -]by([ -]sa)?)/i;

/**
 * Titles not pasted onto the banner by default.
 *
 * Wartime propaganda is a genuine part of what these searches return, and a good deal of it
 * carries racial slurs in the title Commons records. The poster's caption is rendered as UI text
 * on a dashboard, which is not the same context as an archive: this keeps a slur out of the
 * chrome of a running application. It is a default, not a policy — `--no-filter` takes everything
 * the licence check allows, for anyone using this to study the material rather than to decorate.
 */
const EXCLUDED_TITLE = /\b(jap|japs|nip|nips|kraut|krauts|chink|chinks|gook|gooks|wog|coon)\b/i;

const MAX_BYTES = 4 * 1024 * 1024; // a poster larger than this is a scan, not a banner image

function parseArgs(argv) {
  const args = {
    count: 12,
    // Three at a time. Six earns a 429 from Wikimedia's CDN on most of the batch; the downloads
    // are still overlapped, just within what the host will actually serve.
    workers: 3,
    dir: DEFAULT_DIR,
    strategies: Object.keys(QUERIES),
    dryRun: false,
    clean: false,
    filterTitles: true,
  };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'count') args.count = Math.max(1, Number(value) || 12);
    else if (key === 'workers') args.workers = Math.max(1, Math.min(12, Number(value) || 6));
    else if (key === 'dir') args.dir = path.resolve(value);
    else if (key === 'strategy') args.strategies = value.split(',').filter((s) => QUERIES[s]);
    else if (key === 'dry-run') args.dryRun = true;
    else if (key === 'clean') args.clean = true;
    else if (key === 'no-filter') args.filterTitles = false;
    else if (key === 'help') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 20).join('\n'));
      process.exit(0);
    }
  }
  if (args.strategies.length === 0) {
    console.error(`No such tradition. Known: ${Object.keys(QUERIES).join(', ')}`);
    process.exit(1);
  }
  return args;
}

/** Strips the HTML Commons puts in extmetadata fields (artist is a full <a> element). */
function plainText(html) {
  return String(html ?? '')
    // Commons repeats an unknown author inside a hidden span, for its own templates. Dropping
    // the element rather than just its tags is what stops "Unknown authorUnknown author".
    .replace(/<span[^>]*display:\s*none[^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Commons title to a filename the dashboard will serve.
 *
 * Must land inside `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` — banner.ts refuses anything else, so a
 * name that escapes this is a file that silently never appears on the page.
 */
function slugify(title, ext) {
  const stem = title
    .replace(/^File:/, '')
    .replace(/\.[a-z0-9]+$/i, '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
    .toLowerCase();
  const safe = /^[A-Za-z0-9]/.test(stem) ? stem : `poster-${stem}`;
  return `${safe || 'poster'}${ext}`;
}

async function apiSearch(query, limit) {
  const url = new URL(API);
  url.search = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    // filetype:bitmap keeps out PDFs, DjVu scans and video, all of which a poster search returns.
    gsrsearch: `filetype:bitmap ${query}`,
    gsrnamespace: '6',
    gsrlimit: String(limit),
    prop: 'imageinfo',
    iiprop: 'url|mime|size|extmetadata',
    // The banner shows these a few hundred pixels wide, and a wall of nine is decoded at once.
    // Commons will scale on its side for free, so there is nothing to gain from the full scan.
    iiurlwidth: '900',
  }).toString();

  const res = await fetchPolitely(url);
  if (!res.ok) throw new Error(`Commons search failed: ${res.status} ${res.statusText}`);
  const body = await res.json();
  return body?.query?.pages ?? [];
}

/** One page of search results reduced to the posters worth downloading. */
function candidatesFrom(pages, { filterTitles = true } = {}) {
  const found = [];
  for (const page of pages) {
    const info = page?.imageinfo?.[0];
    if (!info) continue;
    if (!/^image\/(jpeg|png|webp)$/.test(info.mime ?? '')) continue;

    if (!(info.height > 0 && info.width > 0 && info.height / info.width >= MIN_PORTRAIT_RATIO)) continue;

    const meta = info.extmetadata ?? {};
    const licence = plainText(meta.LicenseShortName?.value) || 'unknown';
    if (!ALLOWED_LICENCE.test(licence)) continue;

    // thumburl is the scaled copy; url is the full-size original, which for a poster scan can be
    // 30 MB. Prefer the thumb, and fall back only when Commons declined to scale it.
    const source = info.thumburl ?? info.url;
    if (!source) continue;

    const title = plainText(page.title).replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '');
    if (filterTitles && EXCLUDED_TITLE.test(title)) continue;

    const ext = /\.png(\?|$)/i.test(source) ? '.png' : /\.webp(\?|$)/i.test(source) ? '.webp' : '.jpg';
    found.push({
      title,
      file: slugify(page.title, ext),
      url: source,
      credit: plainText(meta.Artist?.value) || 'Unknown author',
      licence,
      descriptionUrl: info.descriptionurl ?? '',
    });
  }
  return found;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetches, backing off when Wikimedia says to slow down.
 *
 * Their CDN answers 429 well below what a naive pool will offer it, and a 429 is a request to
 * wait rather than a failure — treating it as one silently drops half the library. Retry-After is
 * honoured when sent, and the delay doubles otherwise.
 */
async function fetchPolitely(url, attempts = 4) {
  let wait = 1200;
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (res.status !== 429 || attempt >= attempts) return res;
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : wait);
    wait *= 2;
  }
}

async function download(candidate, dir) {
  const res = await fetchPolitely(candidate.url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.byteLength === 0) throw new Error('empty response');
  if (body.byteLength > MAX_BYTES) throw new Error(`${(body.byteLength / 1e6).toFixed(1)} MB — too large`);
  writeFileSync(path.join(dir, candidate.file), body);
  return body.byteLength;
}

/**
 * Runs `worker` over `items` with a fixed number in flight.
 *
 * These are independent network fetches against a CDN, so they are worth overlapping — a serial
 * loop over 36 posters spends almost all of its time waiting. Capped rather than unbounded so
 * this stays a polite client.
 */
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

function loadCredits(dir) {
  const file = path.join(dir, 'credits.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** Merged, never overwritten: the drawn posters' entries have to survive every fetch. */
function saveCredits(dir, credits) {
  const sorted = Object.fromEntries(Object.entries(credits).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path.join(dir, 'credits.json'), `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

function cleanDownloads(dir) {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  const credits = loadCredits(dir);
  for (const file of readdirSync(dir)) {
    // The drawn posters are the SVGs; everything else in here was downloaded.
    if (file === 'credits.json' || file.toLowerCase().endsWith('.svg')) continue;
    if (!statSync(path.join(dir, file)).isFile()) continue;
    rmSync(path.join(dir, file));
    delete credits[file];
    removed += 1;
  }
  saveCredits(dir, credits);
  return removed;
}

async function fetchStrategy(strategy, args, started) {
  const dir = path.join(args.dir, strategy);
  mkdirSync(dir, { recursive: true });

  if (args.clean) {
    console.log(`[${strategy}] removed ${cleanDownloads(dir)} downloaded posters`);
    return;
  }

  // Spread the wanted count across the queries, then dedupe: the searches overlap by design.
  const perQuery = Math.max(4, Math.ceil((args.count * 2) / QUERIES[strategy].length));
  const seen = new Set(readdirSync(dir));
  const candidates = [];

  for (const query of QUERIES[strategy]) {
    let pages;
    try {
      pages = await apiSearch(query, perQuery);
    } catch (err) {
      console.warn(`[${strategy}] search "${query}" failed: ${err.message}`);
      continue;
    }
    for (const candidate of candidatesFrom(pages, { filterTitles: args.filterTitles })) {
      if (seen.has(candidate.file)) continue;
      seen.add(candidate.file);
      candidates.push(candidate);
    }
    console.log(`[${strategy}] "${query}" → ${candidates.length} candidates so far`);
    if (candidates.length >= args.count) break;
  }

  const wanted = candidates.slice(0, args.count);
  if (wanted.length === 0) {
    console.log(`[${strategy}] nothing new to take`);
    return;
  }

  if (args.dryRun) {
    for (const candidate of wanted) console.log(`[${strategy}] would take ${candidate.file}  (${candidate.licence})`);
    return;
  }

  const credits = loadCredits(dir);
  let done = 0;
  let failed = 0;

  await pool(wanted, args.workers, async (candidate) => {
    try {
      const bytes = await download(candidate, dir);
      credits[candidate.file] = {
        title: candidate.title,
        credit: `${candidate.credit} — ${candidate.licence}`,
        // A short label, because this is shown in a one-line caption strip. The page never
        // renders sourceUrl; it is kept so the provenance of every file stays recoverable.
        source: 'Wikimedia Commons',
        sourceUrl: candidate.descriptionUrl,
      };
      done += 1;
      const elapsed = (Date.now() - started) / 1000;
      const rate = done / Math.max(elapsed, 0.001);
      const remaining = wanted.length - done;
      console.log(
        `[${strategy}] ${done}/${wanted.length} ${candidate.file} ` +
          `(${(bytes / 1024).toFixed(0)} kB, ${elapsed.toFixed(0)}s elapsed, ~${(remaining / Math.max(rate, 0.001)).toFixed(0)}s left)`,
      );
    } catch (err) {
      failed += 1;
      console.warn(`[${strategy}] skipped ${candidate.file}: ${err.message}`);
    }
  });

  saveCredits(dir, credits);
  console.log(`[${strategy}] done — ${done} taken, ${failed} skipped, into ${path.relative(pluginRoot, dir)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();

  console.log(
    args.clean
      ? `Clearing downloaded posters from ${path.relative(pluginRoot, args.dir)}`
      : `Fetching up to ${args.count} posters per tradition into ${path.relative(pluginRoot, args.dir)} ` +
          `(${args.workers} downloads in flight)`,
  );

  // Strategies run one after another: the searches share one API host, and the per-strategy
  // download pool is already where the parallelism that matters lives.
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
