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
      const res = await doFetch(url, { ...init, signal: ctrl.signal });

      // Do not retry 4xx — client errors are not transient.
      // Do not retry 2xx/3xx — success or redirect.
      // Retry 5xx up to maxRetries.
      if (res.status >= 500) {
        lastError = new Error(`${url} → HTTP ${res.status}`);
        if (attempt < maxRetries) {
          continue; // retry
        }
        return res; // exhausted retries — return the 5xx response
      }

      return res;
    } catch (err) {
      // Check whether the abort was triggered by the external signal or our timeout.
      if (externalAborted) {
        // External abort is final — rethrow immediately, no retry.
        throw err;
      }

      if (timedOut) {
        lastError = new Error(`${url} → request timed out after ${timeoutMs}ms`);
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
      throw err;
    } finally {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  // Should not be reachable, but keeps TypeScript happy.
  throw lastError ?? new Error(`${url} → fetch failed`);
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
    throw new Error(`${url} → HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}
