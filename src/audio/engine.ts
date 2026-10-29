import type { AnalyserLike, AudioContextLike, EngineSnapshot, EngineStatus, FftSize, GainLike, SourceNodeLike } from './types';

export interface EngineOptions {
  readonly fftSize?: FftSize;
  readonly volume?: number;
  /** Called when a track plays to its natural end (not when it is stopped). */
  readonly onEnded?: (taskId: string) => void;
}

/**
 * Playback graph:  source ──► gain ──► analyser ──► destination
 * One source at a time. Sources are single-use and fully cleaned up when they end or are stopped.
 */
export class AudioEngine<B> {
  readonly analyser: AnalyserLike;
  private readonly ctx: AudioContextLike<B>;
  private readonly gain: GainLike;
  private readonly listeners = new Set<(snapshot: EngineSnapshot) => void>();
  private readonly onEnded: ((taskId: string) => void) | undefined;
  private source: SourceNodeLike<B> | null = null;
  private status: EngineStatus = 'IDLE';
  private taskId: string | null = null;
  private liveSources = 0;
  private playToken = 0;
  private snapshot: EngineSnapshot;

  constructor(ctx: AudioContextLike<B>, options: EngineOptions = {}) {
    this.ctx = ctx;
    this.onEnded = options.onEnded;
    this.gain = ctx.createGain();
    this.gain.gain.value = clampVolume(options.volume ?? 0.8);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = options.fftSize ?? 512;
    this.analyser.smoothingTimeConstant = 0.8;
    this.gain.connect(this.analyser);
    this.analyser.connect(ctx.destination);
    this.snapshot = this.build();
  }

  async play(taskId: string, buffer: B): Promise<void> {
    const token = ++this.playToken;
    this.releaseSource();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (token !== this.playToken) return; // a newer play()/stop() won while we awaited

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.onended = () => {
      if (this.source !== source) return;
      this.releaseSource();
      this.setState('IDLE', null);
      this.onEnded?.(taskId);
    };
    this.source = source;
    this.liveSources++;
    source.start();
    this.setState('PLAYING', taskId);
  }

  stop(): void {
    this.playToken++;
    this.releaseSource();
    this.setState('IDLE', null);
  }

  async pause(): Promise<void> {
    if (this.status !== 'PLAYING') return;
    await this.ctx.suspend();
    this.setState('PAUSED', this.taskId);
  }

  async resume(): Promise<void> {
    if (this.status !== 'PAUSED') return;
    await this.ctx.resume();
    this.setState('PLAYING', this.taskId);
  }

  setVolume(volume: number): void {
    this.gain.gain.value = clampVolume(volume);
    this.emit();
  }

  setFftSize(size: FftSize): void {
    this.analyser.fftSize = size;
    this.emit();
  }

  getSnapshot(): EngineSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: EngineSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stops playback, disconnects the graph and closes the context. */
  async destroy(): Promise<void> {
    this.stop();
    this.listeners.clear();
    this.gain.disconnect();
    this.analyser.disconnect();
    if (this.ctx.state !== 'closed') await this.ctx.close();
  }

  // -------------------------------------------------------------------------

  /** Single-use node teardown: no handler, stopped, disconnected, no buffer, no reference. */
  private releaseSource(): void {
    const source = this.source;
    if (source === null) return;
    this.source = null;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // already stopped or never started
    }
    source.disconnect();
    source.buffer = null;
    this.liveSources--;
  }

  private setState(status: EngineStatus, taskId: string | null): void {
    this.status = status;
    this.taskId = taskId;
    this.emit();
  }

  private build(): EngineSnapshot {
    return Object.freeze({
      status: this.status,
      taskId: this.taskId,
      liveSources: this.liveSources,
      fftSize: this.analyser.fftSize === 256 ? 256 : 512,
      volume: this.gain.gain.value,
    });
  }

  private emit(): void {
    this.snapshot = this.build();
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

const clampVolume = (value: number): number => Math.min(1, Math.max(0, value));
