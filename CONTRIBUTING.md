# Contributing to Political Swarm

Contributions are welcome. Please keep changes focused and preserve the safety boundary between swarm worktrees and the user's repository.

## Development setup

Prerequisites: Git, Node.js 20 or later (CI pins 20), and npm. An OpenRouter key is needed only for real-model smoke tests and benchmarks.

```bash
git clone https://github.com/dgcarr/political-swarm.git
cd political-swarm/mcp-server
npm install
npm run build
npm test
```

Zero-cost checks need no API key: `npm run smoke:engine`, `npm run example` (an end-to-end governance tour) and `npm run smoke:dashboard-live`; CI runs all three. `smoke:dashboard` replays locally recorded runs and fails on a fresh clone. The `smoke:mcp`, `smoke:capitalist`, `smoke:democratic`, `smoke:socialist`, `smoke:delivery` and `smoke:budget` commands make OpenRouter calls; review their expected cost and configure `OPENROUTER_API_KEY` locally before running them. `smoke:models` fetches the public catalog and makes small paid decision-model probes; configure `OPENROUTER_API_KEY` before running it.

## Making a change

1. Open an issue for bugs or substantial design changes.
2. Create a focused branch, add tests, and run the build and relevant checks.
3. Submit a pull request explaining behavior and safety implications.

Governance implementations live under `mcp-server/src/strategies/`. New or changed strategies should implement the shared strategy interface, retain approval/escalation behavior, use deterministic tests for policy logic, and include an end-to-end smoke path where practical. See [`docs/Adding-A-Governance-Model.md`](docs/Adding-A-Governance-Model.md).

Never commit API keys, `.env`, `config/models.local.json`, benchmark results containing sensitive prompts, or credentials. Use `.env.example` placeholders. Report security issues using the private process in `.github/SECURITY.md`, not a public issue.
