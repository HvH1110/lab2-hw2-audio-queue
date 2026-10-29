import { CanvasVisualizer, computeBars, logBarBounds, type Canvas2DLike } from '../src/audio/visualizer';
import type { FrameScheduler } from '../src/audio/types';
import { FakeAnalyser } from './audio-fakes';

/** Frames run only when the test calls tick(). */
function manualScheduler() {
  let next: ((t: number) => void) | null = null;
  let handles = 0;
  let cancelled = 0;
  const scheduler: FrameScheduler = {
    request: (cb) => { next = cb; return ++handles; },
    cancel: () => { next = null; cancelled++; },
  };
  return {
    scheduler,
    tick: (t = 0) => { const cb = next; next = null; cb?.(t); },
    get pending() { return next !== null; },
    get cancelled() { return cancelled; },
  };
}

function fakeContext() {
  const calls = { fillRect: 0, clearRect: 0, fillText: [] as string[] };
  const context: Canvas2DLike = {
    fillStyle: '', font: '', textAlign: 'start', textBaseline: 'alphabetic',
    clearRect: () => { calls.clearRect++; },
    fillRect: () => { calls.fillRect++; },
    fillText: (text) => { calls.fillText.push(text); },
    setTransform: () => {},
  };
  return { context, calls };
}

function setup(options: { bars?: number } = {}) {
  const analyser = new FakeAnalyser();
  analyser.fftSize = 512;
  const frames = manualScheduler();
  const { context, calls } = fakeContext();
  let clock = 0;
  const canvas = { width: 0, height: 0 };
  const viz = new CanvasVisualizer({ analyser, context, canvas, scheduler: frames.scheduler, now: () => clock, barCount: options.bars ?? 8 });
  viz.resize(400, 120, 2);
  return { analyser, frames, calls, canvas, viz, advance: (ms: number) => { clock += ms; } };
}

describe('logBarBounds / computeBars', () => {
  it('splits bins into increasing, non-empty, log-spaced groups ending at the last bin', () => {
    const bounds = new Uint16Array(8);
    logBarBounds(256, 8, bounds);
    const widths = [...bounds].map((end, i) => end - (bounds[i - 1] ?? 0));
    expect(bounds.at(-1)).toBe(256);
    expect(widths.every((w) => w >= 1)).toBe(true);
    expect(widths[0]).toBeLessThan(widths.at(-1) ?? 0); // more resolution in the bass
  });

  it('averages each group into 0..1 without allocating', () => {
    const freq = new Uint8Array(256).fill(255);
    const bounds = new Uint16Array(4);
    logBarBounds(256, 4, bounds);
    const out = new Float32Array(4);
    computeBars(freq, bounds, out);
    expect([...out]).toEqual([1, 1, 1, 1]);
    freq.fill(0);
    computeBars(freq, bounds, out);
    expect([...out]).toEqual([0, 0, 0, 0]);
  });
});

describe('CanvasVisualizer', () => {
  it('sizes the backing store for the device pixel ratio', () => {
    const { canvas } = setup();
    expect(canvas).toEqual({ width: 800, height: 240 });
  });

  it('draws one bar and one peak cap per bar each frame, reading the analyser once', () => {
    const { viz, frames, calls, analyser } = setup({ bars: 8 });
    viz.start();
    frames.tick();
    expect(analyser.reads).toBe(1);
    expect(calls.fillRect).toBe(16);
    expect(frames.pending).toBe(true); // re-scheduled itself
  });

  it('allocates its frequency buffer once, and again only when fftSize changes', () => {
    const { viz, frames, analyser } = setup();
    viz.start();
    for (let i = 0; i < 300; i++) frames.tick();
    expect(viz.stats().bufferAllocations).toBe(1);
    analyser.fftSize = 256;
    for (let i = 0; i < 300; i++) frames.tick();
    expect(viz.stats()).toMatchObject({ bufferAllocations: 2, frames: 600 });
  });

  it('measures FPS over one-second windows and only then rebuilds its label', () => {
    const { viz, frames, calls, advance } = setup();
    viz.start();
    for (let i = 0; i < 61; i++) { // 60 × (1000/60) is a hair under 1000 ms in floating point
      advance(1000 / 60);
      frames.tick();
    }
    expect(viz.stats().fps).toBe(60);
    expect(calls.fillText).toEqual([]); // no label until the first window closes
    frames.tick(); // the label built at the end of the last frame is drawn from the next one
    expect(calls.fillText).toEqual(['60 fps · FFT 512']);
  });

  it('start is idempotent and stop cancels the pending frame and clears the canvas', () => {
    const { viz, frames, calls } = setup();
    viz.start();
    viz.start();
    viz.stop();
    expect(frames.cancelled).toBe(1);
    expect(frames.pending).toBe(false);
    expect(calls.clearRect).toBe(1);
    expect(viz.stats()).toMatchObject({ running: false, fps: 0 });
  });

  it('a frame that fires after stop() does nothing (no zombie loop)', () => {
    const { viz, frames, analyser } = setup();
    viz.start();
    const late = frames;
    viz.stop();
    late.tick(); // nothing scheduled any more
    expect(analyser.reads).toBe(0);
    expect(frames.pending).toBe(false);
  });

  it('never re-renders anything outside the canvas (no state thrashing)', () => {
    const { viz, frames } = setup();
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    viz.start();
    for (let i = 0; i < 120; i++) frames.tick();
    observer.disconnect();
    expect(mutations).toEqual([]);
  });
});
