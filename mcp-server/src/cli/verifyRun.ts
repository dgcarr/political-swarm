import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRun } from '../engine/verifyRun.js';

// node dist/cli/verifyRun.js <runId | run directory> [--runs-dir <dir>] [--json]
// Exit 0 when the run's record is consistent, 1 when it is not, 2 on usage errors.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.SWARM_PLUGIN_ROOT ?? path.resolve(__dirname, '../../..');

function main(argv: string[]): number {
  const json = argv.includes('--json');
  const runsDirIndex = argv.indexOf('--runs-dir');
  const positional = argv.filter((arg, index) => !arg.startsWith('--') && !(runsDirIndex >= 0 && index === runsDirIndex + 1));
  if (positional.length !== 1 || (runsDirIndex >= 0 && !argv[runsDirIndex + 1])) {
    console.error('usage: verify-run <runId | run directory> [--runs-dir <dir>] [--json]');
    return 2;
  }
  const target = positional[0];
  let runsRoot: string;
  let runId: string;
  if (target.includes(path.sep)) {
    runsRoot = path.dirname(path.resolve(target));
    runId = path.basename(path.resolve(target));
  } else {
    runsRoot = runsDirIndex >= 0 ? path.resolve(argv[runsDirIndex + 1]) : process.env.SWARM_RUNS_DIR ?? path.join(pluginRoot, 'runs');
    runId = target;
  }
  const report = verifyRun(runsRoot, runId);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`${report.ok ? 'VERIFIED' : 'FAILED'} ${report.runId}`);
    console.log(`  ledger: ${report.ledger.entries} entries, ${report.ledger.entries - report.ledger.unchainedPrefix} hash-chained`);
    console.log(`  constitution: ${report.constitution ? `${report.constitution.strategy} ${report.constitution.digest.slice(0, 12)}` : 'none recorded'}`);
    console.log(`  governance: ${report.governance.decisions} decisions, ${report.governance.mandates} mandates replayed from the ledger`);
    console.log(`  spend: $${report.spend.ledgerUsd.toFixed(4)} in metered calls of $${report.spend.stateUsd.toFixed(4)} recorded`);
    for (const problem of report.problems) console.log(`  problem: ${problem}`);
    for (const warning of report.warnings) console.log(`  warning: ${warning}`);
  }
  return report.ok ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
