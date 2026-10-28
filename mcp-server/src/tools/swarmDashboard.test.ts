import { describe, expect, it } from 'vitest';
import type { DashboardServer } from '../dashboard/DashboardServer.js';
import { swarmDashboard } from './swarmDashboard.js';

const URL = 'http://127.0.0.1:8731/';
const fake = (autoOpen: boolean) => ({ url: URL, clientCount: 0, autoOpen }) as unknown as DashboardServer;

describe('swarm_dashboard', () => {
  it('opens the browser when the tool is used', async () => {
    const opened: string[] = [];
    const result = await swarmDashboard(fake(true), (url) => opened.push(url));
    expect(opened).toEqual([URL]);
    expect(result).toMatchObject({ running: true, url: URL, opened: true });
  });

  it('does not open the browser when SWARM_DASHBOARD_OPEN is off', async () => {
    const opened: string[] = [];
    const result = await swarmDashboard(fake(false), (url) => opened.push(url));
    expect(opened).toEqual([]);
    expect(result.opened).toBe(false);
  });

  it('opens nothing when the dashboard is not running', async () => {
    const opened: string[] = [];
    const result = await swarmDashboard(null, (url) => opened.push(url));
    expect(opened).toEqual([]);
    expect(result.running).toBe(false);
  });
});
