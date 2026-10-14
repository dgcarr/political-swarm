import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readdirSync } from 'node:fs';
import { DEFAULT_BANNER_MS, DEFAULT_DASHBOARD_PORT, dashboardUrl, loadDashboardConfig } from './config.js';
import { assetPath, assetsPresent, defaultPropagandaDir, publicDir } from './paths.js';

describe('loadDashboardConfig', () => {
  it('defaults to enabled on the loopback default port', () => {
    const config = loadDashboardConfig({});
    expect(config).toEqual({
      enabled: true,
      port: DEFAULT_DASHBOARD_PORT,
      host: '127.0.0.1',
      autoOpen: true,
      rhetoric: 'template',
      watch: true,
      banner: true,
      bannerMs: DEFAULT_BANNER_MS,
      newsreel: true,
    });
    // Absent unless overridden, so paths.ts stays the single owner of where the library lives.
    expect(config.bannerDir).toBeUndefined();
    expect(config.newsreelDir).toBeUndefined();
  });

  it('allows automatic browser opening to be disabled explicitly', () => {
    for (const value of ['0', 'false', 'off', 'no']) {
      expect(loadDashboardConfig({ SWARM_DASHBOARD_OPEN: value }).autoOpen).toBe(false);
    }
    expect(loadDashboardConfig({ SWARM_DASHBOARD_OPEN: '1' }).autoOpen).toBe(true);
  });

  it('lets the banner be switched off, and its pace and library moved', () => {
    expect(loadDashboardConfig({ SWARM_DASHBOARD_BANNER: '0' }).banner).toBe(false);
    expect(loadDashboardConfig({ SWARM_DASHBOARD_BANNER_MS: '5000' }).bannerMs).toBe(5000);
    expect(loadDashboardConfig({ SWARM_DASHBOARD_BANNER_DIR: '/tmp/posters' }).bannerDir).toBe('/tmp/posters');
  });

  it('lets the newsreel be switched off, and its library moved', () => {
    expect(loadDashboardConfig({ SWARM_DASHBOARD_NEWSREEL: '0' }).newsreel).toBe(false);
    expect(loadDashboardConfig({ SWARM_DASHBOARD_NEWSREEL_DIR: '/tmp/newsreel' }).newsreelDir).toBe('/tmp/newsreel');
  });

  it('ignores a rotation interval that would strobe or stall', () => {
    for (const raw of ['0', '-1', '50', '600000', 'abc', '']) {
      expect(loadDashboardConfig({ SWARM_DASHBOARD_BANNER_MS: raw }).bannerMs, raw).toBe(DEFAULT_BANNER_MS);
    }
  });

  it('lets the filesystem tailer be switched off', () => {
    expect(loadDashboardConfig({ SWARM_DASHBOARD_WATCH: '0' }).watch).toBe(false);
    expect(loadDashboardConfig({ SWARM_DASHBOARD_WATCH: 'false' }).watch).toBe(false);
    expect(loadDashboardConfig({}).watch).toBe(true);
  });

  it('treats the usual falsey spellings of SWARM_DASHBOARD as disabled', () => {
    for (const raw of ['0', 'false', 'no', 'off', 'OFF', ' False ']) {
      expect(loadDashboardConfig({ SWARM_DASHBOARD: raw }).enabled).toBe(false);
    }
    for (const raw of ['1', 'true', 'yes', '']) {
      expect(loadDashboardConfig({ SWARM_DASHBOARD: raw }).enabled).toBe(true);
    }
  });

  it('accepts a valid port override and ignores nonsense', () => {
    expect(loadDashboardConfig({ SWARM_DASHBOARD_PORT: '9000' }).port).toBe(9000);
    for (const raw of ['0', '-1', '70000', 'abc', '80.5']) {
      expect(loadDashboardConfig({ SWARM_DASHBOARD_PORT: raw }).port).toBe(DEFAULT_DASHBOARD_PORT);
    }
  });

  it('only opts into LLM rhetoric on an explicit llm value', () => {
    expect(loadDashboardConfig({ SWARM_DASHBOARD_RHETORIC: 'llm' }).rhetoric).toBe('llm');
    expect(loadDashboardConfig({ SWARM_DASHBOARD_RHETORIC: 'LLM' }).rhetoric).toBe('llm');
    expect(loadDashboardConfig({ SWARM_DASHBOARD_RHETORIC: 'template' }).rhetoric).toBe('template');
    expect(loadDashboardConfig({ SWARM_DASHBOARD_RHETORIC: 'anything' }).rhetoric).toBe('template');
  });

  it('never yields a non-loopback host, whatever the environment says', () => {
    const config = loadDashboardConfig({ SWARM_DASHBOARD_HOST: '0.0.0.0', HOST: '0.0.0.0' });
    expect(config.host).toBe('127.0.0.1');
    expect(dashboardUrl(config)).toBe(`http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}/`);
  });
});

describe('asset paths', () => {
  it('resolves public/ as a sibling of the module, not relative to cwd', () => {
    expect(publicDir.endsWith(`dashboard${process.platform === 'win32' ? '\\' : '/'}public`)).toBe(true);
    expect(assetPath('index.html').startsWith(publicDir)).toBe(true);
  });

  it('finds index.html from the source tree', () => {
    expect(assetsPresent()).toBe(true);
  });

  it('puts the poster library at the plugin root, outside the build output', () => {
    expect(defaultPropagandaDir.endsWith(path.join('assets', 'propaganda'))).toBe(true);
    // Inside public/ it would be wiped and re-copied by the build; it must not be.
    expect(defaultPropagandaDir.startsWith(publicDir)).toBe(false);
  });
});
