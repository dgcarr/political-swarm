import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Directory holding the dashboard's static assets.
 *
 * `public/` is a sibling of this module in both trees — src/dashboard/public when running
 * under vitest, dist/dashboard/public once built — so the same relative resolution works in
 * either, and follows the plugin wherever it is installed. Deliberately not derived from
 * process.cwd(): the MCP server is launched by the host with an arbitrary working directory.
 */
export const publicDir = path.join(moduleDir, 'public');

export function assetPath(...segments: string[]): string {
  return path.join(publicDir, ...segments);
}

/** True when the build step actually mirrored the assets. Cheap guard for a silent build regression. */
export function assetsPresent(): boolean {
  return existsSync(assetPath('index.html'));
}

/**
 * Default poster library: `<plugin root>/assets/propaganda/<strategy>/`.
 *
 * Deliberately outside `public/`, because this directory is written to at runtime by the fetcher
 * and by hand, while `public/` is build output that `copy-assets.mjs` overwrites. Three levels up
 * lands on the plugin root from either tree — src/dashboard/ and dist/dashboard/ sit at the same
 * depth under mcp-server/.
 */
export const defaultPropagandaDir = path.resolve(moduleDir, '..', '..', '..', 'assets', 'propaganda');

/** Default newsreel library: `<plugin root>/assets/newsreel/`. Same reasoning as the poster dir above. */
export const defaultNewsreelDir = path.resolve(moduleDir, '..', '..', '..', 'assets', 'newsreel');
