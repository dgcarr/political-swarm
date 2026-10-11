import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RepoWorktree } from '../engine/RepoWorktree.js';
import { normalizeChecksConfig } from './config.js';
import { sandboxInvocation } from './sandbox.js';

const bwrapWorks =
  process.platform === 'linux' &&
  spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-net', 'true'], { stdio: 'ignore' }).status === 0;

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function worktree(): RepoWorktree {
  root = mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-'));
  const tree = new RepoWorktree(path.join(root, 'repo'), path.join(root, 'run'), 'run-sandbox');
  mkdirSync(tree.worktreePath, { recursive: true });
  return tree;
}

describe('check sandbox configuration', () => {
  it('runs a command as given when no sandbox is configured', () => {
    expect(sandboxInvocation('none', '/wt', 'npm', ['test'])).toEqual({ cmd: 'npm', cmdArgs: ['test'] });
    expect(normalizeChecksConfig(undefined).sandbox).toBe('none');
  });

  it('refuses a sandbox setting it does not recognise rather than running unconfined', () => {
    expect(() => normalizeChecksConfig({ sandbox: 'bubblewarp' } as never)).toThrow(/sandbox must be "none" or "bubblewrap"/);
  });
});

describe.skipIf(!bwrapWorks)('bubblewrap check sandbox', () => {
  it('lets a check write its own worktree', async () => {
    const tree = worktree();
    const result = await tree.runAllowListedCommand(process.execPath, ['-e', "require('fs').writeFileSync('out.txt', 'ok')"], 10_000, { sandbox: 'bubblewrap' });
    expect(result).toMatchObject({ ran: true, passed: true });
    expect(existsSync(path.join(tree.worktreePath, 'out.txt'))).toBe(true);
  });

  it('stops a check writing anywhere outside the worktree', async () => {
    const tree = worktree();
    // Outside /tmp: the sandbox's /tmp is private, so a write there never reaches the host anyway.
    const hostDir = mkdtempSync(path.join(process.cwd(), '.sandbox-escape-'));
    const outside = path.join(hostDir, 'escaped.txt');
    try {
      const result = await tree.runAllowListedCommand(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(outside)}, 'x')`], 10_000, { sandbox: 'bubblewrap' });
      expect(result.passed).toBe(false);
      expect(existsSync(outside)).toBe(false);
    } finally {
      rmSync(hostDir, { recursive: true, force: true });
    }
  });

  it('cuts a check off from the network, even a server on this machine', async () => {
    const tree = worktree();
    const server = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    const probe = `require('net').connect(${port}, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(3))`;
    try {
      const open = await tree.runAllowListedCommand(process.execPath, ['-e', probe], 10_000);
      const confined = await tree.runAllowListedCommand(process.execPath, ['-e', probe], 10_000, { sandbox: 'bubblewrap' });
      expect(open.passed).toBe(true);
      expect(confined).toMatchObject({ ran: true, passed: false });
    } finally {
      server.close();
    }
  });
});

describe('reviewCommands', () => {
  it('offers each check category when undeclared, and none when declared empty', () => {
    const [unit] = normalizeChecksConfig(undefined).reviewCommands;
    expect(unit).toMatchObject({ id: 'unit', command: 'npm', args: ['test', '--silent'] });
    expect(unit.description).toContain('"--"');
    expect(normalizeChecksConfig({ reviewCommands: [] } as never).reviewCommands).toEqual([]);
  });

  it('keeps a declared program and leading arguments', () => {
    const [command] = normalizeChecksConfig({
      reviewCommands: [{ id: 'cli', command: 'python', args: ['-m', 'pkg'] }],
    } as never).reviewCommands;
    expect(command).toMatchObject({ id: 'cli', command: 'python', args: ['-m', 'pkg'], timeoutMs: 60_000 });
    expect(command.description).toContain('python -m pkg');
  });

  it('refuses a review command with no id or program', () => {
    expect(() => normalizeChecksConfig({ reviewCommands: [{ id: 'cli' }] } as never)).toThrow(/needs an id and a command/);
  });
});
