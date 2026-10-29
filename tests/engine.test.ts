import { AudioEngine } from '../src/audio/engine';
import { FakeContext, type FakeBuffer, type FakeSource } from './audio-fakes';

const buffer = (duration = 3): FakeBuffer => ({ duration });
const last = (ctx: FakeContext): FakeSource => {
  const s = ctx.sources.at(-1);
  if (s === undefined) throw new Error('no source');
  return s;
};

describe('AudioEngine: graph', () => {
  it('wires gain → analyser → destination with the requested FFT size', () => {
    const ctx = new FakeContext();
    const engine = new AudioEngine(ctx, { fftSize: 256 });
    const [gain] = ctx.gains;
    const [analyser] = ctx.analysers;
    expect(gain?.outputs.has(engine.analyser)).toBe(true);
    expect(analyser?.outputs.has(ctx.destination)).toBe(true);
    expect(engine.analyser.fftSize).toBe(256);
    expect(engine.analyser.frequencyBinCount).toBe(128);
  });

  it('switches FFT size between 256 and 512', () => {
    const engine = new AudioEngine(new FakeContext());
    engine.setFftSize(256);
    expect(engine.getSnapshot().fftSize).toBe(256);
    engine.setFftSize(512);
    expect(engine.analyser.frequencyBinCount).toBe(256);
  });

  it('clamps the volume to [0, 1]', () => {
    const ctx = new FakeContext();
    const engine = new AudioEngine(ctx);
    engine.setVolume(3);
    expect(ctx.gains[0]?.gain.value).toBe(1);
    engine.setVolume(-1);
    expect(engine.getSnapshot().volume).toBe(0);
  });
});

describe('AudioEngine: playback', () => {
  it('resumes a suspended context, then starts a source connected to the gain', async () => {
    const ctx = new FakeContext();
    const engine = new AudioEngine(ctx);
    await engine.play('task-1', buffer());
    const source = last(ctx);
    expect(ctx.state).toBe('running');
    expect(source.started).toBe(true);
    expect(source.outputs.has(ctx.gains[0] as never)).toBe(true);
    expect(engine.getSnapshot()).toMatchObject({ status: 'PLAYING', taskId: 'task-1', liveSources: 1 });
  });

  it('a natural end cleans the node up and reports the finished task', async () => {
    const ended = vi.fn();
    const ctx = new FakeContext();
    const engine = new AudioEngine(ctx, { onEnded: ended });
    await engine.play('task-1', buffer());
    const source = last(ctx);
    source.finish();
    expect(ended).toHaveBeenCalledWith('task-1');
    expect(source.onended).toBeNull();
    expect(source.disconnected).toBe(1);
    expect(source.buffer).toBeNull();
    expect(engine.getSnapshot()).toMatchObject({ status: 'IDLE', taskId: null, liveSources: 0 });
  });

  it('playing another track stops and cleans the previous source first', async () => {
    const ctx = new FakeContext();
    const ended = vi.fn();
    const engine = new AudioEngine(ctx, { onEnded: ended });
    await engine.play('a', buffer());
    const first = last(ctx);
    await engine.play('b', buffer());
    expect(first).toMatchObject({ stopped: true, onended: null, buffer: null });
    expect(first.disconnected).toBe(1);
    expect(engine.getSnapshot()).toMatchObject({ taskId: 'b', liveSources: 1 });
    first.finish(); // a late 'ended' from the old node must not affect anything
    expect(ended).not.toHaveBeenCalled();
  });

  it('stop() cleans up without reporting a natural end', async () => {
    const ctx = new FakeContext();
    const ended = vi.fn();
    const engine = new AudioEngine(ctx, { onEnded: ended });
    await engine.play('a', buffer());
    engine.stop();
    expect(ended).not.toHaveBeenCalled();
    expect(engine.getSnapshot()).toMatchObject({ status: 'IDLE', liveSources: 0 });
  });

  it('RACE: overlapping play() calls start only the newest source', async () => {
    const ctx = new FakeContext();
    let open!: () => void;
    ctx.resumeGate = new Promise((r) => { open = r; });
    const engine = new AudioEngine(ctx);
    const first = engine.play('a', buffer());
    const second = engine.play('b', buffer());
    open();
    await Promise.all([first, second]);
    expect(ctx.sources).toHaveLength(1);
    expect(engine.getSnapshot()).toMatchObject({ taskId: 'b', liveSources: 1 });
  });

  it('RACE: stop() during a pending play() wins', async () => {
    const ctx = new FakeContext();
    let open!: () => void;
    ctx.resumeGate = new Promise((r) => { open = r; });
    const engine = new AudioEngine(ctx);
    const playing = engine.play('a', buffer());
    engine.stop();
    open();
    await playing;
    expect(ctx.sources).toHaveLength(0);
    expect(engine.getSnapshot().status).toBe('IDLE');
  });

  it('pause/resume suspend and resume the context', async () => {
    const ctx = new FakeContext();
    const engine = new AudioEngine(ctx);
    await engine.play('a', buffer());
    await engine.pause();
    expect(ctx.state).toBe('suspended');
    expect(engine.getSnapshot().status).toBe('PAUSED');
    await engine.resume();
    expect(engine.getSnapshot()).toMatchObject({ status: 'PLAYING', taskId: 'a' });
  });

  it('pause while idle is a no-op', async () => {
    const engine = new AudioEngine(new FakeContext());
    await engine.pause();
    expect(engine.getSnapshot().status).toBe('IDLE');
  });

  it('STRESS: 100 tracks in a row never leave more than one live source', async () => {
    const ctx = new FakeContext();
    const engine = new AudioEngine(ctx);
    let peak = 0;
    engine.subscribe((s) => { peak = Math.max(peak, s.liveSources); });
    for (let i = 0; i < 100; i++) {
      await engine.play(`t${i}`, buffer());
      if (i % 2 === 0) last(ctx).finish();
    }
    engine.stop();
    expect(peak).toBe(1);
    expect(engine.getSnapshot().liveSources).toBe(0);
    expect(ctx.sources.every((s) => s.onended === null && s.buffer === null && s.disconnected === 1)).toBe(true);
  });

  it('destroy disconnects the graph and closes the context', async () => {
    const ctx = new FakeContext();
    const engine = new AudioEngine(ctx);
    const listener = vi.fn();
    engine.subscribe(listener);
    await engine.play('a', buffer());
    await engine.destroy();
    expect(ctx.state).toBe('closed');
    expect(ctx.gains[0]?.disconnected).toBe(1);
    expect(ctx.analysers[0]?.disconnected).toBe(1);
    listener.mockClear();
    engine.setVolume(0.5);
    expect(listener).not.toHaveBeenCalled();
  });
});
