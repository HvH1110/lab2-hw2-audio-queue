// Audio queue engine contracts (written before any implementation).

// ---------------------------------------------------------------------------
// Task lifecycle (finite state machine)
// ---------------------------------------------------------------------------

export const TASK_STATUSES = ['QUEUED', 'DOWNLOADING', 'DECODING', 'READY', 'PLAYING', 'PLAYED', 'FAILED', 'CANCELLED'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskEvent = 'START' | 'DOWNLOADED' | 'DECODED' | 'PLAY' | 'FINISH' | 'FAIL' | 'CANCEL';

/** Statuses that never change again. */
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(['PLAYED', 'FAILED', 'CANCELLED']);

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export interface TrackInfo {
  readonly id: string;
  readonly title: string;
  readonly url: string;
}

/** Immutable view of one task, safe to hand to the UI. */
export interface TaskSnapshot {
  readonly id: string;
  readonly trackId: string;
  readonly title: string;
  readonly url: string;
  readonly status: TaskStatus;
  readonly receivedBytes: number;
  /** From Content-Length; null when the server does not send it. */
  readonly totalBytes: number | null;
  /** Seconds, known once decoded. */
  readonly duration: number | null;
  /** Human-readable failure reason. */
  readonly error: string | null;
  /** FIFO position: increases with every enqueue. */
  readonly sequence: number;
}

export interface QueueSnapshot {
  readonly tasks: readonly TaskSnapshot[];
  /** Tasks currently downloading or decoding. */
  readonly active: number;
  readonly concurrency: number;
  /** Decoded buffers still held in memory. */
  readonly buffersHeld: number;
}

/** The subset of AudioBuffer the queue needs, so tests can use plain objects. */
export interface DecodedAudio {
  readonly duration: number;
}

export type FetchLike = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;

export type DecodeFn<B extends DecodedAudio> = (data: ArrayBuffer, signal: AbortSignal) => Promise<B>;

export interface QueueOptions<B extends DecodedAudio> {
  /** Max tasks downloading/decoding at once (default 2). */
  readonly concurrency?: number;
  readonly fetch: FetchLike;
  readonly decode: DecodeFn<B>;
}

export type QueueListener = (snapshot: QueueSnapshot) => void;

// ---------------------------------------------------------------------------
// Web Audio subsets (structural, so a real AudioContext satisfies them)
// ---------------------------------------------------------------------------

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): void;
}

export interface SourceNodeLike<B> extends AudioNodeLike {
  buffer: B | null;
  onended: ((event: Event) => void) | null;
  start(when?: number, offset?: number): void;
  stop(when?: number): void;
}

export interface AnalyserLike extends AudioNodeLike {
  fftSize: number;
  readonly frequencyBinCount: number;
  smoothingTimeConstant: number;
  getByteFrequencyData(array: Uint8Array<ArrayBuffer>): void;
  getByteTimeDomainData(array: Uint8Array<ArrayBuffer>): void;
}

export interface GainLike extends AudioNodeLike {
  readonly gain: { value: number };
}

export interface AudioContextLike<B> {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: AudioNodeLike;
  createBufferSource(): SourceNodeLike<B>;
  createAnalyser(): AnalyserLike;
  createGain(): GainLike;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
}

export type FftSize = 256 | 512;

export type EngineStatus = 'IDLE' | 'PLAYING' | 'PAUSED';

export interface EngineSnapshot {
  readonly status: EngineStatus;
  readonly taskId: string | null;
  /** Source nodes that are alive (created and not yet cleaned up). Must stay ≤ 1. */
  readonly liveSources: number;
  readonly fftSize: FftSize;
  readonly volume: number;
}

// ---------------------------------------------------------------------------
// Visualizer
// ---------------------------------------------------------------------------

/** Injected so tests can drive frames by hand instead of waiting for the browser. */
export interface FrameScheduler {
  request(callback: (time: number) => void): number;
  cancel(handle: number): void;
}

export interface VisualizerStats {
  readonly running: boolean;
  readonly frames: number;
  /** Frames per second over the last second. */
  readonly fps: number;
  /** Times the frequency buffer was (re)allocated. Only grows when fftSize changes. */
  readonly bufferAllocations: number;
}
