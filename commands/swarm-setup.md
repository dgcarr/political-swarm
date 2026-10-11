---
description: Choose the OpenRouter primary/fallback models the swarm uses
allowed-tools: mcp__plugin_political-swarm_swarm__swarm_list_models, mcp__plugin_political-swarm_swarm__swarm_configure_models, AskUserQuestion
---

Call `swarm_list_models`. It returns:

- `current.primary` / `current.fallback` — the configured roster. If `current.isDefault` is true, nothing has been configured yet and these are just `models.yaml`'s built-in fallback.
- `models` — the OpenRouter catalog.
- `probe` — **present only if `npm run probe:models` has been run.** Functional verdicts from real completion calls against the planner and implementer schemas. `probe.verdicts[id]` gives `{ verified, failures?, probedAt }`, where `verified` is true only when every probe case parsed and validated on the *first* attempt. `failures` maps a case id to why it failed: `schema` / `unparseable` (the model's own fault — a durable verdict), `capability-mismatch` (the catalog advertises a capability the provider refuses), or `timeout` / `transport` (the provider that hour, not the model — these get retried automatically on the next probe).

## Check the current roster first

Before anything else, look up `current.primary` and `current.fallback` in `probe.verdicts`.

If either configured model has a probe verdict and is **not** verified, prominently report the recorded failure kind and probe time before the table. This is a cached first-attempt result, not proof that current runs fail or use the fallback: production calls may succeed, including after corrective retries. Describe possible reliability and cost consequences conditionally; establish actual fallback usage from run records before claiming it.

If either is missing from `probe.verdicts` entirely, say it is unverified rather than implying it failed.

## Print the catalog

Print a compact markdown table grouped by provider (the part of the id before `/`), with columns: id, context length, price per million tokens (input/output), and **Verified**.

Prefer verified models. List them first, and clearly separate any unverified or failed model you mention. For a failed one, show the failure kind rather than a bare cross — `schema` and `capability-mismatch` mean *do not pick this*, while `timeout`/`transport` mean *the last probe hit a bad moment; it may work*.

If the catalog is too large to print whole, subset it — but **span the range rather than truncating a sorted list**. Sorting by price ascending and cutting at N systematically hides the newest and most capable model in every provider, which is the opposite of useful here. Pick a spread across cheap / mid / premium within each provider you show, say that is what you are doing, and note that any id from the full catalog can still be typed in by hand via "Other".

If `probe` is absent entirely, print the table without the Verified column and tell the user that model capability is unverified — the catalog's own `supportsJsonMode` flag is not proof, since a provider can advertise it and still return 400. Point them at `npm run probe:models` (from `mcp-server/`), note it costs roughly $2 for the full catalog and caches its results, and continue without blocking: this command still works, it just cannot warn them off a broken model.

## Ask

Then ask via a single `AskUserQuestion` call with two questions:

1. "Pick the primary model" — first option is the current primary labeled "Keep current — recommended", followed by 2-3 alternatives spanning cheap/mid/premium pulled from the table you just printed. **Offer only verified models as alternatives.** If the current primary itself failed its probe, do not label it recommended — put a verified alternative first instead and say why.
2. "Pick the fallback model" — same shape, defaulting to the current fallback.

In the option descriptions, give the price, the context length, and the verification status. Prefer a fallback from a *different provider* than the chosen primary: a fallback sharing its primary's provider is a fallback only until that provider has an outage.

The user can also pick "Other" on either question and type any model id they saw in the table. If they name a model that failed its probe with `schema`, `unparseable`, or `capability-mismatch`, configure it as asked but tell them plainly what the probe found first.

## Save

Once both are resolved, call `swarm_configure_models` with `{primary, fallback}`. Confirm what was saved and remind the user this is now the default for every future `/swarm-start` and for `npm run benchmark`, until `/swarm-setup` is run again — no need to restart anything.

If `probe.probedAt` is more than about a month old, mention it: the catalog changes constantly, and a stale verdict is worth re-earning with `npm run probe:models`.
