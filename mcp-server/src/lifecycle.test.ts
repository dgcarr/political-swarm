import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const serverRoot = fileURLToPath(new URL('..', import.meta.url));

it.each(['EOF', 'SIGTERM'] as const)('closes the dashboard and exits on %s', async (reason) => {
  const runs = mkdtempSync(path.join(os.tmpdir(), 'swarm-lifecycle-'));
  const reservation = net.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      OPENROUTER_API_KEY: 'test-no-network',
      SWARM_PLUGIN_ROOT: path.dirname(serverRoot),
      SWARM_CONFIG_DIR: path.join(serverRoot, '../config'),
      SWARM_RUNS_DIR: runs,
      SWARM_DASHBOARD: 'true',
      SWARM_DASHBOARD_PORT: String(port),
      SWARM_DASHBOARD_OPEN: 'false',
      SWARM_DASHBOARD_RHETORIC: 'template',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.resume();
  const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));
  try {
    await expect.poll(() => stderr, { timeout: 5_000 }).toContain('MCP server connected');
    expect((await fetch(`http://127.0.0.1:${port}/api/runs`)).status).toBe(200);
    if (reason === 'EOF') child.stdin.end();
    else child.kill(reason);
    await expect.poll(() => child.exitCode, { timeout: 3_000 }).toBe(0);
    await expect(fetch(`http://127.0.0.1:${port}/api/runs`)).rejects.toThrow();
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exit;
    rmSync(runs, { recursive: true, force: true });
  }
}, 10_000);
