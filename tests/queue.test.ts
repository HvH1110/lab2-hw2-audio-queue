import { AudioTaskQueue, describeTaskError, QueueError } from '../src/audio/queue';
import type { QueueSnapshot } from '../src/audio/types';
import { controllableFetch, flush, instantDecode, track, type FakeBuffer } from './queue-fixtures';

const statuses = (q: AudioTaskQueue<FakeBuffer>): string[] => q.getSnapshot().tasks.map((t) => t.status);

/** Finishes request `i` with `bytes` of body. */
async function finish(r: ReturnType<typeof controllableFetch>, i: number, bytes = 2000): Promise<void> {
  r.request(i).respond({ contentLength: bytes });
  r.request(i).push(bytes);
  r.request(i).end();
  await flush();
}

describe('AudioTaskQueue: FIFO + bounded concurrency', () => {
  it('starts at most `concurrency` tasks; the rest stay QUEUED', () => {
    const net = controllableFetch();
    const q = new AudioTaskQueue({ concurrency: 2, fetch: net.fetch, decode: instantDecode });
    for (let n = 1; n <= 5; n++) q.add(track(n));
    expect(statuses(q)).toEqual(['DOWNLOADING', 'DOWNLOADING', 'QUEUED', 'QUEUED', 'QUEUED']);
    expect(q.getSnapshot().active).toBe(2);
    expect(net.requests.map((r) => r.url)).toEqual(['/tracks/1.wav', '/tracks/2.wav']);
  });

  it('starts the oldest queued task whenever a slot frees up, even if a later one finishes first', async () => {
    const net = controllableFetch();
    const q = new AudioTaskQueue({ concurrency: 2, fetch: net.fetch, decode: instantDecode });
    for (let n = 1; n <= 4; n++) q.add(track(n));
    await finish(net, 1); // task 2 finishes before task 1
    expect(net.requests.map((r) => r.url)).toEqual(['/tracks/1.wav', '/tracks/2.wav', '/tracks/3.wav']);
    await finish(net, 0);
    expect(net.requests.map((r) => r.url)).toEqual(['/tracks/1.wav', '/tracks/2.wav', '/tracks/3.wav', '/tracks/4.wav']);
    expect(statuses(q)).toEqual(['READY', 'READY', 'DOWNLOADING', 'DOWNLOADING']);
  });

  it('never exceeds the concurrency limit across a whole run', async () => {
    const net = controllableFetch();
    const q = new AudioTaskQueue({ concurrency: 3, fetch: net.fetch, decode: instantDecode });
    let peak = 0;
    q.subscribe((s) => { peak = Math.max(peak, s.active); });
    for (let n = 1; n <= 8; n++) q.add(track(n));
    for (let i = 0; i < 8; i++) await finish(net, i);
    expect(peak).toBe(3);
    expect(statuses(q).every((s) => s === 'READY')).toBe(true);
  });

  it('concurrency 1 processes strictly one after another', async () => {
    const net = controllableFetch();
    const q = new AudioTaskQueue({ concurrency: 1, fetch: net.fetch, decode: instantDecode });
    q.add(track(1));
    q.add(track(2));
    expect(net.requests).toHaveLength(1);
    await finish(net, 0);
    expect(net.requests).toHaveLength(2);
  });

  it('raising the concurrency starts waiting tasks immediately', () => {
    const net = controllableFetch();
    const q = new AudioTaskQueue({ concurrency: 1, fetch: net.fetch, decode: instantDecode });
    for (let n = 1; n <= 4; n++) q.add(track(n));
    q.setConcurrency(3);
    expect(statuses(q)).toEqual(['DOWNLOADING', 'DOWNLOADING', 'DOWNLOADING', 'QUEUED']);
    q.setConcurrency(99);
    expect(q.getSnapshot().concurrency).toBe(6);
  });
});

describe('AudioTaskQueue: download, decode, results', () => {
  it('reports streamed byte progress against Content-Length', async () => {
    const net = controllableFetch();
    const q = new AudioTaskQueue({ fetch: net.fetch, decode: instantDecode });
    q.add(track(1));
    net.request(0).respond({ contentLength: 3000 });
    await flush();
    net.request(0).push(1000);
    await flush();
    expect(q.getSnapshot().tasks[0]).toMatchObject({ receivedBytes: 1000, totalBytes: 3000, status: 'DOWNLOADING' });
    net.request(0).push(2000);
    net.request(0).end();
    await flush();
    expect(q.getSnapshot().tasks[0]).toMatchObject({ receivedBytes: 3000, status: 'READY', duration: 3 });
  });

  it('passes through DECODING while the decoder runs', async () => {
    const net = controllableFetch();
    let finishDecode!: (b: FakeBuffer) => void;
    const q = new AudioTaskQueue<FakeBuffer>({
      fetch: net.fetch,
      decode: () => new Promise((resolve) => { finishDecode = resolve; }),
    });
    q.add(track(1));
    await finish(net, 0);
    expect(statuses(q)).toEqual(['DECODING']);
    expect(q.getSnapshot().active).toBe(1); // decoding still occupies the slot
    finishDecode({ duration: 9, bytes: 1 });
    await flush();
    expect(statuses(q)).toEqual(['READY']);
  });

  it('resolves `done` with the decoded buffer; `enqueue(url)` matches the slide contract', async () => {
    const net = controllableFetch();
    const q = new AudioTaskQueue({ fetch: net.fetch, decode: instantDecode });
    const buffer = q.enqueue('/tracks/x.wav');
    await finish(net, 0, 4000);
    await expect(buffer).resolves.toEqual({ duration: 4, bytes: 4000 });
  });

  it('fails a task on HTTP errors with a readable message, and keeps going', async () => {
    const net = controllableFetch();
    const q = new AudioTaskQueue({ concurrency: 1, fetch: net.fetch, decode: instantDecode });
    const missing = q.add(track(404));
    q.add(track(2));
    net.request(0).respond({ status: 404 });
    await flush();
    expect(q.getSnapshot().tasks[0]).toMatchObject({ status: 'FAILED', error: 'The server returned 404 for this track.' });
    await expect(missing.done).rejects.toBeInstanceOf(QueueError);
    expect(net.requests).toHaveLength(2); // the next task started
  });

  it('fails a task whose data cannot be decoded', async () => {
    const net = controllableFetch();
    const q = new AudioTaskQueue<FakeBuffer>({
      fetch: net.fetch,
      decode: () => Promise.reject(new DOMException('Unable to decode audio data', 'EncodingError')),
    });
    q.add(track(1));
    await finish(net, 0);
    expect(q.getSnapshot().tasks[0]).toMatchObject({ status: 'FAILED', error: 'The file could not be decoded (corrupt or unsupported format).' });
  });

  it('a network error fails the task', async () => {
    const net = controllableFetch();
    const q = new AudioTaskQueue({ fetch: net.fetch, decode: instantDecode });
    q.add(track(1));
    net.request(0).fail(new TypeError('Failed to fetch'));
    await flush();
    expect(q.getSnapshot().tasks[0]?.error).toBe('Network error while downloading.');
  });

  it('a failed task whose promise nobody awaits does not cause an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const net = controllableFetch();
    const q = new AudioTaskQueue({ fetch: net.fetch, decode: instantDecode });
    q.add(track(1));
    net.request(0).fail(new TypeError('Failed to fetch'));
    await flush();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe('AudioTaskQueue: playback hand-off', () => {
  it('take → PLAYING, complete → PLAYED and the buffer is dropped', async () => {
    const net = controllableFetch();
    const q = new AudioTaskQueue({ fetch: net.fetch, decode: instantDecode });
    const { id } = q.add(track(1));
    await finish(net, 0);
    expect(q.getSnapshot().buffersHeld).toBe(1);
    expect(q.take(id)).toEqual({ duration: 2, bytes: 2000 });
    expect(statuses(q)).toEqual(['PLAYING']);
    q.complete(id);
    expect(statuses(q)).toEqual(['PLAYED']);
    expect(q.getSnapshot().buffersHeld).toBe(0);
  });

  it('take on a task that is not READY throws (FSM guard)', () => {
    const net = controllableFetch();
    const q = new AudioTaskQueue({ fetch: net.fetch, decode: instantDecode });
    const { id } = q.add(track(1));
    expect(() => q.take(id)).toThrow(QueueError);
  });

  it('nextUp is the first unfinished task in FIFO order', async () => {
    const net = controllableFetch();
    const q = new AudioTaskQueue({ concurrency: 2, fetch: net.fetch, decode: instantDecode });
    const a = q.add(track(1));
    q.add(track(2));
    await finish(net, 1);
    expect(q.nextUp()?.id).toBe(a.id); // still downloading: the player must wait for it, not skip ahead
  });
});

describe('AudioTaskQueue: snapshots', () => {
  it('are frozen, replaced on change, and pushed to subscribers until unsubscribed', () => {
    const net = controllableFetch();
    const q = new AudioTaskQueue({ fetch: net.fetch, decode: instantDecode });
    const seen: QueueSnapshot[] = [];
    const unsubscribe = q.subscribe((s) => seen.push(s));
    const before = q.getSnapshot();
    q.add(track(1));
    expect(q.getSnapshot()).not.toBe(before);
    expect(Object.isFrozen(q.getSnapshot())).toBe(true);
    expect(Object.isFrozen(q.getSnapshot().tasks[0])).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    unsubscribe();
    const count = seen.length;
    q.add(track(2));
    expect(seen).toHaveLength(count);
  });
});

describe('describeTaskError', () => {
  it('never shows raw technical messages', () => {
    expect(describeTaskError(new Error('ECONNRESET at socket'))).toBe('Something went wrong while preparing this track.');
  });
});
