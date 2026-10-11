---
description: Open the live swarm dashboard — worker activity and the political doctrine ticker
allowed-tools: mcp__plugin_political-swarm_swarm__swarm_dashboard, mcp__plugin_political-swarm_swarm__swarm_list_runs
---

Call `swarm_dashboard`.

If it reports `running: true`, give the user the URL as a clickable link. Explain that Political Swarm shows run progress and the next action, with Work plan, Workers and Event log tabs, expandable live doctrine narration, and Compare runs for a side-by-side view. Hidden runs can be restored without deleting their saved records.

The dashboard opens in the default browser when its MCP server successfully starts. Set `SWARM_DASHBOARD_OPEN=0` in the plugin environment to disable automatic opening. This command returns the URL; it does not open another browser tab. The page updates automatically.

If a run id was given in `$ARGUMENTS`, note that the page auto-selects a live run if there is one,
and that they can pick any past run from the list on the left.

If it reports `running: false`, relay the `note` verbatim rather than guessing — it names the
likely cause. Then offer the two fixes worth trying: rebuild the plugin (`npm run build` in
`mcp-server/`, which is what copies the page assets into `dist/`) and restart Claude Code so the
MCP server starts again; or, if the port is simply taken by another Claude Code window running the
same plugin, point out that the other window's dashboard is already serving the same runs.

Do not attempt to start the dashboard yourself, and do not try to fetch the URL — it is for the
user's browser.
