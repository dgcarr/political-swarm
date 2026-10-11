import type { RiskClass } from './types.js';
import { matchesAnyGlob } from '../util/glob.js';

/**
 * Shared risk classification so all three strategies agree on what counts as "high risk"
 * (a security-sensitive path) vs. "medium" (touches several top-level modules) vs. "low".
 * Strategies pass their own securityPathGlobs from config/strategies.yaml.
 */
export function classifyRiskByPaths(
  touchedPaths: string[],
  opts: { securityPathGlobs: string[]; crossModuleThreshold?: number },
): RiskClass {
  if (touchedPaths.length === 0) return 'low';
  if (touchedPaths.some((p) => matchesAnyGlob(p, opts.securityPathGlobs))) return 'high';

  const topLevelDirs = new Set(
    touchedPaths.map((p) => p.replace(/\\/g, '/').split('/')[0]).filter((d) => d.length > 0),
  );
  const threshold = opts.crossModuleThreshold ?? 2;
  return topLevelDirs.size >= threshold ? 'medium' : 'low';
}
