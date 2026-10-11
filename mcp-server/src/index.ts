import path from 'node:path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { OpenRouterClient } from './engine/OpenRouterClient.js';
import { SwarmEngine } from './engine/SwarmEngine.js';
import { EventBus } from './engine/EventBus.js';
import { DashboardServer } from './dashboard/DashboardServer.js';
import { LlmRhetorician } from './dashboard/LlmRhetorician.js';
import { loadDashboardConfig } from './dashboard/config.js';
import { buildStrategies } from './strategies/registry.js';
import { loadBudgetConfig, loadModelsConfig, loadStrategiesConfig } from './util/config.js';
import { logger } from './util/logger.js';

import { swarmStart, swarmStartInputShape } from './tools/swarmStart.js';
import { swarmStatus, swarmStatusInputShape } from './tools/swarmStatus.js';
import { swarmGetDiff, swarmGetDiffInputShape } from './tools/swarmGetDiff.js';
import { swarmDecide, swarmDecideInputShape } from './tools/swarmDecide.js';
import { swarmApply, swarmApplyInputShape } from './tools/swarmApply.js';
import { swarmStop, swarmStopInputShape } from './tools/swarmStop.js';
import { swarmListRuns } from './tools/swarmListRuns.js';
import { swarmListModels } from './tools/swarmListModels.js';
import { swarmConfigureModels, swarmConfigureModelsInputShape } from './tools/swarmConfigureModels.js';
import { swarmDashboard, swarmDashboardInputShape } from './tools/swarmDashboard.js';
import { swarmGetDelivery, swarmGetDeliveryInputShape } from './tools/swarmGetDelivery.js';
import { swarmAccept, swarmAcceptInputShape } from './tools/swarmAccept.js';
import { swarmRemediate, swarmRemediateInputShape } from './tools/swarmRemediate.js';
import { swarmResume, swarmResumeInputShape } from './tools/swarmResume.js';
import { swarmVerifyRun, swarmVerifyRunInputShape } from './tools/swarmVerifyRun.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/index.js -> dist -> mcp-server -> plugin root
const pluginRoot = process.env.SWARM_PLUGIN_ROOT ?? path.resolve(__dirname, '../..');

// Belt-and-suspenders key loading: ${OPENROUTER_API_KEY} substitution in .mcp.json only works
// if the launching shell already has it set, which isn't guaranteed — also load the plugin's
// own .env directly so the key is available either way.
dotenv.config({ path: path.join(pluginRoot, '.env') });

const configDir = process.env.SWARM_CONFIG_DIR ?? path.join(pluginRoot, 'config');
const runsRootDir = process.env.SWARM_RUNS_DIR ?? path.join(pluginRoot, 'runs');
const defaultRepoPath = process.env.SWARM_DEFAULT_REPO_PATH;

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

type ToolHandler<Input, Output> = (input: Input) => Promise<Output>;

function adaptToolHandler<Input, Output>(handler: ToolHandler<Input, Output>) {
  return async (input: Input) => {
    try {
      return textResult(await handler(input));
    } catch (err) {
      return errorResult(err);
    }
  };
}

function buildDependencies() {
  const client = new OpenRouterClient(process.env.OPENROUTER_API_KEY ?? '');
  const modelsConfig = loadModelsConfig(configDir);
  const budgetConfig = loadBudgetConfig(configDir);
  const strategiesConfig = loadStrategiesConfig(configDir);

  const strategies = buildStrategies();

  const bus = new EventBus();
  const engine = new SwarmEngine({ client, modelsConfig, configDir, budgetConfig, strategiesConfig, runsRootDir, strategies, bus });

  return { client, modelsConfig, bus, engine };
}

type Dependencies = ReturnType<typeof buildDependencies>;

async function startDashboardIfEnabled({ client, modelsConfig, bus, engine }: Dependencies) {
  // Read-only observer on loopback. Failing to start is never fatal: start() resolves null and
  // logs rather than rejecting, so a busy port or a missing build cannot stop the MCP server.
  const dashboardConfig = loadDashboardConfig();
  const rhetorician =
    dashboardConfig.rhetoric === 'llm' ? new LlmRhetorician(client, modelsConfig) : undefined;
  const dashboard = new DashboardServer({
    runStore: engine.getRunStore(),
    runsRootDir,
    bus,
    config: dashboardConfig,
    rhetorician,
  });
  const dashboardUrl = await dashboard.start();

  return { dashboard, dashboardUrl };
}

function registerTools(server: McpServer, dependencies: Dependencies, dashboard: DashboardServer): void {
  const { client, modelsConfig, engine } = dependencies;
  server.registerTool(
    'swarm_start',
    { description: 'Start a governance-driven code swarm on a task.', inputSchema: swarmStartInputShape },
    adaptToolHandler((input) => swarmStart(engine, defaultRepoPath, input)),
  );

  server.registerTool(
    'swarm_status',
    { description: 'Check status, cost, and pending approvals for a swarm run.', inputSchema: swarmStatusInputShape },
    adaptToolHandler((input) => swarmStatus(engine, input)),
  );

  server.registerTool(
    'swarm_get_diff',
    { description: 'Get the diff a swarm run has produced so far (read-only).', inputSchema: swarmGetDiffInputShape },
    adaptToolHandler((input) => swarmGetDiff(engine, runsRootDir, input)),
  );

  server.registerTool(
    'swarm_decide',
    { description: 'Resolve a pending swarm approval (vote, spend, waiver, etc.).', inputSchema: swarmDecideInputShape },
    adaptToolHandler((input) => swarmDecide(engine, input)),
  );

  // The orchestrator boundary of section 5 in every doctrine: the swarm submits a delivery packet,
  // Claude checks it independently, and either accepts it or returns concrete defects to the SAME
  // swarm. Internal approval never binds Claude, and nothing reaches the real repository until
  // Claude's acceptance has been recorded.
  server.registerTool(
    'swarm_get_delivery',
    {
      description:
        "Get the swarm's final delivery packet — evidence, checks, findings and disclosed risks — for Claude's independent check.",
      inputSchema: swarmGetDeliveryInputShape,
    },
    adaptToolHandler((input) => swarmGetDelivery(engine, input)),
  );

  server.registerTool(
    'swarm_accept',
    {
      description:
        "Record Claude's acceptance of a delivery packet after independently checking it. Completes the run and unlocks swarm_apply.",
      inputSchema: swarmAcceptInputShape,
    },
    adaptToolHandler((input) => swarmAccept(engine, input)),
  );

  server.registerTool(
    'swarm_remediate',
    {
      description:
        'Reject a delivery packet and return concrete defects to the same swarm, which resumes under its own rules. Requires at least one finding.',
      inputSchema: swarmRemediateInputShape,
    },
    adaptToolHandler((input) => swarmRemediate(engine, input)),
  );

  server.registerTool(
    'swarm_apply',
    {
      description: 'Apply an approved swarm diff to the real working repo. The only tool that writes outside the isolated worktree.',
      inputSchema: swarmApplyInputShape,
    },
    adaptToolHandler((input) => swarmApply(engine, runsRootDir, input)),
  );

  server.registerTool(
    'swarm_stop',
    { description: 'Immediately halt a running swarm.', inputSchema: swarmStopInputShape },
    adaptToolHandler((input) => swarmStop(engine, input)),
  );

  server.registerTool(
    'swarm_resume',
    {
      description:
        'Continue an interrupted run (server restart, crash or signal) from its saved state, replaying governance from its ledger.',
      inputSchema: swarmResumeInputShape,
    },
    adaptToolHandler((input) => swarmResume(engine, input)),
  );

  server.registerTool(
    'swarm_verify_run',
    {
      description:
        "Audit a run's record offline: ledger hash chain, governance decisions replayed from the ledger against the run's state, and spend.",
      inputSchema: swarmVerifyRunInputShape,
    },
    adaptToolHandler((input) => swarmVerifyRun(runsRootDir, input)),
  );

  server.registerTool(
    'swarm_list_runs',
    { description: 'List all known swarm runs.', inputSchema: {} },
    adaptToolHandler(() => swarmListRuns(engine)),
  );

  server.registerTool(
    'swarm_list_models',
    { description: "Browse OpenRouter's model catalog and see the swarm's currently configured primary/fallback models.", inputSchema: {} },
    adaptToolHandler(() => swarmListModels(client, configDir, modelsConfig)),
  );

  server.registerTool(
    'swarm_configure_models',
    {
      description: 'Set the primary and fallback OpenRouter models used by every role in the swarm. Persists as the default for future runs.',
      inputSchema: swarmConfigureModelsInputShape,
    },
    adaptToolHandler((input) => swarmConfigureModels(client, configDir, input)),
  );

  server.registerTool(
    'swarm_dashboard',
    { description: 'Get the URL of the live swarm dashboard (read-only, loopback only).', inputSchema: swarmDashboardInputShape },
    adaptToolHandler(() => swarmDashboard(dashboard)),
  );
}

async function connectServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * A run whose server exits leaves state.json saying "running" with no loop behind it. On a signal,
 * hand each owned run back as interrupted, with its lease released, so swarm_resume can pick it up
 * at once instead of after the stale-lease timeout.
 */
function installShutdownHandlers(engine: SwarmEngine, dashboard: DashboardServer, server: McpServer): void {
  let shuttingDown = false;
  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // A stuck subprocess or socket must not keep a disconnected MCP server alive indefinitely.
    const deadline = setTimeout(() => process.exit(1), 5_000);
    deadline.unref();
    void engine
      .interruptOwnedRuns(`Engine shutdown: ${reason}`)
      .then((runs) => logger.info('Interrupted owned runs on shutdown', { reason, runIds: runs.map((run) => run.runId) }))
      .catch((error) => logger.error('Could not interrupt runs on shutdown', { reason, error: String(error) }))
      .then(() => Promise.allSettled([dashboard.stop(), server.close()]))
      .finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('SIGHUP', shutdown);
  process.stdin.once('end', () => shutdown('stdin EOF'));
  process.stdin.once('error', () => shutdown('stdin error'));
  server.server.onclose = () => shutdown('transport closed');
}

async function main(): Promise<void> {
  const dependencies = buildDependencies();
  const { dashboard, dashboardUrl } = await startDashboardIfEnabled(dependencies);
  const server = new McpServer({ name: 'political-swarm', version: '0.1.0' });

  registerTools(server, dependencies, dashboard);
  installShutdownHandlers(dependencies.engine, dashboard, server);
  await connectServer(server);

  logger.info('political-swarm MCP server connected', { configDir, runsRootDir, defaultRepoPath, dashboardUrl });
}

main().catch((err) => {
  logger.error('Fatal error starting MCP server', { error: String(err?.stack ?? err) });
  process.exit(1);
});
