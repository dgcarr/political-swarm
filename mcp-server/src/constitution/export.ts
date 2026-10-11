// Prints the machine-readable constitution of each strategy under the checked-in
// config/strategies.yaml, and regenerates docs/constitutions/<strategy>.json.
//
//   node dist/constitution/export.js                  every strategy, as one JSON object
//   node dist/constitution/export.js democratic       one strategy's constitution
//   node dist/constitution/export.js --out-dir <dir>  write <dir>/<strategy>.json for each
//
// constitution/export.test.ts fails when the checked-in files no longer match this output.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStrategiesConfig, type StrategiesConfig } from '../util/config.js';
import { CONFIGURED_STRATEGIES, constitutionDocument } from './articles.js';
import type { ConfiguredStrategyId } from './schema.js';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'); // constitution -> dist|src -> mcp-server -> root
export const DEFAULT_CONFIG_DIR = path.join(pluginRoot, 'config');
export const CONSTITUTIONS_DIR = path.join(pluginRoot, 'docs', 'constitutions');

/** One strategy's constitution exactly as the checked-in file holds it. */
export function renderConstitution(strategyId: ConfiguredStrategyId, strategiesConfig: StrategiesConfig): string {
  return `${JSON.stringify(constitutionDocument(strategyId, strategiesConfig[strategyId]), null, 2)}\n`;
}

function main(argv: readonly string[]): void {
  const outIndex = argv.indexOf('--out-dir');
  const outDir = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  if (outIndex >= 0 && !outDir) throw new Error('--out-dir needs a directory.');
  const requested = outIndex >= 0 ? argv.filter((_, index) => index !== outIndex && index !== outIndex + 1) : [...argv];
  for (const id of requested) {
    if (!(CONFIGURED_STRATEGIES as readonly string[]).includes(id)) {
      throw new Error(`Unknown strategy "${id}". Expected one of: ${CONFIGURED_STRATEGIES.join(', ')}.`);
    }
  }
  const strategies = (requested.length ? requested : CONFIGURED_STRATEGIES) as ConfiguredStrategyId[];
  const config = loadStrategiesConfig(process.env.SWARM_CONFIG_DIR ?? DEFAULT_CONFIG_DIR);

  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    for (const id of strategies) writeFileSync(path.join(outDir, `${id}.json`), renderConstitution(id, config), 'utf8');
    return;
  }
  if (strategies.length === 1) {
    process.stdout.write(renderConstitution(strategies[0], config));
    return;
  }
  const all = Object.fromEntries(strategies.map((id) => [id, constitutionDocument(id, config[id])]));
  process.stdout.write(`${JSON.stringify(all, null, 2)}\n`);
}

const entryPath = process.argv[1];
if (entryPath && path.resolve(entryPath) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[constitution] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
