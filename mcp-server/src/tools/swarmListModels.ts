import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { CatalogModel, OpenRouterClient } from '../engine/OpenRouterClient.js';
import { loadModelsLocalOverride, type ModelsConfig } from '../util/config.js';

/** One model's functional verdict, as written by `npm run probe:models`. */
export interface ProbeVerdict {
  /** True only when every probe case parsed and validated on the first attempt. */
  verified: boolean;
  /** Per-case failure reason, e.g. `{ implementer: 'schema' }`. Absent for a clean pass. */
  failures?: Record<string, string>;
  probedAt: string;
}

export interface SwarmListModelsResult {
  current: {
    primary: string;
    fallback: string;
    updatedAt: string | null;
    isDefault: boolean;
  };
  /** Absent when no probe has been run yet, so callers can distinguish "unverified" from "failed". */
  probe?: {
    probedAt: string;
    probed: number;
    verifiedCount: number;
    verdicts: Record<string, ProbeVerdict>;
  };
  models: CatalogModel[];
}

interface RawProbeFile {
  probedAt?: string;
  probed?: number;
  verifiedCount?: number;
  results?: Record<
    string,
    { verified?: boolean; probedAt?: string; cases?: Record<string, { ok?: boolean; failureKind?: string }> }
  >;
}

/** Reads config/model-probe.json if a probe has been run. A missing or unreadable file is not an
 * error: the probe is optional, and every caller must already handle a model it has no verdict for. */
export function loadProbeResults(configDir: string): SwarmListModelsResult['probe'] {
  const probePath = path.join(configDir, 'model-probe.json');
  if (!existsSync(probePath)) return undefined;

  let raw: RawProbeFile;
  try {
    raw = JSON.parse(readFileSync(probePath, 'utf8')) as RawProbeFile;
  } catch {
    return undefined;
  }
  if (!raw.results) return undefined;

  const verdicts: Record<string, ProbeVerdict> = {};
  for (const [id, result] of Object.entries(raw.results)) {
    const failures: Record<string, string> = {};
    for (const [caseId, caseResult] of Object.entries(result.cases ?? {})) {
      if (!caseResult.ok) failures[caseId] = caseResult.failureKind ?? 'failed';
    }
    verdicts[id] = {
      verified: result.verified === true,
      ...(Object.keys(failures).length ? { failures } : {}),
      probedAt: result.probedAt ?? raw.probedAt ?? '',
    };
  }

  return {
    probedAt: raw.probedAt ?? '',
    probed: raw.probed ?? Object.keys(verdicts).length,
    verifiedCount: raw.verifiedCount ?? Object.values(verdicts).filter((v) => v.verified).length,
    verdicts,
  };
}

export async function swarmListModels(
  client: OpenRouterClient,
  configDir: string,
  baseModelsConfig: ModelsConfig,
): Promise<SwarmListModelsResult> {
  const catalog = await client.listModels();
  catalog.sort((a, b) => a.id.localeCompare(b.id));

  const override = loadModelsLocalOverride(configDir);
  const builtInRole = Object.values(baseModelsConfig.roles)[0];
  const probe = loadProbeResults(configDir);

  return {
    current: override
      ? { primary: override.primary, fallback: override.fallback, updatedAt: override.updatedAt, isDefault: false }
      : { primary: builtInRole.primary, fallback: builtInRole.fallback, updatedAt: null, isDefault: true },
    ...(probe ? { probe } : {}),
    models: catalog,
  };
}
