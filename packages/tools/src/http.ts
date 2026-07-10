export interface ResilientFetchOptions {
  /** Per-attempt timeout in ms. Default: 10_000. */
  timeoutMs?: number;
  /** Number of retries on 5xx or network error (not on 4xx, not on external abort). Default: 1. */
  retries?: number;
  /** External (agent) abort signal. When aborted, the in-flight request is cancelled immediately
   *  and the error is re-thrown without retrying. */
  signal?: AbortSignal;
  /** Fetch implementation. Defaults to globalThis.fetch. Useful in tests and edge runtimes. */
  fetchImpl?: typeof fetch;
  /** Called immediately before every network attempt. A rejection is fail-closed and is not retried. */
  beforeAttempt?: (attempt: number) => void | Promise<void>;
  /** Maximum decoded response bytes accepted by {@link fetchJson}. Default: 1 MiB. */
  maxResponseBytes?: number;
  /** Maximum time spent consuming a response body. Defaults to `timeoutMs` (or 10 seconds). */
  bodyTimeoutMs?: number;
}

export interface ReadResponseTextOptions {
  /** Maximum decoded bytes to buffer. */
  maxBytes: number;
  /** Return the prefix and mark it truncated instead of throwing when the cap is exceeded. */
  truncate?: boolean;
  /** Body-consumption timeout in milliseconds. Default: 10 seconds. */
  timeoutMs?: number;
  /** External cancellation signal. */
  signal?: AbortSignal;
}

/** Initiate response-body cancellation without allowing a hostile/stalled cancel hook to block. */
export function discardResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    void cancellation?.catch(() => undefined);
  } catch {
    // Cancellation is cleanup; never let it mask the policy/retry result.
  }
}

function safeUrlLabel(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "[invalid URL]";
  }
}

/**
 * fetch with a per-request timeout, retry on 5xx/network errors, and linked to an external abort
 * signal.
 *
 * Does NOT throw on non-2xx responses — it returns the Response and lets the caller decide.
 * Throws an AbortError when the external signal is aborted (no retry).
 * Throws a descriptive Error after exhausting retries on timeout or network failure.
 */
export async function resilientFetch(
  url: string,
  init?: RequestInit,
  opts?: ResilientFetchOptions,
): Promise<Response> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const maxRetries = opts?.retries ?? 1;
  const externalSignal = opts?.signal;
  const doFetch = opts?.fetchImpl ?? globalThis.fetch;
  const beforeAttempt = opts?.beforeAttempt;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("resilientFetch: timeoutMs must be a positive number");
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error("resilientFetch: retries must be a non-negative safe integer");
  }

  // Abort immediately if external signal is already aborted before we start.
  if (externalSignal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Per-attempt abort controller: merges our timeout with the external signal.
    const ctrl = new AbortController();

    let timedOut = false;
    let externalAborted = false;
    let preflightFailed = false;

    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);

    const onExternalAbort = () => {
      externalAborted = true;
      ctrl.abort();
    };

    if (externalSignal) {
      // If aborted between the check above and now, handle immediately.
      if (externalSignal.aborted) {
        clearTimeout(timer);
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      externalSignal.addEventListener("abort", onExternalAbort);
    }

    try {
      if (beforeAttempt) {
        try {
          await raceWithAbort(beforeAttempt(attempt), ctrl.signal);
        } catch (error) {
          preflightFailed = !ctrl.signal.aborted;
          throw error;
        }
      }
      const res = await doFetch(url, { ...init, signal: ctrl.signal });

      // Do not retry 4xx — client errors are not transient.
      // Do not retry 2xx/3xx — success or redirect.
      // Retry 5xx up to maxRetries.
      if (res.status >= 500) {
        lastError = new Error(`${safeUrlLabel(url)} → HTTP ${res.status}`);
        if (attempt < maxRetries) {
          // A response that is abandoned without consumption/cancellation can retain a socket
          // and its buffered body. Release it before opening the retry attempt.
          discardResponseBody(res);
          continue; // retry
        }
        return res; // exhausted retries — return the 5xx response
      }

      return res;
    } catch (err) {
      if (preflightFailed) throw err;
      // Check whether the abort was triggered by the external signal or our timeout.
      if (externalAborted) {
        // External abort is final — rethrow immediately, no retry.
        throw err;
      }

      if (timedOut) {
        lastError = new Error(`${safeUrlLabel(url)} → request timed out after ${timeoutMs}ms`);
        if (attempt < maxRetries) {
          continue; // timeout may be retried
        }
        throw lastError;
      }

      // Network-level error (not abort-related).
      lastError = err;
      if (attempt < maxRetries) {
        continue;
      }
      throw new Error(`${safeUrlLabel(url)} → network request failed`, { cause: err });
    } finally {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  // Should not be reachable, but keeps TypeScript happy.
  throw lastError ?? new Error(`${safeUrlLabel(url)} → fetch failed`);
}

function raceWithAbort<T>(value: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => { cleanup(); resolve(result); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

/**
 * Consume a response stream with a decoded-byte budget, timeout and cancellation.
 * The byte cap applies to the stream exposed by `fetch` (therefore after HTTP decompression).
 */
export async function readResponseText(
  response: Response,
  options: ReadResponseTextOptions,
): Promise<{ text: string; truncated: boolean; bytesRead: number }> {
  const maxBytes = options.maxBytes;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("readResponseText: maxBytes must be a non-negative safe integer");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("readResponseText: timeoutMs must be a positive number");
  }
  if (options.signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
  if (!response.body) return { text: "", truncated: false, bytesRead: 0 };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let interruptReject: ((error: unknown) => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    interruptReject = reject;
  });
  const onAbort = () => {
    interruptReject?.(new DOMException("The operation was aborted.", "AbortError"));
    void reader.cancel().catch(() => undefined);
  };
  const timer = setTimeout(() => {
    interruptReject?.(new Error(`response body timed out after ${timeoutMs}ms`));
    void reader.cancel().catch(() => undefined);
  }, timeoutMs);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      if (total + value.byteLength > maxBytes) {
        const remaining = Math.max(0, maxBytes - total);
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        total += remaining;
        void reader.cancel().catch(() => undefined);
        if (!options.truncate) {
          throw new Error(`response body exceeds ${maxBytes} byte limit`);
        }
        return {
          text: decodeChunks(chunks, total),
          truncated: true,
          bytesRead: total,
        };
      }

      chunks.push(value);
      total += value.byteLength;
    }

    return { text: decodeChunks(chunks, total), truncated: false, bytesRead: total };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* reader may already be released */ }
  }
}

function decodeChunks(chunks: Uint8Array[], total: number): string {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

/**
 * resilientFetch + throws on non-2xx (naming url + status) + returns parsed JSON.
 */
export async function fetchJson<T = unknown>(
  url: string,
  init?: RequestInit,
  opts?: ResilientFetchOptions,
): Promise<T> {
  const res = await resilientFetch(url, init, opts);
  if (!res.ok) {
    throw new Error(`${safeUrlLabel(url)} → HTTP ${res.status}`);
  }
  const body = await readResponseText(res, {
    maxBytes: opts?.maxResponseBytes ?? 1024 * 1024,
    timeoutMs: opts?.bodyTimeoutMs ?? opts?.timeoutMs ?? 10_000,
    signal: opts?.signal,
  });
  return JSON.parse(body.text) as T;
}
