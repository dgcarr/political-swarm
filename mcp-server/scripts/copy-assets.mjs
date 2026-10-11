// tsc only emits .js for .ts inputs — it will not copy the dashboard's static assets.
// This mirrors src/**/public/ into dist/ so `import.meta.url`-relative lookups resolve
// identically whether the code runs from src (vitest) or dist (the installed plugin).
import { cpSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(scriptDir, '..');
const srcRoot = path.join(serverRoot, 'src');
const distRoot = path.join(serverRoot, 'dist');

// Directories mirrored verbatim, relative to src/.
const ASSET_DIRS = ['dashboard/public'];

let copied = 0;

for (const rel of ASSET_DIRS) {
  const from = path.join(srcRoot, rel);
  const to = path.join(distRoot, rel);

  if (!existsSync(from)) {
    console.error(`copy-assets: missing source directory ${path.relative(serverRoot, from)}`);
    process.exitCode = 1;
    continue;
  }

  cpSync(from, to, { recursive: true });
  copied += readdirSync(to).length;
  console.log(`copy-assets: ${rel} -> dist/${rel}`);
}

if (copied === 0) {
  console.error('copy-assets: no asset files were copied');
  process.exitCode = 1;
}
