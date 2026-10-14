# graphify
- **graphify** (`.claude/skills/graphify/SKILL.md`) - any input to knowledge graph. Trigger: `/graphify`
When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

## Extraction exemption for the query-first hook
The `PreToolUse` hooks in `.claude/settings.json` tell agents to run `graphify query`
before reading or grepping raw files. That is wrong during an extraction pass: the
extraction subagents *build* the graph, so querying it would return the stale nodes
they are replacing and bias the extraction toward what is already there.

Graphify is optional. Both hooks are skipped if `graphify` is not installed, or while
`graphify-out/.graphify_extracting` exists.
Create that marker before dispatching extraction subagents and delete it in the
cleanup step:

```bash
touch graphify-out/.graphify_extracting     # before Step 3 Part B dispatch
rm -f graphify-out/.graphify_extracting     # in Step 9 cleanup
```

The guard exits 0 whether or not the marker is present, so a tool call is never
blocked by it. If a run aborts and leaves the marker behind, the nudge stays off
until it is removed — delete it if `graphify query` stops being suggested.
