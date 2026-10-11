import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { loadStrategiesConfig } from '../util/config.js';
import {
  CAPITALIST_DEFAULTS,
  DEMOCRATIC_DEFAULTS,
  MANAGERIAL_DEFAULTS,
  parseStrategiesConfig,
  SINGLE_AGENT_DEFAULTS,
  SOCIALIST_DEFAULTS,
} from './schema.js';

const configDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../config');
const checkedIn = yaml.load(readFileSync(path.join(configDir, 'strategies.yaml'), 'utf8')) as Record<string, Record<string, unknown>>;

function writeConfig(text: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'strategies-config-'));
  writeFileSync(path.join(dir, 'strategies.yaml'), text, 'utf8');
  return dir;
}

describe('strategies.yaml schema', () => {
  it('accepts the checked-in file', () => {
    expect(() => loadStrategiesConfig(configDir)).not.toThrow();
  });

  // The schema's defaults are the one set: a section left out of the file runs exactly as the
  // checked-in file does. Capitalist policy blocks are overrides of their modules' constants.
  it('defaults every key to the value the checked-in file gives it', () => {
    const parsed = parseStrategiesConfig(checkedIn);
    expect(parsed.democratic).toEqual(DEMOCRATIC_DEFAULTS);
    expect(parsed.socialist).toEqual(SOCIALIST_DEFAULTS);
    expect(parsed.managerial).toEqual(MANAGERIAL_DEFAULTS);
    expect(parsed.single_agent).toEqual(SINGLE_AGENT_DEFAULTS);
    const policyBlocks = ['listingTerms', 'specialisations', 'treasuryPolicy', 'creditPolicy', 'insurancePolicy',
      'capitalPolicy', 'contractPolicy', 'priceList'];
    const strip = (config: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(config).filter(([key]) => !policyBlocks.includes(key)));
    expect(strip(parsed.capitalist)).toEqual(strip(CAPITALIST_DEFAULTS));
  });

  it('fills a missing section with the defaults', () => {
    expect(parseStrategiesConfig({}).democratic.offices.termLengthInTasks).toBe(6);
    expect(parseStrategiesConfig({}).capitalist.initialCapital).toBe(500);
  });

  it('names the full path of an unknown key at startup', () => {
    const dir = writeConfig('democratic:\n  debate:\n    maxRoundPerMotion: 1\n');
    expect(() => loadStrategiesConfig(dir)).toThrow(/democratic\.debate\.maxRoundPerMotion: unknown key/);
  });

  it('refuses a vote threshold label no rule implements, instead of falling back to a majority', () => {
    expect(() => parseStrategiesConfig({ democratic: { voteThresholds: { routine: 'simple_majorty' } } }))
      .toThrow(/democratic\.voteThresholds\.routine/);
  });

  it('refuses an unknown top-level section', () => {
    expect(() => parseStrategiesConfig({ democratc: {} })).toThrow(/democratc: unknown key/);
  });

  it('refuses a debate longer than the one round the House holds', () => {
    expect(() => parseStrategiesConfig({ democratic: { debate: { maxRoundsPerMotion: 2 } } }))
      .toThrow(/democratic\.debate\.maxRoundsPerMotion/);
  });
});
