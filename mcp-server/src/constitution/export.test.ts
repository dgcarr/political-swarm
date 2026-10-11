import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadStrategiesConfig } from '../util/config.js';
import { CONFIGURED_STRATEGIES } from './articles.js';
import { CONSTITUTIONS_DIR, DEFAULT_CONFIG_DIR, renderConstitution } from './export.js';

// The checked-in constitutions are generated. When this fails, an article, a rule or
// config/strategies.yaml changed without them: run `npm run constitution:export` and commit the result.
describe('docs/constitutions', () => {
  const config = loadStrategiesConfig(DEFAULT_CONFIG_DIR);

  for (const id of CONFIGURED_STRATEGIES) {
    it(`${id}.json matches the generator`, () => {
      expect(readFileSync(path.join(CONSTITUTIONS_DIR, `${id}.json`), 'utf8')).toBe(renderConstitution(id, config));
    });
  }
});
