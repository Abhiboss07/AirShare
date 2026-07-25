/**
 * Async helpers: delay, deferred promises, and exponential backoff.
 *
 * Purpose: small, dependency-free primitives reused by the transport,
 * heartbeat and reconnection logic — no ad-hoc setTimeout math elsewhere.
 */

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface BackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  factor: number;
  jitter: number;
}

/**
 * Compute the delay for a given zero-based attempt using capped exponential
 * backoff with symmetric jitter. Pure function — trivially testable.
 */
export function computeBackoff(attempt: number, opts: BackoffOptions): number {
  const raw = opts.baseDelayMs * Math.pow(opts.factor, attempt);
  const capped = Math.min(raw, opts.maxDelayMs);
  const jitterSpan = capped * opts.jitter;
  const offset = (Math.random() * 2 - 1) * jitterSpan;
  return Math.max(0, Math.round(capped + offset));
}
