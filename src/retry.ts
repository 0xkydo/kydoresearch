export type RetryDelay = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface RetryPolicy {
  /** Total calls, including the first call. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RetryNotice<T> {
  attempt: number;
  maxAttempts: number;
  nextDelayMs: number;
  error?: unknown;
  value?: T;
}

export interface RetryOptions<T> extends RetryPolicy {
  operation: (attempt: number) => Promise<T>;
  isSuccess?: (value: T) => boolean;
  signal?: AbortSignal;
  delay?: RetryDelay;
  onRetry?: (notice: RetryNotice<T>) => void | Promise<void>;
}

/**
 * Retry an operation with bounded exponential backoff.
 *
 * A final non-success value is returned to the caller so result-bearing ports
 * (verify, benchmark, submit) keep their diagnostics. A final thrown error is
 * rethrown. Abort never starts another attempt.
 */
export async function retryOperation<T>(options: RetryOptions<T>): Promise<T> {
  const maxAttempts = Number.isFinite(options.maxAttempts)
    ? Math.max(1, Math.floor(options.maxAttempts))
    : 1;
  const isSuccess = options.isSuccess ?? (() => true);
  let lastValue: T | undefined;
  let hasValue = false;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      if (hasValue) return lastValue as T;
      throw abortError();
    }

    try {
      const value = await options.operation(attempt);
      lastValue = value;
      hasValue = true;
      lastError = undefined;
      if (isSuccess(value) || attempt === maxAttempts || options.signal?.aborted) return value;
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || options.signal?.aborted) throw error;
    }

    const nextDelayMs = retryBackoffMs(
      options.baseDelayMs,
      options.maxDelayMs,
      attempt,
    );
    await options.onRetry?.({
      attempt,
      maxAttempts,
      nextDelayMs,
      ...(lastError === undefined ? { value: lastValue } : { error: lastError }),
    });
    await (options.delay ?? abortableDelay)(nextDelayMs, options.signal);
  }

  // The loop always returns or throws. Keep this guard for type safety.
  if (hasValue) return lastValue as T;
  throw lastError ?? new Error("Retry operation ended without a result");
}

/** failedAttempt=1 waits baseDelayMs before attempt 2. */
export function retryBackoffMs(
  baseDelayMs: number,
  maxDelayMs: number,
  failedAttempt: number,
): number {
  const base = Math.max(0, Number.isFinite(baseDelayMs) ? baseDelayMs : 0);
  const cap = Math.max(base, Number.isFinite(maxDelayMs) ? maxDelayMs : base);
  return Math.min(cap, base * 2 ** Math.max(0, failedAttempt - 1));
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}
