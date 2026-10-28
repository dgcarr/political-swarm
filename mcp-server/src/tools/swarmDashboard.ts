import type { DashboardServer } from '../dashboard/DashboardServer.js';
import { openInBrowser } from '../dashboard/openBrowser.js';

export const swarmDashboardInputShape = {};

export interface SwarmDashboardResult {
  running: boolean;
  url: string | null;
  opened?: boolean;
  openClients?: number;
  note: string;
}

/**
 * Reports where the live dashboard is listening, or why it is not.
 *
 * The dashboard is deliberately allowed to fail without taking the MCP server down, so "not
 * running" is a normal answer that needs an actionable explanation rather than an error.
 *
 * This is the only place the browser is opened, so it happens when the user asks for the
 * dashboard rather than every time Claude Code starts the MCP server.
 */
export async function swarmDashboard(
  dashboard: DashboardServer | null,
  open: (url: string) => void = openInBrowser,
): Promise<SwarmDashboardResult> {
  if (dashboard?.url) {
    const opened = dashboard.autoOpen;
    if (opened) open(dashboard.url);
    return {
      running: true,
      url: dashboard.url,
      opened,
      openClients: dashboard.clientCount,
      note:
        'Open this in a browser to watch runs live. The page is read-only and bound to loopback; ' +
        'approvals are resolved with swarm_decide, not from the page.',
    };
  }

  return {
    running: false,
    url: null,
    note:
      'The dashboard is not listening. Most often it is disabled (SWARM_DASHBOARD=0), its port is ' +
      'already taken by another MCP server instance — in which case that instance is serving the ' +
      'same runs — or the build did not copy the page assets into dist/. Check the MCP server log ' +
      'on stderr for the reason recorded at startup.',
  };
}
