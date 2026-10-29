import { isActive, transitionTask } from './task-state';
import { TERMINAL_STATUSES } from './types';
import type {
  DecodeFn,
  DecodedAudio,
  FetchLike,
  QueueListener,
  QueueOptions,
  QueueSnapshot,
  TaskEvent,
  TaskSnapshot,
  TaskStatus,
  TrackInfo,
} from './types';

interface InternalTask<B> {
  readonly id: string;
  readonly track: TrackInfo;
  readonly sequence: number;
  readonly controller: AbortController;
  readonly resolve: (buffer: B) => void;
  readonly reject: (reason: unknown) => void;
  status: TaskStatus;
  receivedBytes: number;
  totalBytes: number | null;
  duration: number | null;
  error: string | null;
  buffer: B | null;
}

export interface EnqueuedTask<B> {
  readonly id: string;
  /** Settles exactly once: the decoded buffer, or the failure/cancellation reason. */
  readonly done: Promise<B>;
}

export class QueueError extends Error {
  override readonly name = 'QueueError';
}

/** Human-readable reason for the UI; raw messages stay in the console. */
export function describeTaskError(error: unknown): string {
  if (error instanceof QueueError) return error.message;
  if (error instanceof DOMException && (error.name === 'EncodingError' || error.name === 'NotSupportedError')) {
    return 'The file could not be decoded (corrupt or unsupported format).';
  }
  if (error instanceof TypeError) return 'Network error while downloading.';
  return 'Something went wrong while preparing this track.';
}

const noop = (): void => {};
const MAX_CONCURRENCY = 6;

/**
 * FIFO concurrency controller for track downloads and decoding.
 * Tasks *start* strictly in enqueue order; at most `concurrency` are active at once.
 */
export class AudioTaskQueue<B extends DecodedAudio> {
  private readonly tasks: InternalTask<B>[] = [];
  private readonly listeners = new Set<QueueListener>();
  private readonly fetcher: FetchLike;
  private readonly decode: DecodeFn<B>;
  private concurrency: number;
  private sequence = 0;
  private snapshot: QueueSnapshot;

  constructor(options: QueueOptions<B>) {
    this.fetcher = options.fetch;
    this.decode = options.decode;
    this.concurrency = AudioTaskQueue.clampConcurrency(options.concurrency ?? 2);
    this.snapshot = this.buildSnapshot();
  }

  private static clampConcurrency(value: number): number {
    return Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(value)));
  }

  /** Slide contract: enqueue a URL and get its decoded buffer. */
  enqueue(trackUrl: string): Promise<B> {
    return this.add({ id: trackUrl, title: trackUrl, url: trackUrl }).done;
  }

  add(track: TrackInfo): EnqueuedTask<B> {
    const sequence = ++this.sequence;
    let resolve!: (buffer: B) => void;
    let reject!: (reason: unknown) => void;
    const done = new Promise<B>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    done.catch(noop); // callers may ignore the promise; a failure must not become an unhandled rejection

    const task: InternalTask<B> = {
      id: `task-${sequence}`,
      track,
      sequence,
      controller: new AbortController(),
      resolve,
      reject,
      status: 'QUEUED',
      receivedBytes: 0,
      totalBytes: null,
      duration: null,
      error: null,
      buffer: null,
    };
    this.tasks.push(task);
    this.emit();
    this.pump();
    return { id: task.id, done };
  }

  setConcurrency(value: number): void {
    this.concurrency = AudioTaskQueue.clampConcurrency(value);
    this.emit();
    this.pump();
  }

  /** READY → PLAYING. Returns the buffer to play. */
  take(id: string): B {
    const task = this.require(id);
    const buffer = task.buffer;
    if (buffer === null) throw new QueueError(`Task ${id} has no decoded buffer`);
    this.move(task, 'PLAY');
    return buffer;
  }

  /** PLAYING → PLAYED. The buffer is dropped: finished tracks never stay in memory. */
  complete(id: string): void {
    const task = this.require(id);
    this.move(task, 'FINISH');
    task.buffer = null;
    this.emit();
  }

  /**
   * Cancels a task in any non-terminal state: aborts its fetch/decode, drops its buffer,
   * rejects its promise with an AbortError and frees its slot for the next FIFO task.
   */
  cancel(id: string): void {
    const task = this.tasks.find((t) => t.id === id);
    if (task === undefined || !this.abortTask(task)) return;
    this.emit();
    this.pump();
  }

  /** Marks one task cancelled without starting anything else. Returns false if it was already finished. */
  private abortTask(task: InternalTask<B>): boolean {
    if (TERMINAL_STATUSES.has(task.status)) return false;
    task.status = transitionTask(task.status, 'CANCEL');
    task.controller.abort();
    task.buffer = null;
    task.reject(new DOMException('The task was cancelled.', 'AbortError'));
    return true;
  }

  /** Cancels (if needed) and forgets a task. */
  remove(id: string): void {
    this.cancel(id);
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index === -1) return;
    this.tasks.splice(index, 1);
    this.emit();
  }

  /** Forgets every finished (played, failed, cancelled) task. */
  clearFinished(): void {
    const keep = this.tasks.filter((t) => !TERMINAL_STATUSES.has(t.status));
    this.tasks.splice(0, this.tasks.length, ...keep);
    this.emit();
  }

  /** Cancels and forgets everything. */
  clear(): void {
    // Abort everything first: cancelling one by one would free slots and start queued tasks mid-clear.
    for (const task of this.tasks) this.abortTask(task);
    this.tasks.length = 0;
    this.emit();
  }

  /** clear() plus dropping every subscriber: nothing keeps the queue alive. */
  destroy(): void {
    this.clear();
    this.listeners.clear();
  }

  /** First unfinished task in FIFO order (what the player should play or wait for). */
  nextUp(): TaskSnapshot | undefined {
    return this.snapshot.tasks.find((t) => t.status === 'QUEUED' || isActive(t.status) || t.status === 'READY');
  }

  getSnapshot(): QueueSnapshot {
    return this.snapshot;
  }

  subscribe(listener: QueueListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -------------------------------------------------------------------------

  private require(id: string): InternalTask<B> {
    const task = this.tasks.find((t) => t.id === id);
    if (task === undefined) throw new QueueError(`Unknown task ${id}`);
    return task;
  }

  private move(task: InternalTask<B>, event: TaskEvent): void {
    task.status = transitionTask(task.status, event);
    this.emit();
  }

  private activeCount(): number {
    return this.tasks.filter((t) => isActive(t.status)).length;
  }

  /** Starts queued tasks, oldest first, while there is a free slot. */
  private pump(): void {
    while (this.activeCount() < this.concurrency) {
      const next = this.tasks.find((t) => t.status === 'QUEUED');
      if (next === undefined) return;
      void this.run(next);
    }
  }

  private async run(task: InternalTask<B>): Promise<void> {
    this.move(task, 'START');
    const { signal } = task.controller;
    try {
      const response = await this.fetcher(task.track.url, { signal });
      if (!response.ok) throw new QueueError(`The server returned ${response.status} for this track.`);
      const length = Number(response.headers.get('content-length'));
      task.totalBytes = Number.isFinite(length) && length > 0 ? length : null;

      const data = await this.readBody(response, task);
      this.move(task, 'DOWNLOADED');

      const buffer = await this.decode(data, signal);
      signal.throwIfAborted();
      task.buffer = buffer;
      task.duration = buffer.duration;
      this.move(task, 'DECODED');
      task.resolve(buffer);
    } catch (error) {
      if (task.status === 'CANCELLED') return; // cancel() already settled the promise
      task.error = describeTaskError(error);
      this.move(task, 'FAIL');
      task.reject(error);
    } finally {
      this.pump();
    }
  }

  /** Streams the body so download progress is observable byte by byte. */
  private async readBody(response: Response, task: InternalTask<B>): Promise<ArrayBuffer> {
    if (response.body === null) return response.arrayBuffer();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      task.receivedBytes += value.byteLength;
      this.emit();
    }
    const out = new Uint8Array(task.receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out.buffer;
  }

  private buildSnapshot(): QueueSnapshot {
    const tasks = this.tasks.map((t): TaskSnapshot => Object.freeze({
      id: t.id,
      trackId: t.track.id,
      title: t.track.title,
      url: t.track.url,
      status: t.status,
      receivedBytes: t.receivedBytes,
      totalBytes: t.totalBytes,
      duration: t.duration,
      error: t.error,
      sequence: t.sequence,
    }));
    return Object.freeze({
      tasks: Object.freeze(tasks),
      active: this.tasks.filter((t) => isActive(t.status)).length,
      concurrency: this.concurrency,
      buffersHeld: this.tasks.filter((t) => t.buffer !== null).length,
    });
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener(this.snapshot);
  }
}
