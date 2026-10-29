import { AudioTaskQueue } from '../src/audio/queue';
import { controllableFetch, flush, instantDecode, track, type FakeBuffer } from './queue-fixtures';

const statuses = (q: AudioTaskQueue<FakeBuffer>): string[] => q.getSnapshot().tasks.map((t) => t.status);
const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';

async function finish(r: ReturnType<typeof controllableFetch>, i: number, bytes = 2000): Promise<void> {
  r.request(i).respond({ contentLength: bytes });
  r.request(i).push(bytes);
  r.request(i).end();
  await flush();
}

describe('AudioTaskQueue: cancellation', () => {
  it('a cancelled QUEUED task never starts a request', async () => {
    const net = controllableFetch();
    const q = new AudioTaskQueue({ concurrency: 1, fetch: net.fetch, decode: instantDecode });
    q.add(track(1));
    const second = q.add(track(2));
    q.cancel(second.id);
    await finish(net, 0);
    expect(net.requests.map((r) => r.url)).toEqual(['/tracks/1.wav']);
    expect(statuses(q)).toEqual(['READY', 'CANCELLED']);
    await expect(second.done).rejects.toSatisfy(isAbort);
  });

  it('cancelling a download aborts its signal and hands the slot to the next FIFO task', async () => {
    const net = controllableFetch();
    const q = new AudioTaskQueue({ concurrency: 1, fetch: net.fetch, decode: instantDecode });
    const first = q.add(track(1));
    q.add(track(2));
    net.request(0).respond({ contentLength: 5000 });
    net.request(0).push(1000);
    await flush();
    q.cancel(first.id);
    await flush();
    expect(net.request(0).signal.aborted).toBe(true);
    expect(statuses(q)).toEqual(['CANCELLED', 'DOWNLOADING']); // not FAILED
    expect(net.requests).toHaveLength(2);
    await expect(first.done).rejects.toSatisfy(isAbort);
  });

  it('a decode that finishes after cancel is discarded (no buffer kept, promise not resolved)', async () => {
    const net = controllableFetch();
    let finishDecode!: (b: FakeBuffer) => void;
    const q = new AudioTaskQueue<FakeBuffer>({ fetch: net.fetch, decode: () => new Promise((r) => { finishDecode = r; }) });
    const task = q.add(track(1));
    await finish(net, 0);
    expect(statuses(q)).toEqual(['DECODING']);
    q.cancel(task.id);
    finishDecode({ duration: 5, bytes: 5 });
    await flush();
    expect(statuses(q)).toEqual(['CANCELLED']);
    expect(q.getSnapshot().buffersHeld).toBe(0);
    await expect(task.done).rejects.toSatisfy(isAbort);
  });

  it('cancelling READY or PLAYING tasks releases their buffers', async () => {
    const net = controllableFetch();
    const q = new AudioTaskQueue({ concurrency: 2, fetch: net.fetch, decode: instantDecode });
    const a = q.add(track(1));
    const b = q.add(track(2));
    await finish(net, 0);
    await finish(net, 1);
    q.take(a.id);
    expect(q.getSnapshot().buffersHeld).toBe(2);
    q.cancel(a.id);
    q.cancel(b.id);
    expect(q.getSnapshot().buffersHeld).toBe(0);
  });

  it('cancel is a no-op on terminal or unknown tasks, and the promise settles only once', async () => {
    const net = controllableFetch();
    const q = new AudioTaskQueue({ fetch: net.fetch, decode: instantDecode });
    const task = q.add(track(1));
    await finish(net, 0);
    q.take(task.id);
    q.complete(task.id);
    q.cancel(task.id);
    q.cancel('nope');
    expect(statuses(q)).toEqual(['PLAYED']);
    await expect(task.done).resolves.toEqual({ duration: 2, bytes: 2000 });
  });

  it('remove forgets a task; clearFinished keeps only unfinished ones', async () => {
    const net = controllableFetch();
    const q = new AudioTaskQueue({ concurrency: 1, fetch: net.fetch, decode: instantDecode });
    const a = q.add(track(1));
    const b = q.add(track(2));
    q.add(track(3));
    q.remove(b.id);
    expect(q.getSnapshot().tasks.map((t) => t.trackId)).toEqual(['t1', 't3']);
    q.cancel(a.id);
    await flush();
    q.clearFinished();
    expect(q.getSnapshot().tasks.map((t) => t.trackId)).toEqual(['t3']);
  });

  it('clear aborts every in-flight request and empties the queue', async () => {
    const net = controllableFetch();
    const q = new AudioTaskQueue({ concurrency: 3, fetch: net.fetch, decode: instantDecode });
    const tasks = [1, 2, 3, 4, 5].map((n) => q.add(track(n)));
    q.clear();
    await flush();
    expect(net.requests.every((r) => r.signal.aborted)).toBe(true);
    expect(net.requests).toHaveLength(3); // queued tasks never started
    expect(q.getSnapshot()).toMatchObject({ tasks: [], active: 0, buffersHeld: 0 });
    for (const t of tasks) await expect(t.done).rejects.toSatisfy(isAbort);
  });

  it('destroy drops subscribers so nothing retains the queue', () => {
    const net = controllableFetch();
    const q = new AudioTaskQueue({ fetch: net.fetch, decode: instantDecode });
    const listener = vi.fn();
    q.subscribe(listener);
    q.destroy();
    listener.mockClear();
    q.add(track(1));
    expect(listener).not.toHaveBeenCalled();
  });

  it('STRESS: random cancels never exceed the limit and every promise settles exactly once', async () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const net = controllableFetch();
    const q = new AudioTaskQueue({ concurrency: 2, fetch: net.fetch, decode: instantDecode });
    let peak = 0;
    q.subscribe((s) => { peak = Math.max(peak, s.active); });
    const settled = new Map<string, number>();
    const tasks = Array.from({ length: 30 }, (_, n) => q.add(track(n)));
    for (const t of tasks) {
      t.done.then(() => settled.set(t.id, (settled.get(t.id) ?? 0) + 1), () => settled.set(t.id, (settled.get(t.id) ?? 0) + 1));
    }

    for (let step = 0; step < 200 && q.getSnapshot().tasks.some((t) => t.status === 'QUEUED' || t.status === 'DOWNLOADING'); step++) {
      const open = net.requests.filter((r) => !r.signal.aborted);
      const pick = open[Math.floor(random() * open.length)];
      const live = q.getSnapshot().tasks.filter((t) => t.status === 'DOWNLOADING' || t.status === 'QUEUED');
      if (random() < 0.3 && live.length > 0) {
        q.cancel(live[Math.floor(random() * live.length)]?.id ?? '');
      } else if (pick !== undefined) {
        try {
          pick.respond({ contentLength: 10 });
          pick.push(10);
          pick.end();
        } catch { /* already responded */ }
      }
      await flush();
    }

    expect(peak).toBeLessThanOrEqual(2);
    expect(q.getSnapshot().tasks.every((t) => ['READY', 'CANCELLED'].includes(t.status))).toBe(true);
    expect([...settled.values()].every((n) => n === 1)).toBe(true);
    expect(settled.size).toBe(30);
    expect(q.getSnapshot().buffersHeld).toBe(q.getSnapshot().tasks.filter((t) => t.status === 'READY').length);
  });
});
