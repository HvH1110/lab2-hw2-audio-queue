import type { AnalyserLike, FrameScheduler, VisualizerStats } from './types';

/** The part of CanvasRenderingContext2D the visualizer uses (injectable for tests). */
export interface Canvas2DLike {
  fillStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
}

export interface VisualizerColors {
  readonly bar: string;
  readonly peak: string;
  readonly text: string;
}

export interface VisualizerOptions {
  readonly analyser: AnalyserLike;
  readonly context: Canvas2DLike;
  readonly canvas: { width: number; height: number };
  readonly scheduler?: FrameScheduler;
  readonly now?: () => number;
  readonly barCount?: number;
  readonly colors?: VisualizerColors;
}

export const browserScheduler: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

const DEFAULT_COLORS: VisualizerColors = { bar: '#4c9aff', peak: '#ffffff', text: '#9ba6b2' };

/**
 * Splits `bins` FFT bins into `bars` log-spaced groups (more resolution in the bass).
 * Writes the exclusive end index of each group into `out` (length bars), each group ≥ 1 bin.
 */
export function logBarBounds(bins: number, bars: number, out: Uint16Array): void {
  let previous = 0;
  for (let i = 0; i < bars; i++) {
    const ideal = Math.round(bins ** ((i + 1) / bars));
    const end = Math.min(bins, Math.max(previous + 1, ideal));
    out[i] = end;
    previous = end;
  }
  out[bars - 1] = bins;
}

/** Average of each group, normalized to 0..1, written into `out`. Allocation-free. */
export function computeBars(frequency: Uint8Array, bounds: Uint16Array, out: Float32Array): void {
  let start = 0;
  for (let i = 0; i < out.length; i++) {
    const end = Math.max(start + 1, bounds[i] ?? frequency.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += frequency[j] ?? 0;
    out[i] = sum / ((end - start) * 255);
    start = Math.min(end, frequency.length - 1);
  }
}

/**
 * requestAnimationFrame-driven spectrum drawn straight onto a canvas.
 * Never touches reactive state, and the frame loop allocates nothing:
 * buffers are (re)allocated only when the analyser's fftSize changes.
 */
export class CanvasVisualizer {
  private readonly analyser: AnalyserLike;
  private readonly context: Canvas2DLike;
  private readonly canvas: { width: number; height: number };
  private readonly scheduler: FrameScheduler;
  private readonly now: () => number;
  private readonly barCount: number;
  private colors: VisualizerColors;

  private frequency = new Uint8Array(new ArrayBuffer(0));
  private bounds: Uint16Array;
  private heights: Float32Array;
  private peaks: Float32Array;
  private handle: number | null = null;
  private running = false;
  private frames = 0;
  private fps = 0;
  private fpsWindowStart = 0;
  private fpsWindowFrames = 0;
  private fpsLabel = '';
  private bufferAllocations = 0;
  private pixelRatio = 1;

  constructor(options: VisualizerOptions) {
    this.analyser = options.analyser;
    this.context = options.context;
    this.canvas = options.canvas;
    this.scheduler = options.scheduler ?? browserScheduler;
    this.now = options.now ?? (() => performance.now());
    this.barCount = options.barCount ?? 48;
    this.colors = options.colors ?? DEFAULT_COLORS;
    this.bounds = new Uint16Array(this.barCount);
    this.heights = new Float32Array(this.barCount);
    this.peaks = new Float32Array(this.barCount);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.fpsWindowStart = this.now();
    this.fpsWindowFrames = 0;
    this.handle = this.scheduler.request(this.frame);
  }

  stop(): void {
    this.running = false;
    if (this.handle !== null) this.scheduler.cancel(this.handle);
    this.handle = null;
    this.fps = 0;
    this.peaks.fill(0);
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Sizes the backing store for crisp drawing; call on resize, never per frame. */
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    this.pixelRatio = Math.max(1, devicePixelRatio);
    this.canvas.width = Math.max(1, Math.round(cssWidth * this.pixelRatio));
    this.canvas.height = Math.max(1, Math.round(cssHeight * this.pixelRatio));
  }

  setColors(colors: VisualizerColors): void {
    this.colors = colors;
  }

  stats(): VisualizerStats {
    return { running: this.running, frames: this.frames, fps: this.fps, bufferAllocations: this.bufferAllocations };
  }

  // Arrow function: one closure for the visualizer's lifetime, not one per frame.
  private readonly frame = (): void => {
    if (!this.running) return;
    this.ensureBuffers();
    this.analyser.getByteFrequencyData(this.frequency);
    computeBars(this.frequency, this.bounds, this.heights);
    this.draw();
    this.countFrame();
    this.handle = this.scheduler.request(this.frame);
  };

  private ensureBuffers(): void {
    const bins = this.analyser.frequencyBinCount;
    if (this.frequency.length === bins) return;
    this.frequency = new Uint8Array(new ArrayBuffer(bins));
    logBarBounds(bins, this.barCount, this.bounds);
    this.bufferAllocations++;
  }

  private countFrame(): void {
    this.frames++;
    this.fpsWindowFrames++;
    const now = this.now();
    const elapsed = now - this.fpsWindowStart;
    if (elapsed >= 1000) {
      this.fps = Math.round((this.fpsWindowFrames * 1000) / elapsed);
      this.fpsLabel = `${this.fps} fps · FFT ${this.analyser.fftSize}`; // the only string built, once a second
      this.fpsWindowStart = now;
      this.fpsWindowFrames = 0;
    }
  }

  private draw(): void {
    const { context: g, canvas } = this;
    const ratio = this.pixelRatio;
    const width = canvas.width / ratio;
    const height = canvas.height / ratio;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, width, height);

    const gap = 2;
    const barWidth = Math.max(1, (width - gap * (this.barCount - 1)) / this.barCount);
    const floor = height - 18;
    g.fillStyle = this.colors.bar;
    for (let i = 0; i < this.barCount; i++) {
      const value = this.heights[i] ?? 0;
      const barHeight = Math.max(1, value * floor);
      g.fillRect(i * (barWidth + gap), floor - barHeight, barWidth, barHeight);
      // Peak caps fall slowly so transients stay visible.
      this.peaks[i] = Math.max(value, (this.peaks[i] ?? 0) - 0.01);
    }
    g.fillStyle = this.colors.peak;
    for (let i = 0; i < this.barCount; i++) {
      g.fillRect(i * (barWidth + gap), floor - (this.peaks[i] ?? 0) * floor - 2, barWidth, 2);
    }
    if (this.fpsLabel !== '') {
      g.fillStyle = this.colors.text;
      g.font = '12px system-ui, sans-serif';
      g.textAlign = 'right';
      g.textBaseline = 'bottom';
      g.fillText(this.fpsLabel, width - 4, height - 2);
    }
  }
}
