import { execFile } from 'node:child_process';
import * as os from 'node:os';

export interface EnvironmentInfo {
  capturedAt: string;
  pythonVersion: string;
  pipFreeze: string[];
  platform: { os: string; arch: string; nodeVersion: string; release: string };
}

const UNAVAILABLE_PREFIX = '(unavailable: ';

function unavailable(err: unknown): string {
  return `${UNAVAILABLE_PREFIX}${String(err)})`;
}

function runPython(pythonPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(pythonPath, args, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

/**
 * Captures the Python environment (version + installed packages) and the host platform info
 * a benchmark ran under. Never throws: if a python subprocess fails, the corresponding field
 * degrades to a placeholder describing the failure, so environment capture can never crash an
 * otherwise-successful benchmark run.
 */
export async function captureEnvironmentInfo(pythonPath: string): Promise<EnvironmentInfo> {
  let pythonVersion = '';
  let pipFreeze: string[] = [];

  try {
    const { stdout, stderr } = await runPython(pythonPath, ['--version']);
    // python3 --version prints to stdout on 3.4+, but some builds print to stderr.
    pythonVersion = (stdout || stderr).trim();
  } catch (err) {
    pythonVersion = unavailable(err);
  }

  try {
    const { stdout } = await runPython(pythonPath, ['-m', 'pip', 'freeze']);
    pipFreeze = stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  } catch (err) {
    pipFreeze = [unavailable(err)];
  }

  return {
    capturedAt: new Date().toISOString(),
    pythonVersion,
    pipFreeze,
    platform: {
      os: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      release: os.release(),
    },
  };
}
