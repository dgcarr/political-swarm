import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterClient, parseToolCalls, rateLimitDelay, type OpenRouterCallOptions } from './OpenRouterClient.js';

function callOptions(timeoutMs = 1_000): OpenRouterCallOptions {
  return {
    model: 'test/model',
    modelEntry: {
      inputPricePerMTok: 1,
      outputPricePerMTok: 2,
      supportsJsonMode: true,
      supportsToolCalls: false,
    },
    messages: [{ role: 'user', content: 'Hello' }],
    timeoutMs,
  };
}

function successResponse(provider?: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      ...(provider !== undefined ? { provider } : {}),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OpenRouterClient.chatCompletion', () => {
  it('reports one attempt, no timeout, and no provider when the first request succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await new OpenRouterClient('test-key').chatCompletion(callOptions());

    expect(result).toMatchObject({ attempts: 1, timedOut: false });
    expect(result.provider).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports two attempts when a 500 response is followed by success', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('upstream failure', { status: 500 }))
      .mockResolvedValueOnce(successResponse());
    vi.stubGlobal('fetch', fetchMock);

    const completion = new OpenRouterClient('test-key').chatCompletion(callOptions());
    await vi.runAllTimersAsync();

    await expect(completion).resolves.toMatchObject({ attempts: 2, timedOut: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // "temporarily rate-limited upstream" outlasted four attempts spent in about six seconds, and
  // took the task down with it on the fallback model.
  it('waits out a rate limit instead of spending its retries in seconds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate-limited upstream', { status: 429 }))
      .mockResolvedValueOnce(new Response('rate-limited upstream', { status: 429, headers: { 'Retry-After': '20' } }))
      .mockResolvedValueOnce(successResponse());
    vi.stubGlobal('fetch', fetchMock);

    const completion = new OpenRouterClient('test-key').chatCompletion(callOptions());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(completion).resolves.toMatchObject({ attempts: 3 });
  });

  it('retries without JSON mode once the provider refuses it', async () => {
    vi.useFakeTimers();
    const refused = new Response(JSON.stringify({
      error: { message: "Upstream error from Groq: Failed to generate JSON. Please adjust your prompt." },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const fetchMock = vi.fn().mockResolvedValueOnce(refused).mockResolvedValueOnce(successResponse());
    vi.stubGlobal('fetch', fetchMock);

    const completion = new OpenRouterClient('test-key').chatCompletion({ ...callOptions(), jsonMode: true });
    await vi.runAllTimersAsync();

    await expect(completion).resolves.toMatchObject({ attempts: 2 });
    const body = (call: number) => JSON.parse(fetchMock.mock.calls[call]![1].body as string);
    expect(body(0).response_format).toEqual({ type: 'json_object' });
    expect(body(1).response_format).toBeUndefined();
  });

  it('applies the long wait only to rate limits, capped', () => {
    expect(rateLimitDelay({ status: 500 }, 1)).toBeUndefined();
    expect(rateLimitDelay({ status: 429 }, 1)).toBe(4_000);
    expect(rateLimitDelay({ status: 429 }, 3)).toBe(16_000);
    expect(rateLimitDelay({ status: 429, retryAfterMs: 120_000 }, 1)).toBe(30_000);
  });

  it('throws a marked timeout without retrying when the per-call timer expires', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const completion = new OpenRouterClient('test-key').chatCompletion(callOptions(25));
    const rejection = expect(completion).rejects.toMatchObject({ timeout: true });
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports the provider when OpenRouter includes it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successResponse('Test Provider')));

    const result = await new OpenRouterClient('test-key').chatCompletion(callOptions());

    expect(result.provider).toBe('Test Provider');
  });

  it('passes an explicit reasoning tier to the provider request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse());
    vi.stubGlobal('fetch', fetchMock);

    await new OpenRouterClient('test-key').chatCompletion({ ...callOptions(), reasoningEffort: 'low' });

    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string))
      .toMatchObject({ reasoning_effort: 'low' });
  });
});

/**
 * A server-sent-event response whose lines the test pushes on its own schedule. Aborting the
 * request errors the body, as undici does.
 */
function scriptedStream(init?: RequestInit) {
  let push!: (line: string) => void;
  let end!: () => void;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (line) => {
        // A model keeps talking after the client has hung up; that must not throw in the test.
        if (!init?.signal?.aborted) controller.enqueue(encoder.encode(`${line}\n\n`));
      };
      end = () => controller.close();
      init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
    },
  });
  const response = new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  return { response, push, end };
}

const token = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`;
const STALL = { firstTokenMs: 60, betweenTokensMs: 30 };

/** Stubs fetch with one scripted stream per call and returns the handles in call order. */
function stubStreams() {
  const streams: ReturnType<typeof scriptedStream>[] = [];
  const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const stream = scriptedStream(init);
    streams.push(stream);
    return stream.response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { streams, fetchMock };
}

describe('OpenRouterClient.chatCompletion with stall detection', () => {
  it('reassembles a stream, ignoring keep-alive comments, and asks for one', async () => {
    const { streams, fetchMock } = stubStreams();
    const completion = new OpenRouterClient('k').chatCompletion({ ...callOptions(10_000), stallTimeout: STALL });
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    const s = streams[0];
    s.push(': OPENROUTER PROCESSING');
    s.push(`data: ${JSON.stringify({ provider: 'Upstage', choices: [{ delta: { role: 'assistant', content: '' } }] })}`);
    s.push(token('{"ok":'));
    s.push(token('true}'));
    s.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3, cost: 0.0004 } })}`);
    s.push('data: [DONE]');
    s.end();

    const result = await completion;
    expect(result).toMatchObject({ text: '{"ok":true}', promptTokens: 7, completionTokens: 3, costUsd: 0.0004, costMetered: true, provider: 'Upstage', timedOut: false });
    expect(result.stalled).toBeUndefined();
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({ stream: true });
  });

  it('gives up when no token arrives, however many keep-alives do', async () => {
    vi.useFakeTimers();
    const { streams, fetchMock } = stubStreams();
    const completion = new OpenRouterClient('k').chatCompletion({ ...callOptions(10_000), stallTimeout: STALL });
    const rejection = expect(completion).rejects.toMatchObject({ timeout: true, stalled: true });
    await vi.advanceTimersByTimeAsync(0);
    for (let elapsed = 0; elapsed < 60; elapsed += 20) {
      streams[0].push(': OPENROUTER PROCESSING');
      await vi.advanceTimersByTimeAsync(20);
    }
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up when a stream goes silent mid-answer', async () => {
    vi.useFakeTimers();
    const { streams } = stubStreams();
    const completion = new OpenRouterClient('k').chatCompletion({ ...callOptions(10_000), stallTimeout: STALL });
    const rejection = expect(completion).rejects.toThrow(/timed out: the model went silent/);
    await vi.advanceTimersByTimeAsync(0);
    streams[0].push(token('{"partial":'));
    await vi.advanceTimersByTimeAsync(30);
    await rejection;
  });

  it('never cuts off a slow model that keeps producing tokens', async () => {
    vi.useFakeTimers();
    const { streams } = stubStreams();
    const completion = new OpenRouterClient('k').chatCompletion({ ...callOptions(10_000), stallTimeout: STALL });
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 20; i += 1) {
      streams[0].push(token('x'));
      await vi.advanceTimersByTimeAsync(25);
    }
    streams[0].push('data: [DONE]');
    streams[0].end();
    // 550ms in all: well past either stall limit, never silent for longer than one of them.
    await expect(completion).resolves.toMatchObject({ text: 'x'.repeat(20), timedOut: false });
  });

  it('still enforces the ceiling on a model that never stops', async () => {
    vi.useFakeTimers();
    const { streams } = stubStreams();
    const completion = new OpenRouterClient('k').chatCompletion({ ...callOptions(100), stallTimeout: STALL });
    const rejection = expect(completion).rejects.toThrow(/exceeded the per-call timeout of 100ms/);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 6; i += 1) {
      streams[0].push(token('x'));
      await vi.advanceTimersByTimeAsync(20);
    }
    await rejection;
  });

  it('retries a provider error reported mid-stream', async () => {
    const { streams, fetchMock } = stubStreams();
    const completion = new OpenRouterClient('k').chatCompletion({ ...callOptions(10_000), stallTimeout: STALL });
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0].push(token('{"ha'));
    streams[0].push(`data: ${JSON.stringify({ error: { message: 'upstream overloaded', code: 502 }, choices: [{ delta: {}, finish_reason: 'error' }] })}`);
    streams[0].end();
    await vi.waitFor(() => expect(streams).toHaveLength(2), { timeout: 5_000 });
    streams[1].push(token('{"ok":true}'));
    streams[1].end();

    await expect(completion).resolves.toMatchObject({ text: '{"ok":true}', attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('assembles tool calls streamed in fragments', async () => {
    const { streams } = stubStreams();
    const completion = new OpenRouterClient('k').chatCompletion({ ...callOptions(10_000), stallTimeout: STALL });
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    const call = (fn: Record<string, string>, extra: Record<string, unknown> = {}) =>
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...extra, function: fn }] } }] })}`;
    streams[0].push(call({ name: 'read_repository_file', arguments: '{"pa' }, { id: 'c1', type: 'function' }));
    streams[0].push(call({ arguments: 'th":"a.py"}' }));
    streams[0].end();

    const result = await completion;
    expect(result.toolCalls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'read_repository_file', arguments: '{"path":"a.py"}' } },
    ]);
    expect(result.assistantMessage?.content).toBeNull();
  });
});

describe('parseToolCalls', () => {
  it('preserves multiple valid function calls and ignores malformed entries', () => {
    expect(parseToolCalls([
      { id: 'one', type: 'function', function: { name: 'read_repository_file', arguments: '{"path":"a"}' } },
      { id: 'bad', type: 'function', function: { name: 3, arguments: '{}' } },
      { id: 'two', type: 'function', function: { name: 'search_repository', arguments: '{"query":"x"}' } },
    ])).toHaveLength(2);
  });
});

describe('OpenRouterClient.decide', () => {
  const ballot = {
    type: 'choice' as const,
    instructions: 'Cast one ballot.',
    criteria: { alice: 'Vote for alice.', bob: 'Vote for bob.', abstain: 'Object to every candidate.' },
  };
  const decideOptions = (timeoutMs = 1_000) => ({
    model: 'upstage/solar-decide',
    modelEntry: { inputPricePerMTok: 0.1, outputPricePerMTok: 0, supportsJsonMode: false, supportsToolCalls: false },
    state: { candidates: ['alice', 'bob'] },
    questions: { ballot },
    timeoutMs,
  });
  const answered = (choice = 'alice', extra: Record<string, unknown> = {}) => new Response(JSON.stringify({
    model: 'upstage/solar-decide-20260928',
    provider: 'Upstage',
    answers: { ballot: { type: 'choice', choice, confidence: 0.9, probabilities: { alice: 0.95, bob: 0.04, abstain: 0.01 } } },
    usage: { input_tokens: 900, output_tokens: 2, cost: 0.00009 },
    ...extra,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  it('posts typed questions to the Decisions API and returns the distribution with metered cost', async () => {
    const fetchMock = vi.fn().mockResolvedValue(answered());
    vi.stubGlobal('fetch', fetchMock);

    const result = await new OpenRouterClient('k').decide(decideOptions());

    expect(fetchMock.mock.calls[0][0]).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      model: 'upstage/solar-decide', state: { candidates: ['alice', 'bob'] }, questions: { ballot },
    });
    expect(result).toMatchObject({
      answers: { ballot: { choice: 'alice', probabilities: { alice: 0.95 } } },
      promptTokens: 900, costUsd: 0.00009, costMetered: true, provider: 'Upstage', attempts: 1, timedOut: false,
    });
  });

  it('retries a provider failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('overloaded', { status: 503 }))
      .mockResolvedValueOnce(answered());
    vi.stubGlobal('fetch', fetchMock);

    await expect(new OpenRouterClient('k').decide(decideOptions())).resolves.toMatchObject({ attempts: 2 });
  });

  it('rejects an answer that picks something it was not offered', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answered('carol')));
    await expect(new OpenRouterClient('k').decide(decideOptions())).rejects.toThrow(/chose "carol", which was not offered/);
  });

  it('throws a marked timeout without retrying', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const rejection = expect(new OpenRouterClient('k').decide(decideOptions(25))).rejects.toMatchObject({ timeout: true });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
