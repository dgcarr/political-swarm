import { spawnSync } from 'node:child_process';

// Checks run code the model wrote: its tests, and any package.json script it edited. The scrubbed
// environment keeps the API key out of reach, but the code still runs as the user, with the
// network and the user's files. `sandbox: bubblewrap` in config/checks.yaml takes both away:
// no network, the whole filesystem read-only except the worktree, and a private /tmp.

export type CheckSandbox = 'none' | 'bubblewrap';

let bwrapAvailable: boolean | undefined;

function hasBubblewrap(): boolean {
  if (bwrapAvailable === undefined) {
    const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-net', 'true'], { stdio: 'ignore', timeout: 5_000 });
    bwrapAvailable = probe.status === 0;
  }
  return bwrapAvailable;
}

export type SandboxedInvocation = { cmd: string; cmdArgs: string[] } | { unavailable: string };

/** The command line that runs `command` confined to `worktreePath`, or why it cannot be confined. */
export function sandboxInvocation(
  sandbox: CheckSandbox,
  worktreePath: string,
  command: string,
  args: string[],
): SandboxedInvocation {
  if (sandbox === 'none') return { cmd: command, cmdArgs: args };
  if (process.platform !== 'linux' || !hasBubblewrap()) {
    return {
      unavailable:
        'config/checks.yaml requires sandbox: bubblewrap, but bwrap is not installed or cannot create a sandbox here; ' +
        'the check was not run unconfined.',
    };
  }
  return {
    cmd: 'bwrap',
    cmdArgs: [
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
      '--bind', worktreePath, worktreePath,
      '--unshare-net',
      '--unshare-pid',
      '--die-with-parent',
      '--new-session',
      // Tools that keep a cache under $HOME (npm, pip) would otherwise fail on a read-only home.
      '--setenv', 'npm_config_cache', '/tmp/.npm',
      '--setenv', 'PIP_CACHE_DIR', '/tmp/.pip',
      '--setenv', 'XDG_CACHE_HOME', '/tmp/.cache',
      '--chdir', worktreePath,
      '--',
      command,
      ...args,
    ],
  };
}

/** For tests: forget the probe result. */
export function resetSandboxProbe(): void {
  bwrapAvailable = undefined;
}
