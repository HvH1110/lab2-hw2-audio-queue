import type { AudioEngine } from './audio/engine';
import type { AudioTaskQueue } from './audio/queue';
import type { AnalyserLike, DecodedAudio, EngineSnapshot, FftSize, QueueSnapshot, TaskSnapshot, TrackInfo, VisualizerStats } from './audio/types';
import type { VisualizerColors } from './audio/visualizer';
import { createElement, useEffect, useRef, useState, type RootComponent, type VNode } from './mini-react';

/** What the app needs from a visualizer; CanvasVisualizer satisfies it. */
export interface VisualizerHandle {
  start(): void;
  stop(): void;
  resize(width: number, height: number, devicePixelRatio: number): void;
  setColors(colors: VisualizerColors): void;
  stats(): VisualizerStats;
}

export interface AppDeps<B extends DecodedAudio> {
  readonly tracks: readonly TrackInfo[];
  readonly queue: AudioTaskQueue<B>;
  /** Creates the AudioContext-backed engine. Called once, inside a user gesture. */
  readonly createEngine: (onEnded: (taskId: string) => void) => AudioEngine<B>;
  readonly createVisualizer: (canvas: HTMLCanvasElement, analyser: AnalyserLike) => VisualizerHandle;
  readonly setSlowNetwork: (slow: boolean) => void;
}

const STATUS_LABEL: Readonly<Record<TaskSnapshot['status'], string>> = {
  QUEUED: 'Queued',
  DOWNLOADING: 'Downloading',
  DECODING: 'Decoding',
  READY: 'Ready',
  PLAYING: 'Playing',
  PLAYED: 'Played',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

const kib = (bytes: number): string => `${Math.round(bytes / 1024)} KiB`;
const seconds = (value: number | null): string => (value === null ? '' : `${value.toFixed(1)} s`);
const isFinished = (task: TaskSnapshot): boolean => task.status === 'PLAYED' || task.status === 'FAILED' || task.status === 'CANCELLED';

function readColors(canvas: HTMLCanvasElement): VisualizerColors {
  const style = getComputedStyle(canvas);
  const value = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  return { bar: value('--viz-bar', '#4c9aff'), peak: value('--viz-peak', '#ffffff'), text: value('--viz-text', '#9ba6b2') };
}

// ---------------------------------------------------------------------------
// Pure view pieces
// ---------------------------------------------------------------------------

function TaskItem({ task, onCancel, onRemove }: {
  readonly task: TaskSnapshot;
  readonly onCancel: (id: string) => void;
  readonly onRemove: (id: string) => void;
}): VNode {
  const finished = isFinished(task);
  const progressMax = task.totalBytes ?? Math.max(task.receivedBytes, 1);
  return createElement('li', { key: task.id, className: `task task--${task.status.toLowerCase()}`, 'data-status': task.status },
    createElement('p', { className: 'task__title' }, `#${task.sequence} ${task.title}`),
    createElement('p', { className: 'task__status' }, STATUS_LABEL[task.status]),
    createElement('progress', {
      className: 'task__progress',
      max: progressMax,
      value: task.status === 'QUEUED' ? 0 : task.receivedBytes,
      'aria-label': `Download progress for ${task.title}`,
    }),
    createElement('p', { className: 'task__meta' },
      task.error ?? [kib(task.receivedBytes), task.totalBytes === null ? '' : ` / ${kib(task.totalBytes)}`, task.duration === null ? '' : ` · ${seconds(task.duration)}`].join('')),
    createElement('button', {
      id: `task-action-${task.id}`,
      type: 'button',
      className: 'btn btn--ghost',
      'aria-label': `${finished ? 'Remove' : 'Cancel'} ${task.title}`,
      onClick: () => (finished ? onRemove(task.id) : onCancel(task.id)),
    }, finished ? 'Remove' : 'Cancel'),
  );
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export function createAudioApp<B extends DecodedAudio>(deps: AppDeps<B>): RootComponent {
  return function AudioApp(): VNode {
    const { queue, tracks } = deps;
    const [queueState, setQueueState] = useState<QueueSnapshot>(queue.getSnapshot());
    const [engineState, setEngineState] = useState<EngineSnapshot | null>(null);
    const [wantPlay, setWantPlay] = useState(false);
    const [slow, setSlow] = useState(false);
    const [volume, setVolume] = useState(0.8);
    const [fftSize, setFftSize] = useState<FftSize>(512);
    const [visualizerOn, setVisualizerOn] = useState(true);
    const [announcement, setAnnouncement] = useState('');
    const engineRef = useRef<AudioEngine<B> | null>(null);
    const visualizerRef = useRef<VisualizerHandle | null>(null);
    // True while engine.play() awaits the AudioContext: the engine still reports IDLE then,
    // and without this guard the auto-advance effect would take a second track.
    const starting = useRef(false);

    // Queue events → state. Audio frames never come through here.
    useEffect(() => {
      setQueueState(queue.getSnapshot()); // catch up on changes made before subscribing
      return queue.subscribe(setQueueState);
    }, []);

    // Unmount: stop everything that could keep audio, timers or network alive.
    useEffect(() => () => {
      visualizerRef.current?.stop();
      queue.destroy();
      void engineRef.current?.destroy();
    }, []);

    const ensureEngine = (): AudioEngine<B> => {
      if (engineRef.current !== null) return engineRef.current;
      const engine = deps.createEngine((taskId) => {
        queue.complete(taskId); // PLAYED: the queue drops the buffer
      });
      engine.setVolume(volume);
      engine.setFftSize(fftSize);
      engine.subscribe(setEngineState);
      engineRef.current = engine;
      setEngineState(engine.getSnapshot());
      return engine;
    };

    const current = engineState?.taskId ? queueState.tasks.find((t) => t.id === engineState.taskId) : undefined;
    const next = queueState.tasks.find((t) => !isFinished(t) && t.status !== 'PLAYING');
    const engineStatus = engineState?.status ?? 'IDLE';

    // Auto-advance: play the next FIFO task as soon as it is READY; wait while it downloads.
    useEffect(() => {
      const engine = engineRef.current;
      if (!wantPlay || engine === null || engineStatus !== 'IDLE' || starting.current) return;
      if (next === undefined) {
        setWantPlay(false);
        setAnnouncement('Queue finished.');
        return;
      }
      if (next.status !== 'READY') return;
      const task = next;
      // Set the guard *before* take(): take() emits a queue event, and because setState renders
      // synchronously, this effect re-runs inside that call. Setting it afterwards was too late.
      starting.current = true;
      const buffer = queue.take(task.id);
      engine.play(task.id, buffer).then(
        () => {
          starting.current = false;
          setAnnouncement(`Now playing ${task.title}.`);
        },
        (error: unknown) => {
          starting.current = false;
          console.error('[audio] playback failed', error);
          queue.cancel(task.id);
          setAnnouncement(`${task.title} could not be played.`);
        },
      );
    }, [wantPlay, engineStatus, next?.id, next?.status]);

    // Visualizer: created once the engine exists, then started/stopped with playback.
    const engineReady = engineState !== null;
    useEffect(() => {
      const engine = engineRef.current;
      const canvas = document.getElementById('visualizer');
      if (engine === null || !(canvas instanceof HTMLCanvasElement) || visualizerRef.current !== null) return;
      const visualizer = deps.createVisualizer(canvas, engine.analyser);
      visualizer.setColors(readColors(canvas));
      visualizerRef.current = visualizer;
      const fit = (): void => {
        const rect = canvas.getBoundingClientRect();
        visualizer.resize(rect.width || 640, rect.height || 180, window.devicePixelRatio || 1);
      };
      fit();
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
      observer?.observe(canvas);
      const scheme = window.matchMedia?.('(prefers-color-scheme: dark)');
      const recolor = (): void => visualizer.setColors(readColors(canvas));
      scheme?.addEventListener('change', recolor);
      return () => {
        observer?.disconnect();
        scheme?.removeEventListener('change', recolor);
        visualizer.stop();
        visualizerRef.current = null;
      };
    }, [engineReady]);

    useEffect(() => {
      const visualizer = visualizerRef.current;
      if (visualizer === null) return;
      if (visualizerOn && engineStatus === 'PLAYING') visualizer.start();
      else visualizer.stop();
    }, [engineReady, visualizerOn, engineStatus]);

    // ---- actions -------------------------------------------------------------

    const play = (): void => {
      const engine = ensureEngine();
      if (engineStatus === 'PAUSED') {
        void engine.resume();
        return;
      }
      setWantPlay(true);
      if (next === undefined) setAnnouncement('Add tracks to the queue first.');
      else if (next.status !== 'READY') setAnnouncement(`Waiting for ${next.title} to finish downloading…`);
    };

    const pause = (): void => {
      void engineRef.current?.pause();
    };

    const skip = (): void => {
      const engine = engineRef.current;
      const playing = engineState?.taskId;
      if (engine === null || playing === null || playing === undefined) return;
      engine.stop();
      queue.complete(playing);
      setAnnouncement('Skipped.');
    };

    const stop = (): void => {
      setWantPlay(false);
      const playing = engineState?.taskId;
      engineRef.current?.stop();
      if (playing) queue.complete(playing);
      setAnnouncement('Stopped.');
    };

    const cancelTask = (id: string): void => {
      if (engineState?.taskId === id) engineRef.current?.stop();
      queue.cancel(id);
    };

    const addTrack = (track: TrackInfo): void => {
      queue.add(track);
      setAnnouncement(`${track.title} added to the queue.`);
    };

    const inputValue = (event: Event): string =>
      event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement ? event.target.value : '';

    // ---- view ----------------------------------------------------------------

    const playing = engineStatus === 'PLAYING';
    const nowPlaying = current !== undefined
      ? `${engineStatus === 'PAUSED' ? 'Paused' : 'Playing'}: ${current.title}`
      : wantPlay && next !== undefined
        ? `Waiting for ${next.title}…`
        : 'Nothing playing';

    return createElement('main', { className: 'player-app' },
      createElement('header', { className: 'hero' },
        createElement('h1', null, 'Audio Queue Visualizer'),
        createElement('p', { className: 'muted' }, 'FIFO download/decode queue with bounded concurrency, AbortController cancellation and a 60 fps Web Audio spectrum.'),
      ),

      createElement('section', { className: 'panel player', 'aria-labelledby': 'player-title' },
        createElement('h2', { id: 'player-title' }, 'Now playing'),
        createElement('p', { id: 'now-playing', className: 'now-playing' }, nowPlaying),
        createElement('canvas', {
          id: 'visualizer',
          className: 'visualizer',
          role: 'img',
          'aria-label': `Frequency spectrum${current ? ` of ${current.title}` : ''}`,
        }),
        createElement('p', { className: 'controls' },
          createElement('button', { id: 'play-toggle', type: 'button', className: 'btn', onClick: playing ? pause : play }, playing ? 'Pause' : 'Play'),
          createElement('button', { id: 'skip', type: 'button', className: 'btn btn--ghost', 'aria-disabled': String(current === undefined), onClick: skip }, 'Skip'),
          createElement('button', { id: 'stop', type: 'button', className: 'btn btn--ghost', 'aria-disabled': String(current === undefined && !wantPlay), onClick: stop }, 'Stop'),
          createElement('button', {
            id: 'viz-toggle', type: 'button', className: 'btn btn--ghost', 'aria-pressed': String(visualizerOn),
            onClick: () => setVisualizerOn(!visualizerOn),
          }, 'Visualizer'),
        ),
        createElement('p', { className: 'settings' },
          createElement('label', { htmlFor: 'volume' }, 'Volume'),
          createElement('input', {
            id: 'volume', type: 'range', min: 0, max: 1, step: 0.05, value: volume,
            onInput: (event: Event) => {
              const v = Number(inputValue(event));
              setVolume(v);
              engineRef.current?.setVolume(v);
            },
          }),
          createElement('label', { htmlFor: 'fft-size' }, 'FFT size'),
          createElement('select', {
            id: 'fft-size', value: String(fftSize),
            onChange: (event: Event) => {
              const size: FftSize = inputValue(event) === '256' ? 256 : 512;
              setFftSize(size);
              engineRef.current?.setFftSize(size);
            },
          },
            createElement('option', { key: '256', value: '256', selected: fftSize === 256 }, '256 (128 bins)'),
            createElement('option', { key: '512', value: '512', selected: fftSize === 512 }, '512 (256 bins)'),
          ),
        ),
      ),

      createElement('section', { className: 'panel library', 'aria-labelledby': 'library-title' },
        createElement('h2', { id: 'library-title' }, 'Library'),
        createElement('ul', { className: 'library__list' },
          tracks.map((track) =>
            createElement('li', { key: track.id },
              createElement('p', null, track.title),
              createElement('button', {
                id: `add-${track.id}`, type: 'button', className: 'btn btn--ghost', 'aria-label': `Add ${track.title} to the queue`,
                onClick: () => addTrack(track),
              }, 'Add'),
            ),
          ),
        ),
        createElement('button', {
          id: 'add-all', type: 'button', className: 'btn',
          onClick: () => {
            for (const track of tracks.filter((t) => t.id !== 'corrupt' && t.id !== 'missing')) queue.add(track);
            setAnnouncement('All playable tracks added.');
          },
        }, 'Add all playable tracks'),
      ),

      createElement('section', { className: 'panel queue', 'aria-labelledby': 'queue-title' },
        createElement('h2', { id: 'queue-title' }, 'Queue (FIFO)'),
        createElement('p', { className: 'settings' },
          createElement('label', { htmlFor: 'concurrency' }, 'Parallel downloads'),
          createElement('select', {
            id: 'concurrency', value: String(queueState.concurrency),
            onChange: (event: Event) => queue.setConcurrency(Number(inputValue(event))),
          }, [1, 2, 3, 4].map((n) => createElement('option', { key: String(n), value: String(n), selected: queueState.concurrency === n }, String(n)))),
        ),
        createElement('p', { className: 'settings' },
          // The label wraps the box so the two can never be split across lines.
          createElement('label', { htmlFor: 'slow-network', className: 'check' },
            createElement('input', {
              id: 'slow-network', type: 'checkbox', checked: slow,
              onChange: () => {
                setSlow(!slow);
                deps.setSlowNetwork(!slow);
              },
            }),
            'Simulate slow network (96 KB/s, 400 ms latency)',
          ),
        ),
        queueState.tasks.length === 0
          ? createElement('p', { className: 'muted empty' }, 'The queue is empty. Add tracks from the library.')
          : createElement('ol', { className: 'tasks' },
            queueState.tasks.map((task) => TaskItem({ task, onCancel: cancelTask, onRemove: (id) => queue.remove(id) }))),
        createElement('p', { className: 'controls' },
          createElement('button', { id: 'clear-finished', type: 'button', className: 'btn btn--ghost', onClick: () => queue.clearFinished() }, 'Clear finished'),
          createElement('button', {
            id: 'clear-queue', type: 'button', className: 'btn btn--ghost',
            onClick: () => {
              engineRef.current?.stop();
              setWantPlay(false);
              queue.clear();
              setAnnouncement('Queue cleared; all downloads aborted.');
            },
          }, 'Clear queue'),
        ),
      ),

      createElement('section', { className: 'panel stats', 'aria-labelledby': 'stats-title' },
        createElement('h2', { id: 'stats-title' }, 'Engine health'),
        createElement('dl', null,
          ([
            ['Active downloads', `${queueState.active} / ${queueState.concurrency}`],
            ['Decoded buffers in memory', String(queueState.buffersHeld)],
            ['Live source nodes', String(engineState?.liveSources ?? 0)],
            ['Tasks in queue', String(queueState.tasks.length)],
            ['FFT size', `${fftSize} (${fftSize / 2} bins)`],
          ] as const).map(([term, value]) => [
            createElement('dt', { key: `t-${term}` }, term),
            createElement('dd', { key: `d-${term}`, id: `stat-${term.toLowerCase().replace(/\s+/g, '-')}` }, value),
          ]),
        ),
      ),

      createElement('p', { id: 'announcer', className: 'announcer', role: 'status' }, announcement),
    );
  };
}
