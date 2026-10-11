import type { OpenRouterClient } from '../engine/OpenRouterClient.js';
import type { ModelsConfig } from '../util/config.js';
import { logger } from '../util/logger.js';
import { untraceableFigures, type DoctrinalStatement, type RunRecord } from './DoctrinalStatement.js';

/**
 * Optionally re-voices a closing statement with a model, behind SWARM_DASHBOARD_RHETORIC=llm.
 *
 * The deterministic statement is always composed first and always shown first. This only ever
 * *replaces* prose that already exists, so a slow, failed or dishonest model costs the page
 * nothing — it simply keeps the template version.
 *
 * The model is given the facts and told to re-voice them. Its output is then run through
 * `untraceableFigures`, the same check that guards the templates, and rejected outright if it
 * cites a number the run record does not contain. An LLM writing a closing speech next to an
 * audit log is exactly where invented figures would do damage, so the guarantee is enforced
 * rather than requested.
 */

const ROLE = 'rhetorician';
const TIMEOUT_MS = 45_000;
const MAX_PARAGRAPHS = 8;

export class LlmRhetorician {
  constructor(
    private readonly client: OpenRouterClient,
    private readonly modelsConfig: ModelsConfig,
  ) {}

  /** Returns a re-voiced statement, or null to keep the deterministic one. */
  async revoice(statement: DoctrinalStatement, record: RunRecord): Promise<DoctrinalStatement | null> {
    const role = this.modelsConfig.roles[ROLE] ?? this.modelsConfig.roles.generalist;
    if (!role) {
      logger.warn('No rhetorician or generalist role configured; keeping the template statement');
      return null;
    }
    const modelEntry = this.modelsConfig.models[role.primary];
    if (!modelEntry) {
      logger.warn('Rhetorician model missing from the catalog; keeping the template statement', {
        model: role.primary,
      });
      return null;
    }

    try {
      const result = await this.client.chatCompletion({
        model: role.primary,
        modelEntry,
        timeoutMs: TIMEOUT_MS,
        temperature: 0.7,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: prompt(statement, record) },
        ],
      });

      const paragraphs = parseParagraphs(result.text);
      if (paragraphs.length === 0) {
        logger.warn('Rhetorician returned nothing usable; keeping the template statement');
        return null;
      }

      const invented = untraceableFigures(paragraphs.join(' '), record);
      if (invented.length > 0) {
        // Not negotiable. A statement that overstates the run is worse than a plain one.
        logger.warn('Rhetorician invented figures; keeping the template statement', {
          invented: invented.join(', '),
        });
        return null;
      }

      return {
        title: statement.title,
        paragraphs,
        // The ticker line stays deterministic: it is the one sentence most likely to be quoted.
        closing: statement.closing,
      };
    } catch (err) {
      logger.warn('Rhetorician call failed; keeping the template statement', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

const SYSTEM = [
  'You are a speechwriter producing the closing statement of an automated software run that was',
  'governed by a political model (parliamentary, council-socialist, or market).',
  '',
  'Rules, in order of importance:',
  '1. Never state a number that does not appear in the FIGURES list you are given. Do not compute',
  '   new ones, do not round, do not estimate, do not add dates or durations.',
  '2. Never claim an outcome better than the one described. If the run failed, say so plainly.',
  '3. Keep the register of the tradition and the structure of the draft you are given.',
  '4. Return only the statement, as 4 to 6 plain-text paragraphs separated by blank lines.',
  '   No markdown, no headings, no bullet points, no preamble.',
].join('\n');

function prompt(statement: DoctrinalStatement, record: RunRecord): string {
  const figures = Object.entries(record)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');

  return [
    `TRADITION: ${record.strategy}`,
    `OUTCOME: ${record.outcome}`,
    `TITLE: ${statement.title}`,
    `FIGURES (the only numbers you may use): ${figures}`,
    '',
    'DRAFT TO RE-VOICE:',
    ...statement.paragraphs.map((p) => `- ${p}`),
  ].join('\n');
}

function parseParagraphs(text: string): string[] {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    // Strip any markdown the model added despite being asked not to.
    .map((p) => p.replace(/^[#>\-*\s]+/, '').replace(/\*\*/g, ''))
    .filter((p) => p.length > 0)
    .slice(0, MAX_PARAGRAPHS);
}
