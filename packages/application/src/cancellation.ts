/** Bound read-only RPCs whose provider has no native cancellation API. */
export function withSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    // Attach handlers even when already aborted, so a late provider rejection is consumed.
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
  });
}
