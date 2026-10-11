// M2 smoke test: spawns the built MCP server as a real child process and drives it through
// swarm_start -> swarm_status -> swarm_get_diff -> swarm_apply against a scratch repo, using
// the actual MCP client/stdio transport (not a direct import) so this exercises exactly what
// Claude Code will exercise when the plugin is enabled. Run with: npm run smoke:mcp
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { log as createLog, reportChecks, setUpScratchRepo } from './harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '../../..');
const serverEntry = path.join(pluginRoot, 'mcp-server', 'dist', 'index.js');
const scratchRepoRoot = path.join(os.tmpdir(), 'swarm-mcp-smoke-repo');
// A fresh directory per invocation, not a reused/deleted one: on Windows, force-removing a
// prior run's directory can hit EPERM from lingering file handles on git worktree metadata.
const smokeRunsDir = path.join(pluginRoot, 'runs', `mcp-smoke-${Date.now()}`);
// Raised for the acceptance barriers: after the task loop the run still has an integration report,
// an independent verification and a finding-disposition sitting to get through, each a model call.
const RUN_TIMEOUT_MS = 180_000;
const STATUS_POLL_INTERVAL_MS = 300;
const RUN_BUDGET_USD = 0.3;

const log = createLog('mcp-smoke');

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

function parseToolText<T>(result: ToolResult): T {
  const text = result.content.find((c) => c.type === 'text')?.text ?? '';
  if (result.isError) throw new Error(`Tool call failed: ${text}`);
  return JSON.parse(text) as T;
}

async function main(): Promise<void> {
  setUpScratchRepo({
    repoPath: scratchRepoRoot,
    readme: '# scratch repo\n',
    packageJson: { name: 'mcp-smoke-scratch', version: '1.0.0', private: true, scripts: { test: 'node test.js' } },
    testFile: "console.log('no tests yet');\n",
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      ...(process.env as Record<string, string>),
      SWARM_PLUGIN_ROOT: pluginRoot,
      SWARM_CONFIG_DIR: path.join(pluginRoot, 'config'),
      SWARM_RUNS_DIR: smokeRunsDir,
      SWARM_DEFAULT_REPO_PATH: scratchRepoRoot,
    },
  });

  const client = new Client({ name: 'political-swarm-smoke-client', version: '0.1.0' });
  await client.connect(transport);
  log('Connected to MCP server.');

  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name).sort();
  log(`Tools registered: ${toolNames.join(', ')}`);
  const expected = [
    'swarm_apply',
    'swarm_configure_models',
    'swarm_dashboard',
    'swarm_decide',
    'swarm_get_diff',
    'swarm_list_models',
    'swarm_list_runs',
    'swarm_start',
    'swarm_status',
    'swarm_stop',
    'swarm_get_delivery',
    'swarm_accept',
    'swarm_remediate',
  ];
  const missing = expected.filter((t) => !toolNames.includes(t));

  const startResult = parseToolText<{ runId: string; worktreePath: string; status: string }>(
    await client.callTool({
      name: 'swarm_start',
      arguments: {
        task: 'Add an isEven function with a unit test',
        strategy: 'capitalist',
        acceptanceCriteria: ['isEven(n) returns true for even numbers and false for odd numbers', 'a test file exercises isEven'],
        budgetUsd: RUN_BUDGET_USD,
      },
    }) as ToolResult,
  );
  log(`swarm_start -> runId=${startResult.runId} status=${startResult.status}`);

  let status: { status: string; pendingApprovals: unknown[] } = { status: 'running', pendingApprovals: [] };
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    status = parseToolText(
      await client.callTool({ name: 'swarm_status', arguments: { runId: startResult.runId } }) as ToolResult,
    );
    if (status.status !== 'running') break;
    await new Promise((r) => setTimeout(r, STATUS_POLL_INTERVAL_MS));
  }
  log(`Run reached status: ${status.status}`);

  const diff = parseToolText<{ diffText: string; filesChanged: string[] }>(
    await client.callTool({ name: 'swarm_get_diff', arguments: { runId: startResult.runId } }) as ToolResult,
  );
  log(`swarm_get_diff -> ${diff.filesChanged.length} file(s) changed: ${diff.filesChanged.join(', ')}`);

  // The swarm reaching its own acceptance decision leaves the run at awaiting_acceptance. Applying
  // requires Claude's independent check first, so the tool sequence here is get_delivery ->
  // accept -> apply, and apply is expected to REFUSE before that.
  let deliveryOk = false;
  let applyRefusedBeforeAcceptance = false;
  let applyOk = false;
  let applyError = '';

  if (status.status === 'awaiting_acceptance') {
    const delivery = parseToolText<{ delivery?: { requirementMatrix: unknown[]; findings: unknown[] } }>(
      (await client.callTool({
        name: 'swarm_get_delivery',
        arguments: { runId: startResult.runId, includeDiff: false },
      })) as ToolResult,
    );
    deliveryOk = delivery.delivery !== undefined;
    log(`swarm_get_delivery -> ${delivery.delivery?.requirementMatrix.length ?? 0} criteria traced`);

    const prematureApply = (await client.callTool({
      name: 'swarm_apply',
      arguments: { runId: startResult.runId },
    })) as ToolResult;
    applyRefusedBeforeAcceptance = prematureApply.isError === true;

    await client.callTool({
      name: 'swarm_accept',
      arguments: { runId: startResult.runId, note: 'mcp smoke: boundary exercised' },
    });

    const applyRaw = (await client.callTool({ name: 'swarm_apply', arguments: { runId: startResult.runId } })) as ToolResult;
    if (applyRaw.isError) {
      applyError = applyRaw.content[0]?.text ?? 'unknown error';
    } else {
      const applied = parseToolText<{ applied: boolean; commitSha: string }>(applyRaw);
      applyOk = applied.applied && !!applied.commitSha;
      log(`swarm_apply -> commitSha=${applied.commitSha}`);
    }
  }

  const listRuns = parseToolText<{ runs: { runId: string }[] }>(
    await client.callTool({ name: 'swarm_list_runs', arguments: {} }) as ToolResult,
  );

  const realRepoHasChanges = diff.filesChanged.some((f) => existsSync(path.join(scratchRepoRoot, f)));

  const checks: [string, boolean][] = [
    ['all 13 tools registered', missing.length === 0],
    ['swarm_start returned a runId', !!startResult.runId],
    ['run reached awaiting_acceptance status', status.status === 'awaiting_acceptance'],
    ['diff shows at least one changed file', diff.filesChanged.length > 0],
    ['swarm_get_delivery returned a delivery packet', deliveryOk],
    ['swarm_apply refused before Claude accepted the delivery', applyRefusedBeforeAcceptance],
    ['swarm_apply succeeded after acceptance', applyOk],
    ['at least one changed file now exists in the REAL repo after apply', realRepoHasChanges],
    ['swarm_list_runs includes this run', listRuns.runs.some((r) => r.runId === startResult.runId)],
  ];

  const ok = reportChecks('mcp-smoke', checks);
  if (missing.length > 0) log(`Missing tools: ${missing.join(', ')}`);
  if (applyError) log(`swarm_apply error: ${applyError}`);

  await client.close();
  if (!ok) {
    process.exitCode = 1;
    return;
  }
  log('All checks passed.');
}

main().catch((err) => {
  process.stderr.write(`[mcp-smoke] FATAL: ${String(err?.stack ?? err)}\n`);
  process.exitCode = 1;
});
