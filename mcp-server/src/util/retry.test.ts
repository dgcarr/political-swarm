import { describe, it, expect } from 'vitest';
import { isTransientNetworkError, withRetry } from './retry.js';

describe('isTransientNetworkError', () => {
  it('treats the bare "terminated" TypeError as transient', () => {
    // This is the exact shape that aborted a benchmark implementer call mid-generation.
    expect(isTransientNetworkError(new TypeError('terminated'))).toBe(true);
  });

  it('treats "fetch failed" as transient', () => {
    expect(isTransientNetworkError(new TypeError('fetch failed'))).toBe(true);
  });

  it('detects a transient code nested in the cause chain', () => {
    const err = new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it('detects undici body/headers timeout codes', () => {
    expect(isTransientNetworkError(Object.assign(new Error('x'), { code: 'UND_ERR_BODY_TIMEOUT' }))).toBe(true);
    expect(isTransientNetworkError(Object.assign(new Error('x'), { code: 'UND_ERR_HEADERS_TIMEOUT' }))).toBe(true);
  });

  it('does not treat a validation or programming error as transient', () => {
    expect(isTransientNetworkError(new Error('Planner response must be a non-empty JSON array'))).toBe(false);
    expect(isTransientNetworkError(new TypeError('x.map is not a function'))).toBe(false);
  });

  it('handles null, undefined, and plain strings without throwing', () => {
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
    expect(isTransientNetworkError('socket hang up')).toBe(true);
  });

  it('does not loop forever on a self-referential cause chain', () => {
    const err = new Error('boom') as Error & { cause?: unknown };
    err.cause = err;
    expect(isTransientNetworkError(err)).toBe(false);
  });
});

describe('withRetry', () => {
  it('retries until success and returns the value', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new TypeError('terminated');
        return 'ok';
      },
      { maxAttempts: 4, baseDelayMs: 1 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('stops immediately when shouldRetry returns false', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('fatal');
        },
        { maxAttempts: 5, baseDelayMs: 1, shouldRetry: () => false },
      ),
    ).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error(`attempt ${calls}`);
        },
        { maxAttempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('attempt 3');
    expect(calls).toBe(3);
  });

  it('reports each failed attempt with its attempt number and error', async () => {
    const firstError = new Error('first');
    const secondError = new Error('second');
    const observed: Array<[number, unknown]> = [];
    let calls = 0;

    await expect(
      withRetry(
        async () => {
          calls += 1;
          if (calls === 1) throw firstError;
          if (calls === 2) throw secondError;
          return 'ok';
        },
        {
          maxAttempts: 3,
          baseDelayMs: 0,
          onAttempt: (attempt, err) => observed.push([attempt, err]),
        },
      ),
    ).resolves.toBe('ok');

    expect(observed).toEqual([
      [1, firstError],
      [2, secondError],
    ]);
  });

  it('does not report an attempt when the first call succeeds', async () => {
    const observed: Array<[number, unknown]> = [];

    await expect(
      withRetry(async () => 'ok', {
        maxAttempts: 3,
        baseDelayMs: 0,
        onAttempt: (attempt, err) => observed.push([attempt, err]),
      }),
    ).resolves.toBe('ok');

    expect(observed).toEqual([]);
  });
});
