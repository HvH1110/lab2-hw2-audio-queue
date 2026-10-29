import { createAudioApp } from '../src/app';
import { AudioEngine } from '../src/audio/engine';
import { AudioTaskQueue } from '../src/audio/queue';
import type { FrameScheduler } from '../src/audio/types';
import { CanvasVisualizer, type Canvas2DLike } from '../src/audio/visualizer';
import { auditMount, renderApp, type AppHandle } from '../src/mini-react';
import { TRACKS } from '../src/tracks';
import { FakeContext, type FakeBuffer } from './audio-fakes';
import { controllableFetch, flush } from './queue-fixtures';

interface Harness {
  readonly net: ReturnType<typeof controllableFetch>;
  readonly ctx: () => FakeContext;
  readonly tick: (n?: number) => void;
  readonly commits: () => number;
  readonly drawCalls: () => number;
  readonly app: AppHandle;
  readonly root: HTMLElement;
}

let harness: Harness | null = null;

function mount(): Harness {
  const root = document.createElement('section');
  document.body.replaceChildren(root);
  const net = controllableFetch();
  const queue = new AudioTaskQueue<FakeBuffer>({ concurrency: 2, fetch: net.fetch, decode: async (data) => ({ duration: data.byteLength / 1000 }) });
  let context: FakeContext | null = null;
  let pending: ((t: number) => void) | null = null;
  const scheduler: FrameScheduler = { request: (cb) => { pending = cb; return 1; }, cancel: () => { pending = null; } };
  let draws = 0;
  const g: Canvas2DLike = {
    fillStyle: '', font: '', textAlign: 'start', textBaseline: 'alphabetic',
    clearRect: () => {}, fillRect: () => { draws++; }, fillText: () => {}, setTransform: () => {},
  };
  let commits = 0;
  const app = renderApp(createAudioApp<FakeBuffer>({
    tracks: TRACKS,
    queue,
    createEngine: (onEnded) => {
      context = new FakeContext();
      return new AudioEngine(context, { onEnded });
    },
    createVisualizer: (canvas, analyser) => new CanvasVisualizer({ analyser, context: g, canvas, scheduler }),
    setSlowNetwork: () => {},
  }), root, {
    onCommit: (tree, container) => {
      commits++;
      if (!auditMount(tree, container).ok) throw new Error('DOM parity broken');
    },
  });
  return {
    net,
    root,
    app,
    ctx: () => { if (context === null) throw new Error('no AudioContext yet'); return context; },
    tick: (n = 1) => { for (let i = 0; i < n; i++) { const cb = pending; pending = null; cb?.(0); } },
    commits: () => commits,
    drawCalls: () => draws,
  };
}

afterEach(() => {
  harness?.app.unmount();
  harness = null;
});

const $ = <E extends Element = HTMLElement>(selector: string): E => {
  const el = document.body.querySelector<E>(selector);
  if (el === null) throw new Error(`not found: ${selector}`);
  return el;
};
const statuses = (): (string | null)[] => [...document.body.querySelectorAll('ol.tasks > li')].map((li) => li.getAttribute('data-status'));
async function deliver(h: Harness, i: number, bytes = 3000): Promise<void> {
  h.net.request(i).respond({ contentLength: bytes });
  h.net.request(i).push(bytes);
  h.net.request(i).end();
  await flush();
}

describe('Homework 2 checkpoint: audio queue app', () => {
  it('renders semantic sections with zero div-soup and a labelled canvas', () => {
    harness = mount();
    expect(document.body.querySelectorAll('main > section[aria-labelledby]')).toHaveLength(4);
    expect($('canvas#visualizer').getAttribute('role')).toBe('img');
    expect(document.body.querySelector('div, span')).toBeNull();
    for (const control of document.body.querySelectorAll('input, select')) {
      expect(document.body.querySelector(`label[for="${control.id}"]`)).not.toBeNull();
    }
  });

  it('adds tracks in FIFO order and respects the parallel download limit', async () => {
    harness = mount();
    $('#add-all').click();
    expect(statuses()).toEqual(['DOWNLOADING', 'DOWNLOADING', 'QUEUED', 'QUEUED', 'QUEUED']);
    expect($('#stat-active-downloads').textContent).toBe('2 / 2');
    const select = $<HTMLSelectElement>('#concurrency');
    select.value = '3';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(statuses()).toEqual(['DOWNLOADING', 'DOWNLOADING', 'DOWNLOADING', 'QUEUED', 'QUEUED']);
  });

  it('Play waits for the first track, plays it, and auto-advances in FIFO order', async () => {
    const h = (harness = mount());
    $('#add-saigon-sunrise').click();
    $('#add-hanoi-night-drive').click();
    $('#play-toggle').click();
    expect($('#now-playing').textContent).toBe('Waiting for Saigon Sunrise…');

    await deliver(h, 1); // the second finishes first: must NOT jump the queue
    expect($('#now-playing').textContent).toBe('Waiting for Saigon Sunrise…');
    await deliver(h, 0);
    expect($('#now-playing').textContent).toBe('Playing: Saigon Sunrise');
    expect(statuses()).toEqual(['PLAYING', 'READY']);
    expect(h.ctx().sources).toHaveLength(1);

    h.ctx().sources[0]?.finish();
    await flush();
    expect($('#now-playing').textContent).toBe('Playing: Hanoi Night Drive');
    expect(statuses()).toEqual(['PLAYED', 'PLAYING']);
    expect($('#stat-decoded-buffers-in-memory').textContent).toBe('1');
    expect($('#stat-live-source-nodes').textContent).toBe('1');

    h.ctx().sources[1]?.finish();
    await flush();
    expect($('#now-playing').textContent).toBe('Nothing playing');
    expect($('#stat-decoded-buffers-in-memory').textContent).toBe('0');
    expect($('#stat-live-source-nodes').textContent).toBe('0');
    expect($('#announcer').textContent).toBe('Queue finished.');
  });

  it('RACE: a slow AudioContext resume does not make auto-advance take two tracks', async () => {
    const h = (harness = mount());
    $('#add-saigon-sunrise').click();
    $('#add-hanoi-night-drive').click();
    await deliver(h, 0);
    await deliver(h, 1);
    $('#play-toggle').click(); // creates the engine
    await flush();
    expect(statuses()).toEqual(['PLAYING', 'READY']);
    expect(h.ctx().sources).toHaveLength(1);
  });

  it('cancelling a downloading task aborts its request; failures show readable errors', async () => {
    const h = (harness = mount());
    $('#add-saigon-sunrise').click();
    $('#add-missing').click();
    $('#task-action-task-1').click();
    expect(h.net.request(0).signal.aborted).toBe(true);
    h.net.request(1).respond({ status: 404 });
    await flush();
    expect(statuses()).toEqual(['CANCELLED', 'FAILED']);
    expect(document.body.querySelector('li[data-status="FAILED"] .task__meta')?.textContent).toBe('The server returned 404 for this track.');
    $('#clear-finished').click();
    expect(document.body.querySelector('ol.tasks')).toBeNull();
  });

  it('Skip and Stop clean up the source node and release the buffer', async () => {
    const h = (harness = mount());
    $('#add-saigon-sunrise').click();
    $('#add-hanoi-night-drive').click();
    await deliver(h, 0);
    await deliver(h, 1);
    $('#play-toggle').click();
    await flush();
    $('#skip').click();
    await flush();
    const [first, second] = h.ctx().sources;
    expect(first).toMatchObject({ stopped: true, onended: null, buffer: null });
    expect($('#now-playing').textContent).toBe('Playing: Hanoi Night Drive');
    $('#stop').click();
    await flush();
    expect(second).toMatchObject({ stopped: true, onended: null, buffer: null });
    expect(statuses()).toEqual(['PLAYED', 'PLAYED']);
    expect($('#stat-decoded-buffers-in-memory').textContent).toBe('0');
  });

  it('NO STATE THRASHING: 300 visualizer frames cause zero re-renders', async () => {
    const h = (harness = mount());
    $('#add-saigon-sunrise').click();
    await deliver(h, 0);
    $('#play-toggle').click();
    await flush();
    const before = h.commits();
    h.tick(300);
    expect(h.drawCalls()).toBeGreaterThan(300 * 48);
    expect(h.commits()).toBe(before);
  });

  it('the canvas element survives every re-render (reconciliation keeps the drawing surface)', async () => {
    const h = (harness = mount());
    const canvas = $('#visualizer');
    $('#add-all').click();
    await deliver(h, 0);
    $('#play-toggle').click();
    await flush();
    expect($('#visualizer')).toBe(canvas);
  });

  it('pausing or hiding the visualizer stops the frame loop', async () => {
    const h = (harness = mount());
    $('#add-saigon-sunrise').click();
    await deliver(h, 0);
    $('#play-toggle').click();
    await flush();
    $('#viz-toggle').click();
    expect($('#viz-toggle').getAttribute('aria-pressed')).toBe('false');
    const draws = h.drawCalls();
    h.tick(10);
    expect(h.drawCalls()).toBe(draws);
  });

  it('unmount aborts downloads, stops playback and closes the AudioContext', async () => {
    const h = (harness = mount());
    $('#add-all').click();
    await deliver(h, 0);
    $('#play-toggle').click();
    await flush();
    h.app.unmount();
    harness = null;
    await flush();
    expect(h.net.requests.slice(1).every((r) => r.signal.aborted)).toBe(true);
    expect(h.ctx().state).toBe('closed');
    expect(h.ctx().sources[0]).toMatchObject({ onended: null, buffer: null });
  });
});
