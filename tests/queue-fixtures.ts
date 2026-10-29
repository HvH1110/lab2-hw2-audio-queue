import type { FetchLike } from '../src/audio/types';

export interface FakeBuffer {
  readonly duration: number;
  readonly bytes: number;
}

export interface PendingRequest {
  readonly url: string;
  readonly signal: AbortSignal;
  /** Responds with headers; the body stays open until `push`/`end`. */
  respond(init?: { status?: number; contentLength?: number | null }): void;
  push(bytes: number): void;
  end(): void;
  fail(error: unknown): void;
}

/** A fetch whose every request is settled by hand, in any order. */
export function controllableFetch() {
  const requests: PendingRequest[] = [];
  const fetch: FetchLike = (url, { signal }) =>
    new Promise<Response>((resolve, reject) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
      const onAbort = (): void => {
        const reason = new DOMException('The operation was aborted.', 'AbortError');
        reject(reason);
        try { controller.error(reason); } catch { /* already closed */ }
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      requests.push({
        url,
        signal,
        respond: ({ status = 200, contentLength = null } = {}) => {
          const headers = new Headers();
          if (contentLength !== null) headers.set('content-length', String(contentLength));
          resolve(new Response(status === 200 ? body : null, { status, headers }));
        },
        push: (bytes) => controller.enqueue(new Uint8Array(bytes).fill(7)),
        end: () => controller.close(),
        fail: (error) => reject(error),
      });
    });

  const request = (i: number): PendingRequest => {
    const r = requests[i];
    if (r === undefined) throw new Error(`no request #${i} (have ${requests.length})`);
    return r;
  };
  return { fetch, requests, request };
}

/** Decoder that resolves immediately: 1 second of audio per 1000 bytes. */
export const instantDecode = async (data: ArrayBuffer): Promise<FakeBuffer> => ({ duration: data.byteLength / 1000, bytes: data.byteLength });

/** Lets promise chains (fetch → read → decode) run to completion. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

export const track = (n: number) => ({ id: `t${n}`, title: `Track ${n}`, url: `/tracks/${n}.wav` });
