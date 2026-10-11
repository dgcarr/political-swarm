import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

import { execFile } from 'node:child_process';
import { captureEnvironmentInfo } from './environmentInfo.js';

type ExecFileCb = (err: Error | null, stdout: string, stderr: string) => void;

function mockExecFile(responses: { args: string[]; stdout?: string; stderr?: string; error?: Error }[]): void {
  const calls = [...responses];
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _args: string[], cb: ExecFileCb) => {
      const match = calls.shift();
      if (!match) throw new Error('execFile called more times than mocked');
      if (match.error) cb(match.error, '', '');
      else cb(null, match.stdout ?? '', match.stderr ?? '');
    },
  );
}

describe('captureEnvironmentInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses python version and pip freeze into the right shape on success', async () => {
    mockExecFile([
      { args: ['--version'], stdout: 'Python 3.11.5\n' },
      { args: ['-m', 'pip', 'freeze'], stdout: 'pytest==7.4.0\npytest-cov==4.1.0\n\n' },
    ]);

    const info = await captureEnvironmentInfo('/fake/python');

    expect(info.pythonVersion).toBe('Python 3.11.5');
    expect(info.pipFreeze).toEqual(['pytest==7.4.0', 'pytest-cov==4.1.0']);
    expect(info.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('degrades gracefully with a placeholder when pip freeze fails', async () => {
    mockExecFile([
      { args: ['--version'], stdout: 'Python 3.11.5\n' },
      { args: ['-m', 'pip', 'freeze'], error: new Error('pip missing') },
    ]);

    const info = await captureEnvironmentInfo('/fake/python');

    expect(info.pythonVersion).toBe('Python 3.11.5');
    expect(info.pipFreeze).toEqual(['(unavailable: Error: pip missing)']);
  });

  it('degrades gracefully with a placeholder when python --version fails', async () => {
    mockExecFile([
      { args: ['--version'], error: new Error('enoent') },
      { args: ['-m', 'pip', 'freeze'], stdout: 'pytest==7.4.0\n' },
    ]);

    const info = await captureEnvironmentInfo('/nonexistent/python');

    expect(info.pythonVersion).toBe('(unavailable: Error: enoent)');
    expect(info.pipFreeze).toEqual(['pytest==7.4.0']);
  });

  it('populates platform fields from os/process directly', async () => {
    mockExecFile([
      { args: ['--version'], stdout: 'Python 3.11.5\n' },
      { args: ['-m', 'pip', 'freeze'], stdout: '' },
    ]);

    const info = await captureEnvironmentInfo('/fake/python');

    expect(info.platform).toEqual({
      os: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      release: os.release(),
    });
    expect(info.pipFreeze).toEqual([]);
  });
});
