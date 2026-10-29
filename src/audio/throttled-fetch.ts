import type { FetchLike } from './types';

export interface ThrottleOptions {
  /** Delivery rate of the body. */
  readonly bytesPerSecond: number;
  /** Delay before the response headers arrive. */
  readonly latencyMs?: number;
  /** Size of the slices the body is re-chunked into (smaller = smoother progress). */
  readonly chunkBytes?: number;
}

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');

/** setTimeout that rejects on abort and always cleans up its timer and listener. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Wraps a fetch so responses arrive late and bodies trickle in at `bytesPerSecond`. */
export function createThrottledFetch(base: FetchLike, options: ThrottleOptions): FetchLike {
  const { bytesPerSecond, latencyMs = 0, chunkBytes = 16 * 1024 } = options;

  return async (url, { signal }) => {
    if (latencyMs > 0) await abortableSleep(latencyMs, signal);
    const response = await base(url, { signal });
    if (response.body === null) return response;

    const reader = response.body.getReader();
    let pending: Uint8Array | null = null;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (pending === null || pending.byteLength === 0) {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            pending = value;
          }
          const slice: Uint8Array = pending.subarray(0, chunkBytes);
          pending = pending.subarray(slice.byteLength);
          await abortableSleep((slice.byteLength / bytesPerSecond) * 1000, signal);
          controller.enqueue(slice);
        } catch (error) {
          await reader.cancel(error).catch(() => {});
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });

    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
