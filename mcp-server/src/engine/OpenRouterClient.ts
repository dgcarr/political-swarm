import { withRetry, isTransientNetworkError } from '../util/retry.js';
import { logger } from '../util/logger.js';
import type { ModelEntry } from '../util/config.js';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string; name?: string };

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /**
   * False when `costUsd` is this repository's own arithmetic rather than OpenRouter's figure.
   *
   * The local price table cannot be right in general: OpenRouter routes one model to several
   * providers at different prices, a model may bill reasoning tokens the completion count does not
   * include, and nothing here notices when a published price changes. A benchmark sweep estimated
   * at about $7 was billed roughly $20, so a spend figure has to say which kind of number it is.
   */
  costMetered: boolean;
  model: string;
  attempts: number;
  timedOut: boolean;
  /** True when an attempt was given up because the model went silent, not because it ran long. */
  stalled?: boolean;
  provider?: string;
  assistantMessage?: Extract<ChatMessage, { role: 'assistant' }>;
  toolCalls?: ToolCall[];
}

export interface OpenRouterCallOptions {
  model: string;
  modelEntry: ModelEntry;
  messages: ChatMessage[];
  jsonMode?: boolean;
  /** Hard ceiling on the whole call. With `stallTimeout` it is only a backstop. */
  timeoutMs: number;
  /**
   * Streams the response and gives up when the model goes silent rather than when it runs long.
   *
   * A wall-clock limit cannot tell a stall from slow, productive work, so it had to be re-tuned for
   * every roster: inkling-small sat silent in a provider queue for minutes, while solar-mini4 took
   * 100-189s writing real implementations. Silence is the thing worth timing. OpenRouter's
   * keep-alive comments do not count as progress — a queued request receives them too.
   */
  stallTimeout?: StallTimeout;
  temperature?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Caps completion tokens so a call's worst-case cost is known before it is made. */
  maxTokens?: number;
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
}

export interface StallTimeout {
  /** Longest wait for the first content, reasoning or tool-call token. */
  firstTokenMs: number;
  /** Longest silence allowed between tokens after that. */
  betweenTokensMs: number;
}

/** The non-streamed response body, which a stream is reassembled into. */
interface CompletionJson {
  choices?: { message?: { content?: string | null; tool_calls?: unknown }; finish_reason?: string; error?: { message?: string } }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    /** OpenRouter's own charge for this call, in USD, when it reports one. */
    cost?: number;
  };
  error?: { message?: string; code?: number };
  provider?: unknown;
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

/** A typed question for the Decisions API. Criteria describe each answer in the question's terms. */
export type DecisionQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  | { type: 'score'; instructions: string; criteria: string[] };

export type DecisionAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'noul'; noul: number }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number> };

export interface DecideOptions {
  model: string;
  modelEntry: ModelEntry;
  /** What the questions are about. Treated by the model as data, not instructions. */
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, DecisionQuestion>;
  timeoutMs: number;
}

export interface DecisionResult {
  answers: Record<string, DecisionAnswer>;
  promptTokens: number;
  costUsd: number;
  costMetered: boolean;
  model: string;
  attempts: number;
  timedOut: boolean;
  provider?: string;
}

interface DecisionsWire {
  answers?: Record<string, unknown>;
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
  error?: { message?: string };
  provider?: unknown;
}

/** Every question answered, in the shape it was asked, with a choice that was on offer. */
export function checkedAnswers(
  questions: Record<string, DecisionQuestion>,
  wire: Record<string, unknown> | undefined,
): Record<string, DecisionAnswer> {
  const answers: Record<string, DecisionAnswer> = {};
  for (const [key, question] of Object.entries(questions)) {
    const answer = wire?.[key] as Record<string, unknown> | undefined;
    if (!answer || answer.type !== question.type) throw new Error(`Decision "${key}" came back without a ${question.type} answer`);
    if (question.type === 'choice' && (typeof answer.choice !== 'string' || !(answer.choice in question.criteria))) {
      throw new Error(`Decision "${key}" chose "${String(answer.choice)}", which was not offered`);
    }
    if (question.type === 'noul' && typeof answer.noul !== 'number') throw new Error(`Decision "${key}" has no probability`);
    answers[key] = answer as unknown as DecisionAnswer;
  }
  return answers;
}

/** Retries a provider or transport failure, never a timeout: that already spent the whole budget. */
function retryPolicy(model: string): (err: unknown) => boolean {
  return (err) => {
    const e = err as Error & { status?: number; timeout?: boolean };
    if (e.timeout) {
      logger.warn('OpenRouter call hit the per-call timeout, not retrying', { model });
      return false;
    }
    if (typeof e.status === 'number') {
      const retryable = e.status === 429 || e.status >= 500;
      if (!retryable) logger.debug('OpenRouter call not retryable', { status: e.status, err: String(err) });
      return retryable;
    }
    // No status at all: a transport failure rather than an HTTP response.
    if (isTransientNetworkError(e)) {
      logger.warn('OpenRouter transport error, retrying', { model, err: String(err) });
      return true;
    }
    logger.debug('OpenRouter call not retryable', { err: String(err) });
    return false;
  };
}
/**
 * An upstream rate limit ("temporarily rate-limited upstream") outlasts the default backoff, whose
 * four attempts are spent in about six seconds; a 429 waits for its Retry-After, or 4s, 8s, 16s.
 */
const RATE_LIMIT_BASE_DELAY_MS = 4_000;
const MAX_RETRY_AFTER_MS = 30_000;

export function rateLimitDelay(err: unknown, attempt: number): number | undefined {
  const e = err as { status?: number; retryAfterMs?: number };
  if (e.status !== 429) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, e.retryAfterMs ?? RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1));
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** A provider that cannot hold JSON mode for this prompt fails it the same way on every retry. */
const JSON_MODE_REFUSED = /failed to generate json/i;

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export interface CatalogModel {
  id: string;
  name: string;
  contextLength: number | null;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  supportsJsonMode: boolean;
  supportsToolCalls: boolean;
  /** When OpenRouter listed the model, in unix seconds. */
  createdAt?: number;
}

// Thin wrapper over the OpenRouter chat-completions endpoint. Retries on 429/5xx with
// exponential backoff. Cost is whatever OpenRouter says it charged; the models.yaml table is only
// the fallback for a provider that reports none, and a result says which of the two it carries.
export class OpenRouterClient {
  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error(
        'OPENROUTER_API_KEY is not set. Add it to political-swarm/.env as OPENROUTER_API_KEY=... ' +
          'and restart the MCP server.',
      );
    }
  }

  async chatCompletion(opts: OpenRouterCallOptions): Promise<ChatCompletionResult> {
    let failedAttempts = 0;
    // Set once the provider refuses JSON mode: later attempts ask in plain text, which the prompt's
    // schema description and extractJson already handle.
    let jsonModeRefused = false;
    let anyAttemptTimedOut = false;
    let anyAttemptStalled = false;

    return withRetry(
      async () => {
        const controller = new AbortController();
        // Tracked per attempt so shouldRetry can tell "we gave up on time" from "the socket died":
        // an abort we caused already consumed the whole per-call budget, so retrying it would
        // multiply wall-clock time rather than recover anything.
        let timedOut = false;
        let stalled = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, opts.timeoutMs);
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        const armStall = (ms: number): void => {
          clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            stalled = true;
            controller.abort();
          }, ms);
        };
        if (opts.stallTimeout) armStall(opts.stallTimeout.firstTokenMs);
        try {
          const res = await fetch(OPENROUTER_URL, {
            method: 'POST',
            signal: controller.signal,
            headers: this.headers(),
            body: JSON.stringify({
              model: opts.model,
              messages: opts.messages,
              temperature: opts.temperature ?? 0.2,
              ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
              ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
              ...(opts.jsonMode && !jsonModeRefused ? { response_format: { type: 'json_object' } } : {}),
              ...(opts.tools?.length ? { tools: opts.tools, tool_choice: opts.toolChoice ?? 'auto' } : {}),
              ...(opts.stallTimeout ? { stream: true } : {}),
              // Ask OpenRouter to return what it actually charged, rather than inferring it here.
              usage: { include: true },
            }),
          });

          if (!res.ok) {
            const body = await res.text();
            const err = new Error(`OpenRouter ${res.status} for model ${opts.model}: ${body.slice(0, 500)}`);
            (err as Error & { status?: number; retryAfterMs?: number }).status = res.status;
            if (res.status === 429) (err as Error & { retryAfterMs?: number }).retryAfterMs = retryAfterMs(res.headers.get('retry-after'));
            throw err;
          }

          const stallTimeout = opts.stallTimeout;
          const json: CompletionJson = stallTimeout && res.headers.get('content-type')?.includes('text/event-stream')
            ? await readCompletionStream(res, () => armStall(stallTimeout.betweenTokensMs))
            : ((await res.json()) as CompletionJson);

          // OpenRouter can return HTTP 200 with a top-level `error`, or a `choices[0].error`
          // (upstream provider failure surfaced per-choice) instead of raising a non-2xx status.
          // Both are transient/provider-side — worth a retry, never a crash.
          const topLevelError = json.error?.message;
          const choiceError = json.choices?.[0]?.error?.message;
          if (topLevelError || choiceError) {
            const err = new Error(`OpenRouter returned an error for model ${opts.model}: ${topLevelError ?? choiceError}`);
            (err as Error & { status?: number }).status = 500;
            if (opts.jsonMode && JSON_MODE_REFUSED.test(String(topLevelError ?? choiceError))) {
              jsonModeRefused = true;
              logger.warn('Provider refused JSON mode, retrying without it', { model: opts.model });
            }
            throw err;
          }

          const wireMessage = json.choices?.[0]?.message;
          const toolCalls = parseToolCalls(wireMessage?.tool_calls);
          const text = wireMessage?.content ?? '';
          const assistantMessage: Extract<ChatMessage, { role: 'assistant' }> = {
            role: 'assistant',
            content: wireMessage?.content ?? null,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          };
          const promptTokens = json.usage?.prompt_tokens ?? 0;
          const completionTokens = json.usage?.completion_tokens ?? 0;
          const provider = typeof json.provider === 'string' ? json.provider : undefined;
          // Prefer the provider's own figure; fall back to the local table and say so.
          const meteredCost = json.usage?.cost;
          const costMetered = typeof meteredCost === 'number' && Number.isFinite(meteredCost);
          const costUsd = costMetered
            ? meteredCost
            : (promptTokens / 1_000_000) * opts.modelEntry.inputPricePerMTok +
              (completionTokens / 1_000_000) * opts.modelEntry.outputPricePerMTok;

          return {
            text,
            promptTokens,
            completionTokens,
            costUsd,
            costMetered,
            model: opts.model,
            attempts: failedAttempts + 1,
            timedOut: anyAttemptTimedOut,
            ...(anyAttemptStalled ? { stalled: true } : {}),
            provider,
            assistantMessage,
            toolCalls,
          };
        } catch (err) {
          if (timedOut) {
            const timeoutErr = new Error(
              `OpenRouter call to ${opts.model} exceeded the per-call timeout of ${opts.timeoutMs}ms`,
            );
            (timeoutErr as Error & { timeout?: boolean }).timeout = true;
            throw timeoutErr;
          }
          if (stalled) {
            // Worded to match isTransientProviderFailure, like the ceiling timeout above: a silent
            // provider is a transport failure, not a judgement about the task.
            const stallErr = new Error(`OpenRouter call to ${opts.model} timed out: the model went silent (stalled)`);
            Object.assign(stallErr, { timeout: true, stalled: true });
            throw stallErr;
          }
          throw err;
        } finally {
          clearTimeout(timer);
          clearTimeout(stallTimer);
        }
      },
      {
        maxAttempts: 4,
        baseDelayMs: 800,
        delayFor: rateLimitDelay,
        onAttempt: (attempt, err) => {
          failedAttempts = attempt;
          if ((err as Error & { timeout?: boolean }).timeout) anyAttemptTimedOut = true;
          if ((err as Error & { stalled?: boolean }).stalled) anyAttemptStalled = true;
        },
        shouldRetry: retryPolicy(opts.model),
      },
    );
  }

  /**
   * One call to OpenRouter's Decisions API: typed questions over a state, answered with a
   * probability distribution instead of prose. Alpha, and not a chat endpoint, so it has its own URL
   * and shapes; retries, timeout and cost metering follow chatCompletion's rules.
   */
  async decide(opts: DecideOptions): Promise<DecisionResult> {
    let failedAttempts = 0;
    let anyAttemptTimedOut = false;
    return withRetry(
      async () => {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, opts.timeoutMs);
        try {
          const res = await fetch(OPENROUTER_DECISIONS_URL, {
            method: 'POST',
            signal: controller.signal,
            headers: this.headers(),
            body: JSON.stringify({ model: opts.model, state: opts.state, questions: opts.questions }),
          });
          if (!res.ok) {
            const body = await res.text();
            const err = new Error(`OpenRouter decisions ${res.status} for model ${opts.model}: ${body.slice(0, 500)}`);
            (err as Error & { status?: number }).status = res.status;
            throw err;
          }
          const json = (await res.json()) as DecisionsWire;
          if (json.error?.message) {
            const err = new Error(`OpenRouter returned an error for model ${opts.model}: ${json.error.message}`);
            (err as Error & { status?: number }).status = 500;
            throw err;
          }
          const answers = checkedAnswers(opts.questions, json.answers);
          const promptTokens = json.usage?.input_tokens ?? 0;
          const meteredCost = json.usage?.cost;
          const costMetered = typeof meteredCost === 'number' && Number.isFinite(meteredCost);
          return {
            answers,
            promptTokens,
            costUsd: costMetered ? meteredCost : (promptTokens / 1_000_000) * opts.modelEntry.inputPricePerMTok,
            costMetered,
            model: opts.model,
            attempts: failedAttempts + 1,
            timedOut: anyAttemptTimedOut,
            ...(typeof json.provider === 'string' ? { provider: json.provider } : {}),
          };
        } catch (err) {
          if (timedOut) {
            const timeoutErr = new Error(`OpenRouter call to ${opts.model} exceeded the per-call timeout of ${opts.timeoutMs}ms`);
            (timeoutErr as Error & { timeout?: boolean }).timeout = true;
            throw timeoutErr;
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }
      },
      {
        maxAttempts: 4,
        baseDelayMs: 800,
        onAttempt: (attempt, err) => {
          failedAttempts = attempt;
          if ((err as Error & { timeout?: boolean }).timeout) anyAttemptTimedOut = true;
        },
        shouldRetry: retryPolicy(opts.model),
      },
    );
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/dgcarr/political-swarm',
      'X-Title': 'political-swarm',
    };
  }

  // Fetches OpenRouter's full model catalog (pricing quoted per-token by the API,
  // normalized here to per-million-token to match ModelEntry). Public endpoint — the
  // API key is optional but sent anyway for consistency/quota attribution.
  async listModels(): Promise<CatalogModel[]> {
    const res = await fetch(OPENROUTER_MODELS_URL, {
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenRouter models catalog ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as {
      data: {
        id: string;
        name?: string;
        context_length?: number | null;
        created?: number;
        pricing?: { prompt?: string; completion?: string };
        supported_parameters?: string[];
      }[];
    };

    return json.data
      .filter((m) => m.pricing?.prompt !== undefined && m.pricing?.completion !== undefined)
      .map((m) => {
        const params = m.supported_parameters ?? [];
        return {
          id: m.id,
          name: m.name ?? m.id,
          contextLength: m.context_length ?? null,
          inputPricePerMTok: Number(m.pricing!.prompt) * 1_000_000,
          outputPricePerMTok: Number(m.pricing!.completion) * 1_000_000,
          supportsJsonMode: params.includes('response_format'),
          supportsToolCalls: params.includes('tools') || params.includes('tool_choice'),
          ...(typeof m.created === 'number' ? { createdAt: m.created } : {}),
        };
      });
  }
}

interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_details?: unknown[];
      tool_calls?: { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
    error?: { message?: string };
  }[];
  usage?: CompletionJson['usage'];
  error?: { message?: string; code?: number };
  provider?: unknown;
}

/**
 * Reassembles an OpenRouter server-sent-event stream into the body a non-streamed call returns,
 * calling `onProgress` for every chunk that carries a token. Lines starting with ':' are
 * OpenRouter's keep-alive comments and are deliberately not progress.
 */
export async function readCompletionStream(res: Response, onProgress: () => void): Promise<CompletionJson> {
  if (!res.body) throw new Error('OpenRouter returned a stream with no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let content = '';
  let sawContent = false;
  let finishReason: string | undefined;
  const toolCalls: { id?: string; type?: string; name: string; arguments: string }[] = [];
  const out: CompletionJson = {};

  const consume = (line: string): void => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    const chunk = JSON.parse(data) as StreamChunk;
    if (chunk.error) out.error = chunk.error;
    if (chunk.usage) out.usage = chunk.usage;
    if (chunk.provider !== undefined) out.provider = chunk.provider;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.error) out.choices = [{ error: choice.error }];
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) return;
    let progressed = false;
    if (delta.content) {
      content += delta.content;
      sawContent = true;
      progressed = true;
    }
    if (delta.reasoning || delta.reasoning_details?.length) progressed = true;
    for (const part of delta.tool_calls ?? []) {
      const slot = (toolCalls[part.index ?? 0] ??= { name: '', arguments: '' });
      if (part.id) slot.id = part.id;
      if (part.type) slot.type = part.type;
      if (part.function?.name) slot.name += part.function.name;
      if (part.function?.arguments) slot.arguments += part.function.arguments;
      progressed = true;
    }
    if (progressed) onProgress();
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      consume(buffered.slice(0, newline).trimEnd());
      buffered = buffered.slice(newline + 1);
    }
  }
  consume(buffered.trimEnd());

  if (out.error || out.choices?.[0]?.error) return out;
  out.choices = [{
    message: {
      content: sawContent ? content : null,
      ...(toolCalls.length
        ? {
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: call.type ?? 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    },
    ...(finishReason ? { finish_reason: finishReason } : {}),
  }];
  return out;
}

export function parseToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ToolCall[] => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const fn = record.function;
    if (typeof record.id !== 'string' || record.type !== 'function' || !fn || typeof fn !== 'object') return [];
    const functionRecord = fn as Record<string, unknown>;
    if (typeof functionRecord.name !== 'string' || typeof functionRecord.arguments !== 'string') return [];
    return [{
      id: record.id,
      type: 'function',
      function: { name: functionRecord.name, arguments: functionRecord.arguments },
    }];
  });
}
