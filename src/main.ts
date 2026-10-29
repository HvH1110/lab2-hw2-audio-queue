import './styles.css';
import { createAudioApp } from './app';
import { AudioEngine } from './audio/engine';
import { AudioTaskQueue } from './audio/queue';
import { createThrottledFetch } from './audio/throttled-fetch';
import type { FetchLike } from './audio/types';
import { CanvasVisualizer } from './audio/visualizer';
import { auditMount, renderApp } from './mini-react';
import { TRACKS } from './tracks';

const root = document.getElementById('app');
if (root === null) throw new Error('Mount target #app not found');

// Network: real fetch, optionally throttled to make concurrency and progress visible.
const network = { slow: false };
const nativeFetch: FetchLike = (url, init) => fetch(url, init);
const slowFetch = createThrottledFetch(nativeFetch, { bytesPerSecond: 96 * 1024, latencyMs: 400, chunkBytes: 8 * 1024 });
const fetcher: FetchLike = (url, init) => (network.slow ? slowFetch(url, init) : nativeFetch(url, init));

// Decoding needs no audible context, so no AudioContext exists before the first user gesture.
const decoder = new OfflineAudioContext(1, 1, 44_100);
const queue = new AudioTaskQueue<AudioBuffer>({
  concurrency: 2,
  fetch: fetcher,
  decode: (data) => decoder.decodeAudioData(data),
});

let commits = 0;

renderApp(createAudioApp<AudioBuffer>({
  tracks: TRACKS,
  queue,
  createEngine: (onEnded) => new AudioEngine<AudioBuffer>(new AudioContext(), { onEnded }),
  createVisualizer: (canvas, analyser) => {
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Canvas 2D is not available');
    return new CanvasVisualizer({ analyser, context, canvas });
  },
  setSlowNetwork: (slow) => {
    network.slow = slow;
  },
}), root, {
  onCommit: (tree, container) => {
    commits++;
    const report = auditMount(tree, container);
    console.assert(report.ok, 'VNode/DOM parity audit failed', report.issues);
    console.info(`[commit #${commits}] audit ${report.ok ? 'PASS' : 'FAIL'}: ${report.vnodeCount} VNodes`);
  },
});
