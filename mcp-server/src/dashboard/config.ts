export interface DashboardConfig {
  enabled: boolean;
  /** Preferred port. If taken, the server logs and stands down rather than failing MCP startup. */
  port: number;
  /**
   * Always loopback. Not configurable by design: the ledger carries prompts, diffs and raw model
   * output, so there is deliberately no code path that binds a routable interface.
   */
  host: '127.0.0.1';
  autoOpen: boolean;
  /** 'template' = deterministic rhetoric (free, offline). 'llm' = opt-in generated prose. */
  rhetoric: 'template' | 'llm';
  /**
   * Tail `runs/` for writes by other processes (the benchmark harness). Optional so that every
   * existing call site constructing a config literal keeps compiling; absent means on.
   */
  watch?: boolean;
  /** Show the rotating propaganda banner. Optional for the same reason as `watch`; absent means on. */
  banner?: boolean;
  bannerMs?: number;
  /**
   * Poster library root, holding one directory per strategy. Absent means the plugin's own
   * `assets/propaganda/`, which is where the bundled posters live and where the fetcher writes.
   */
  bannerDir?: string;
  /** Show the muted archival newsreel reel. Optional for the same reason as `watch`; absent means on. */
  newsreel?: boolean;
  /**
   * Newsreel library root, a single flat directory (unlike `bannerDir`, this one isn't split per
   * strategy — see newsreel.ts). Absent means the plugin's own `assets/newsreel/`.
   */
  newsreelDir?: string;
}

export const DEFAULT_DASHBOARD_PORT = 8731;

/**
 * How long each poster holds the banner.
 *
 * Three seconds is short enough to read as agitprop rather than decoration, and long enough that
 * the next image has always finished decoding before its turn (the page preloads one ahead).
 */
export const DEFAULT_BANNER_MS = 3000;

/** Below this the rotation is a strobe rather than a banner, and above it nothing is gained. */
const BANNER_MS_RANGE = { min: 500, max: 60_000 };

function boolEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

export function loadDashboardConfig(env: NodeJS.ProcessEnv = process.env): DashboardConfig {
  const rawPort = Number(env.SWARM_DASHBOARD_PORT);
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : DEFAULT_DASHBOARD_PORT;

  const rawBannerMs = Number(env.SWARM_DASHBOARD_BANNER_MS);
  const bannerMs =
    Number.isFinite(rawBannerMs) && rawBannerMs >= BANNER_MS_RANGE.min && rawBannerMs <= BANNER_MS_RANGE.max
      ? Math.round(rawBannerMs)
      : DEFAULT_BANNER_MS;

  const bannerDir = env.SWARM_DASHBOARD_BANNER_DIR?.trim();
  const newsreelDir = env.SWARM_DASHBOARD_NEWSREEL_DIR?.trim();

  return {
    enabled: boolEnv(env.SWARM_DASHBOARD, true),
    port,
    host: '127.0.0.1',
    autoOpen: boolEnv(env.SWARM_DASHBOARD_OPEN, true),
    rhetoric: env.SWARM_DASHBOARD_RHETORIC?.trim().toLowerCase() === 'llm' ? 'llm' : 'template',
    watch: boolEnv(env.SWARM_DASHBOARD_WATCH, true),
    banner: boolEnv(env.SWARM_DASHBOARD_BANNER, true),
    bannerMs,
    ...(bannerDir ? { bannerDir } : {}),
    newsreel: boolEnv(env.SWARM_DASHBOARD_NEWSREEL, true),
    ...(newsreelDir ? { newsreelDir } : {}),
  };
}

export function dashboardUrl(config: DashboardConfig, port = config.port): string {
  return `http://${config.host}:${port}/`;
}
