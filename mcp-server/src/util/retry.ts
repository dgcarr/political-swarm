export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onAttempt?: (attempt: number, err: unknown) => void;
  /** A longer wait than the default backoff for this error, e.g. a rate limit's own Retry-After. */
  delayFor?: (err: unknown, attempt: number) => number | undefined;
}

const DEFAULT_CAUSE_CHAIN_DEPTH = 5;
const JITTER_LOWER_BOUND = 0.75;
const JITTER_RANGE = 0.5;

/**
 * Transport-level failures worth another attempt. These arrive with no HTTP status at all —
 * undici/Node reject with a bare `TypeError: fetch failed` or `TypeError: terminated` (socket
 * closed mid-response) and bury the real reason in a nested `cause` chain. A dropped socket is
 * exactly as transient as a 503, but because it carries no `status` the original status-only
 * check treated it as fatal, which is what killed long implementer calls mid-generation.
 */
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENETRESET',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** Message fragments for transport failures that surface without a machine-readable code. */
const TRANSIENT_MESSAGE_FRAGMENTS = ['terminated', 'fetch failed', 'socket hang up', 'network error', 'other side closed'];

/** Walks the `cause` chain (undici nests the real cause) collecting codes and messages. */
function errorChain(err: unknown, maxDepth = DEFAULT_CAUSE_CHAIN_DEPTH): { codes: string[]; message: string } {
  const codes: string[] = [];
  const messages: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < maxDepth && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'string') {
      messages.push(current);
      break;
    }
    if (typeof current !== 'object') break;
    const e = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === 'string') codes.push(e.code);
    if (typeof e.message === 'string') messages.push(e.message);
    current = e.cause;
  }
  return { codes, message: messages.join(' | ').toLowerCase() };
}

export function isTransientNetworkError(err: unknown): boolean {
  const { codes, message } = errorChain(err);
  if (codes.some((c) => TRANSIENT_ERROR_CODES.has(c))) return true;
  return TRANSIENT_MESSAGE_FRAGMENTS.some((fragment) => message.includes(fragment));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      opts.onAttempt?.(attempt, err);
      const canRetry = opts.shouldRetry ? opts.shouldRetry(err, attempt) : true;
      if (!canRetry || attempt === opts.maxAttempts) break;
      const backoff = opts.baseDelayMs * 2 ** (attempt - 1) * (JITTER_LOWER_BOUND + Math.random() * JITTER_RANGE);
      const delay = Math.max(backoff, opts.delayFor?.(err, attempt) ?? 0);
      await sleep(delay);
    }
  }
  throw lastErr;
}
