import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModelsConfig } from './config.js';

// The roster in config/models.yaml is hand-written, and nothing at load time checks it. That is how
// a model came to be declared as supporting `response_format` when OpenRouter reports it does not —
// the dispatcher then sent a parameter the model could not accept, and every run paid for it in
// corrective retries and 500s.
//
// These checks are the network-free half of the answer: they catch a roster that contradicts
// *itself*. The half that catches a roster contradicting *OpenRouter* needs the live catalog and
// lives in smoke/modelsSmoke.ts, because a unit test that reaches the network is a unit test that
// fails on a train.

const configDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../config');
const config = loadModelsConfig(configDir);

describe('config/models.yaml is internally consistent', () => {
  it('declares at least one role and one model', () => {
    expect(Object.keys(config.roles).length).toBeGreaterThan(0);
    expect(Object.keys(config.models).length).toBeGreaterThan(0);
  });

  // WorkerDispatcher skips a candidate whose pricing entry is missing, so a typo here does not
  // fail loudly — it silently halves the roster and the role limps along on its fallback.
  it('gives every role\'s primary and fallback a pricing entry', () => {
    const missing: string[] = [];
    for (const [role, entry] of Object.entries(config.roles)) {
      for (const [slot, modelId] of [['primary', entry.primary], ['fallback', entry.fallback]] as const) {
        if (!config.models[modelId]) missing.push(`${role}.${slot} -> ${modelId}`);
      }
    }
    expect(missing, `roles referencing models with no pricing entry: ${missing.join(', ')}`).toEqual([]);
  });

  it('gives each role a fallback that is a different model from its primary', () => {
    const degenerate = Object.entries(config.roles)
      .filter(([, e]) => e.primary === e.fallback)
      .map(([role]) => role);
    expect(degenerate, `roles whose fallback cannot rescue their primary: ${degenerate.join(', ')}`).toEqual([]);
  });

  it('leaves no model declared but unused by any role', () => {
    const referenced = new Set(Object.values(config.roles).flatMap((e) => [e.primary, e.fallback]));
    const orphans = Object.keys(config.models).filter((id) => !referenced.has(id));
    expect(orphans, `models with a pricing entry no role uses: ${orphans.join(', ')}`).toEqual([]);
  });

  // Zero is a real price: a preview model can be free, and since the client began preferring
  // OpenRouter's own reported cost this table is only the fallback for a provider that reports
  // none. What must never happen is an absent field, which YAML leaves undefined and arithmetic
  // turns into NaN — so the check is "present and not negative", not "greater than zero".
  it('gives every model a present, non-negative price', () => {
    for (const [id, entry] of Object.entries(config.models)) {
      expect(typeof entry.inputPricePerMTok, `${id} input price`).toBe('number');
      expect(typeof entry.outputPricePerMTok, `${id} output price`).toBe('number');
      expect(entry.inputPricePerMTok, `${id} input price`).toBeGreaterThanOrEqual(0);
      expect(entry.outputPricePerMTok, `${id} output price`).toBeGreaterThanOrEqual(0);
    }
  });

  // The dispatcher passes `response_format: {type:'json_object'}` whenever this is true. Declaring
  // it for a model that rejects the parameter is the exact defect this file exists to prevent, so
  // the field must at least be present and boolean rather than absent and coerced.
  it('states both capability flags explicitly for every model', () => {
    for (const [id, entry] of Object.entries(config.models)) {
      expect(typeof entry.supportsJsonMode, `${id}.supportsJsonMode`).toBe('boolean');
      expect(typeof entry.supportsToolCalls, `${id}.supportsToolCalls`).toBe('boolean');
    }
  });
});
