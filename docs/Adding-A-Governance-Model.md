# Adding a governance model

A governance model here is a doctrine: a way of deciding what gets built, by whom, and when work counts as done. The engine supplies everything a doctrine shares. It runs one run loop in an isolated worktree, executes checks from `config/checks.yaml`, records a hash-chained ledger, assembles the delivery packet, and holds Claude's independent acceptance boundary. A doctrine supplies its institutions: how it plans, who is assigned and how, who reviews, how it votes, bids or rules, and how it accepts.

There are two layers, and a new model needs both:

1. **A constitution.** This is the declarative, machine-readable part: articles, agent rights, the decision rules the doctrine may record decisions under, and its configuration schema. The engine enforces the constitution deterministically, whatever the models say. A run adopts it at start, keeps it through resume, and the verifier holds the finished record to it.
2. **A strategy.** This is TypeScript implementing `SwarmStrategy`. Its lifecycle methods run the doctrine's institutions, and they call models where the doctrine deliberates.

Start from `mcp-server/src/strategies/noop/NoopStrategy.ts`, the minimal working strategy, and read one real doctrine next to it. `managerial/` is the smallest; `democratic/` is the most complete.

## 1. Register the id

- Add the id to `StrategyId` in `mcp-server/src/engine/types.ts`.
- Add an entry to `STRATEGY_REGISTRY` in `mcp-server/src/strategies/registry.ts`. Set:
  - `kind`: `doctrine`, or `control` for a benchmark baseline;
  - `startable`: whether `swarm_start` offers it to users;
  - `benchmarked`: whether the default benchmark sweep runs it;
  - `releaseGate`: whether it must pass the offline release gate.

  The table is a `Record<StrategyId, …>`, so the compiler refuses an id with no entry. The MCP server, the `swarm_start` input schema and the benchmark all read this table; nothing else lists strategies.

## 2. Write the constitution

- **Configuration schema.** Add a `.strict()` zod schema for the doctrine's section in `mcp-server/src/constitution/schema.ts`, with every default in the schema. Add it to `strategiesConfigSchema`, then add the section to `config/strategies.yaml`. The file is validated at startup: unknown keys and bad values stop the server with the key path named. A typo can never silently fall back to a default.
- **Decision rules.** Every governance decision is recorded with `recordGovernanceDecision` (`mcp-server/src/engine/governance.ts`) under a rule from the closed set in `mcp-server/src/constitution/rules.ts`. A rule is one of three kinds:
  - a **threshold**: which choice is "in favour", the fraction, the denominator (votes cast or eligible members), strictness, an optional quorum, and the result labels for carried and failed;
  - a **plurality**, for elections;
  - **recorded**, for decisions that are not tallied, such as a published bid score.

  `recordGovernanceDecision` re-counts the positions under the declared rule and throws `GovernanceHaltError` when the recorded result does not follow, before anything reaches the ledger. Reuse an existing rule where one fits; add a new one only for a genuinely different procedure, and test it in `rules.test.ts`.
- **Articles and rights.** Write them as data in `strategies/<doctrine>/constitution.ts`, using the shared `Article` and `AgentRight` types in `mcp-server/src/constitution/articles.ts`. Each article names its enforcement site: an engine barrier, a predicate, or a ledger record. Prefer a pure predicate that the strategy calls and the tests cover over an instruction in a prompt. A rule that lives only in a prompt is advice, not governance.
- **Wire it into `articles.ts`:**
  - add the doctrine to `CONFIGURED_STRATEGIES` and `SECTION_SCHEMAS`;
  - teach `rulesInUse` which rules the configuration enables;
  - choose its articles in `constitutionDocument`.

  Then run `npm run constitution:export` (in `mcp-server/`) to generate `docs/constitutions/<doctrine>.json`. A test fails whenever the checked-in file drifts from the code.

## 3. Implement `SwarmStrategy`

The interface is in `mcp-server/src/engine/SwarmStrategy.ts`. The engine calls the methods in this order and owns everything between them:

| Method | Responsibility |
| --- | --- |
| `plan` | Turn the task into a `TaskGraph`. |
| `declareOwnership` | Publish which paths each task owns, before dispatch. The engine runs only disjoint owners concurrently and flags unclaimed writes. |
| `assign` | Choose who does each ready task, and record the doctrine's authority for it (a mandate, an award). |
| `execute` | Produce a `WorkProduct` of file operations. The engine applies it, runs the checks and records the result; the strategy never runs checks itself. |
| `review`, `decide` | The doctrine's verdict on one task, given the actual check results. |
| `recordOutcome` | Update doctrine state (reputation, treasury, offices) from the verdict. |
| `requiresHumanApproval` | Escalate a decision to Claude and the user. |
| `recover` (optional) | One bounded chance to prepare a different attempt after rework. |
| `integrate`, `verifyDelivery`, `disposeFindings`, `accept` | The acceptance barriers on the assembled delivery. The integrator and verifier must sit outside the authorship chain. |
| `remediate` | Resume from Claude's rejection under the doctrine's own rules. |

Rules for a strategy:

- Read configuration from `ctx.config`. It is the section the run adopted at start, so editing `strategies.yaml` mid-run cannot change the rules of a run in progress.
- Record every institutional act in the ledger with `ctx.ledger.record(type, data)`. Record every decision that has a rule through `recordGovernanceDecision`, so that it is tallied, enforced and replayable. Give decisions a deterministic id from `nextGovernanceDecisionId`, so that a resumed run replays them rather than re-deciding them.
- Draw lots with `lotSeed(ctx)` (`mcp-server/src/util/lots.ts`), never `Math.random`, so that a benchmark trial can be reproduced.
- Call models only through `ctx.dispatcher`. It meters cost against the budget, fails over on stalls, offers repository tools, and pins every call in the ledger to its task with digests of its prompt and reply.

## 4. Make it visible and comparable

- **Dashboard narration.** Every ledger event type needs a narration template in `mcp-server/src/dashboard/DoctrineNarrator.ts`, or an entry in its silent list. A test scans the source for `ledger.record(...)` calls and fails on any type without one.
- **Milestones.** Add `strategies/<doctrine>/milestones.ts` and register it in `strategies/milestones.ts`, for the run summaries.
- **Benchmark neutrality.** The benchmark's arms must receive the same task, budget, checks and models. Keep any doctrine-specific advantage out of shared prompts.

## 5. Test it

At minimum:

- unit tests for each pure predicate and for any new rule in `rules.test.ts`;
- a strategy test with a scripted dispatcher (see `strategies/*/*.test.ts`);
- the registry test (`strategies/registry.test.ts`), which checks that the registry and the constitution schemas agree;
- `npm test`, `npm run smoke:engine` and `npm run example`.

A real run costs money: `npm run smoke:<doctrine>` if you add one, or `/swarm-start` against a scratch repository. Audit the result with `/swarm-verify` or `npm run verify:run -- <runId>`. A doctrine is not done until a finished run verifies clean.
