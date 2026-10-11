# Security policy

## Supported versions

Only the latest release receives security fixes. The current plugin version is 0.1.1 (the bundled MCP server package is 0.1.0).

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's **Security → Report a vulnerability** flow. If private vulnerability reporting is unavailable, contact the repository owner privately and do not include exploit details or credentials in a public issue. Include affected versions, reproduction steps, impact, and a suggested mitigation when possible.

No external security audit has been completed.

## Credentials and model spending

Keep `OPENROUTER_API_KEY` in an untracked `.env` or an appropriate secret store. Never commit `.env`, access tokens, model responses containing secrets, or `config/models.local.json`. Rotate a key immediately if it may have been disclosed. Configure per-run/per-task budgets and the hard ceiling before using real models.

## Trust and isolation assumptions

Swarm execution uses an isolated Git worktree and does not intentionally edit the normal working tree. `/swarm-apply` is the controlled application path and requires explicit human review and approval. Review generated diffs as untrusted code before applying or executing them; worktree isolation is not a sandbox for arbitrary malicious processes.

## Threat model

Everything a model returns is treated as untrusted: file contents, file paths, and anything those files do when run. The swarm's own approval of a change does not make it trusted.

### What is contained

- **Path safety.** Models never emit shell commands or raw diffs, only structured file operations. Every path is resolved inside the worktree, including through symlinks; absolute paths, `..` escapes and any `.git` path segment are refused, so a file operation cannot write into the real repository's metadata (the worktree's `.git` points there). Repository read tools refuse files over 1 MiB, and a write over 2 MiB is rejected.
- **Allow-listed commands.** Checks run only the command and arguments in `config/checks.yaml`, never text a model wrote. The one exception is a review command, which defaults to the check categories themselves and can be replaced or emptied in `reviewCommands`. There a critic may append arguments, but never choose the program. Those arguments reach `execFile` as an argv array, absolute and `..` paths are refused, and the command runs in a throwaway copy of the worktree.
- **Environment scrubbing.** Checks and engine `git` calls get an allow-listed environment (`PATH`, `HOME`, locale, temp directories, `VIRTUAL_ENV`, Windows essentials; checks also get `CI=1`). Every other variable is dropped, including `OPENROUTER_API_KEY`, and so is any name matching `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL`. See `mcp-server/src/util/childEnv.ts`.
- **Git hooks.** Every engine `git` invocation runs with `core.hooksPath=/dev/null` and `core.fsmonitor=false`, so a hook directory the repository points at (for example a model-edited `.husky/`) never runs during the engine's commits or the `swarm_apply` merge. As a consequence, your own commit hooks do not run on the commit `swarm_apply` creates either; run them yourself afterwards if you rely on them.
- **Apply confirmation.** `swarm_apply` refuses to write CI workflows, git hook directories, `.gitattributes`/`.gitmodules`, `.envrc`, `.npmrc`, `.vscode/tasks.json`, `.pre-commit-config.yaml`, package manifests or build scripts (`package.json`, `pyproject.toml`, `setup.py`, `Makefile`, `tox.ini`, `noxfile.py`) unless called with `confirmSensitivePaths: true`, and names the files it refused. These run code on the next push, install, commit or editor open, outside any check. `swarm_get_delivery` lists them under `independentCheck.sensitivePaths`.
- **Input validation.** Run and approval ids must match `^[A-Za-z0-9_-]{1,128}$` before they reach a filesystem path, the base branch must be a plain git branch name, and free-text inputs are length-capped.
- **Dashboard.** The dashboard binds to `127.0.0.1` only, rejects requests whose `Host` header is not a loopback name (DNS rebinding), and serves a restrictive Content-Security-Policy.

### What is not contained

- **Checks execute model-written code with your user's privileges.** A test file a model authored is a program, and `npm test` or `pytest` runs it. It is not sandboxed: it can read anything your user can read (SSH keys, browser profiles, other repositories, `~/.env` files), write anywhere your user can write, and use the network. Environment scrubbing removes credentials from the *environment* only, not from disk. On Linux, set `sandbox: bubblewrap` in `config/checks.yaml` to run every check with no network, the whole filesystem read-only except the run's worktree, and a private `/tmp`. That stops a check from exfiltrating what it reads or writing outside the worktree, but it can still *read* your files while it runs. Without it, run the swarm as a low-privilege user, in a container or a VM if the target repository or the models are not trusted.
- **Applied code is still code.** After `swarm_apply`, the next time you run the project's tests, build or application, model-written code runs with no protection at all. Confirmation of sensitive paths is a prompt to look, not a guarantee those files are safe.
- **Your own git configuration.** Filter, diff and merge drivers configured in your git config still run on worktree content. A `.gitattributes` change can select one of them; it cannot define a new command.
- **Prompt injection.** Repository content and model output are fed back into prompts. A hostile file in the target repository can steer the swarm's models; the containment above limits what the result can do, not what the models decide.

MCP cannot cryptographically distinguish a direct human request from Claude independently requesting an operation. The apply boundary therefore relies on Claude Code permissions, command instructions, and attentive human confirmation—not a protocol-level identity guarantee. Governance approvals and spending controls reduce risk but do not replace review.
