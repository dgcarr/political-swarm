// The environment handed to every process the engine starts inside a worktree.
//
// Checks execute model-written code (a test file the implementer authored is a program), and git can
// run repository-controlled code too. Inheriting process.env would hand that code the server's
// OPENROUTER_API_KEY and whatever else the user exported. So the child gets an allow-list — only
// what locating tools, a home directory, a locale and a temp dir needs — and nothing on that list
// survives if its name looks like a credential.

/** Variables a check or git needs to find its tools and behave normally. Windows entries are what
 * npm/cmd.exe need to start at all; they are simply absent elsewhere. */
const ALLOWED_NAMES = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TERM',
  // A check command such as `python -m pytest` resolves through an activated venv.
  'VIRTUAL_ENV',
  // Windows: cmd.exe, PATHEXT lookup and npm's per-user directories.
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'WINDIR',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
]);

/** Git identity, for the engine's own commits when the user sets it in the environment rather than config. */
const GIT_IDENTITY_NAMES = new Set(['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']);

const CREDENTIAL_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

function scrubbed(source: NodeJS.ProcessEnv, allowed: (name: string) => boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || CREDENTIAL_NAME.test(name) || !allowed(name)) continue;
    env[name] = value;
  }
  return env;
}

/** Environment for a check command: the allow-list plus CI=1, so tools run non-interactively. */
export function checkEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...scrubbed(source, (name) => ALLOWED_NAMES.has(name) || name.startsWith('LC_')), CI: '1' };
}

/** Environment for an engine git invocation: the allow-list plus the user's git identity. Every other
 * GIT_* variable is dropped — GIT_DIR or GIT_CONFIG_* inherited from a caller would redirect the
 * engine's git at a different repository or configuration. */
export function gitEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return scrubbed(source, (name) => ALLOWED_NAMES.has(name) || name.startsWith('LC_') || GIT_IDENTITY_NAMES.has(name));
}
