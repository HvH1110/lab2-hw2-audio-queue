import { abortableSleep, createThrottledFetch } from '../src/audio/throttled-fetch';
import type { FetchLike } from '../src/audio/types';

const base = (bytes: number, status = 200): FetchLike => async () =>
  new Response(status === 200 ? new Uint8Array(bytes) : null, { status, headers: { 'content-length': String(bytes) } });

async function readAll(response: Response, onChunk: (total: number) => void = () => {}): Promise<number> {
  const reader = response.body?.getReader();
  let total = 0;
  for (;;) {
    const result = await reader?.read();
    if (result === undefined || result.done) return total;
    total += result.value.byteLength;
    onChunk(total);
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createThrottledFetch', () => {
  it('delivers the body at the configured rate, in chunks', async () => {
    const fetch = createThrottledFetch(base(10_000), { bytesPerSecond: 5_000, chunkBytes: 1_000 });
    const response = await fetch('/x', { signal: new AbortController().signal });
    expect(response.headers.get('content-length')).toBe('10000');

    const progress: number[] = [];
    const done = readAll(response, (total) => progress.push(total));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(progress.at(-1)).toBe(5_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await done).toBe(10_000);
    expect(progress).toHaveLength(10);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for the latency before the response arrives', async () => {
    const fetch = createThrottledFetch(base(10), { bytesPerSecond: 1e9, latencyMs: 300 });
    let arrived = false;
    void fetch('/x', { signal: new AbortController().signal }).then(() => { arrived = true; });
    await vi.advanceTimersByTimeAsync(299);
    expect(arrived).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(arrived).toBe(true);
  });

  it('aborting during the latency rejects and clears the timer', async () => {
    const controller = new AbortController();
    const fetch = createThrottledFetch(base(10), { bytesPerSecond: 1, latencyMs: 5_000 });
    const result = fetch('/x', { signal: controller.signal }).catch((e: unknown) => e);
    controller.abort();
    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborting mid-body errors the stream and leaves no timers behind', async () => {
    const controller = new AbortController();
    const fetch = createThrottledFetch(base(10_000), { bytesPerSecond: 1_000, chunkBytes: 1_000 });
    const response = await fetch('/x', { signal: controller.signal });
    const reading = readAll(response).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_500);
    controller.abort();
    expect(await reading).toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes error responses through untouched', async () => {
    const fetch = createThrottledFetch(base(0, 404), { bytesPerSecond: 1 });
    const response = await fetch('/missing', { signal: new AbortController().signal });
    expect(response.status).toBe(404);
  });
});

describe('abortableSleep', () => {
  it('removes its abort listener when it resolves normally', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const sleeping = abortableSleep(100, controller.signal);
    await vi.advanceTimersByTimeAsync(100);
    await sleeping;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('rejects immediately for an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(100, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
