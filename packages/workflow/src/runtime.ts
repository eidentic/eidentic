/** Fail fast for numeric options that control loops, timers, leases, or allocation. */
export function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function abortError(): Error {
  const error = new Error("AbortError");
  error.name = "AbortError";
  return error;
}

/**
 * Abort-aware delay shared by retry implementations.
 *
 * The listener is removed on every settlement path, including normal timer
 * completion, so a long-lived parent signal does not retain one closure per
 * successful retry delay.
 */
export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = () => settle(() => reject(abortError()));

    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => settle(resolve), ms);
  });
}
