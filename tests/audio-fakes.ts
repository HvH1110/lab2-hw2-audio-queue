import type { AnalyserLike, AudioContextLike, AudioNodeLike, GainLike, SourceNodeLike } from '../src/audio/types';

export interface FakeBuffer {
  readonly duration: number;
}

class FakeNode implements AudioNodeLike {
  readonly outputs = new Set<AudioNodeLike>();
  disconnected = 0;

  connect(destination: AudioNodeLike): AudioNodeLike {
    this.outputs.add(destination);
    return destination;
  }

  disconnect(): void {
    this.outputs.clear();
    this.disconnected++;
  }
}

export class FakeSource extends FakeNode implements SourceNodeLike<FakeBuffer> {
  buffer: FakeBuffer | null = null;
  onended: ((event: Event) => void) | null = null;
  started = false;
  stopped = false;

  start(): void {
    if (this.started) throw new DOMException('start() can only be called once', 'InvalidStateError');
    this.started = true;
  }

  stop(): void {
    if (!this.started) throw new DOMException('not started', 'InvalidStateError');
    this.stopped = true;
  }

  /** Simulates the track playing to its natural end. */
  finish(): void {
    this.onended?.(new Event('ended'));
  }
}

export class FakeAnalyser extends FakeNode implements AnalyserLike {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  /** Byte value written into every bin by getByteFrequencyData. */
  level = 128;
  reads = 0;

  get frequencyBinCount(): number {
    return this.fftSize / 2;
  }

  getByteFrequencyData(array: Uint8Array<ArrayBuffer>): void {
    this.reads++;
    array.fill(this.level);
  }

  getByteTimeDomainData(array: Uint8Array<ArrayBuffer>): void {
    array.fill(128);
  }
}

export class FakeGain extends FakeNode implements GainLike {
  readonly gain = { value: 1 };
}

export class FakeContext implements AudioContextLike<FakeBuffer> {
  state: string = 'suspended';
  currentTime = 0;
  readonly destination = new FakeNode();
  readonly sources: FakeSource[] = [];
  readonly analysers: FakeAnalyser[] = [];
  readonly gains: FakeGain[] = [];
  /** When set, resume() waits for it: lets tests interleave play() calls. */
  resumeGate: Promise<void> | null = null;

  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }

  createAnalyser(): FakeAnalyser {
    const analyser = new FakeAnalyser();
    this.analysers.push(analyser);
    return analyser;
  }

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  async resume(): Promise<void> {
    if (this.resumeGate) await this.resumeGate;
    this.state = 'running';
  }

  async suspend(): Promise<void> {
    this.state = 'suspended';
  }

  async close(): Promise<void> {
    this.state = 'closed';
  }
}
