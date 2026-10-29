// Reproducible browser audit (Chrome DevTools Protocol).
// Usage: start `npm run preview`, start Chrome with --remote-debugging-port=9222 --autoplay-policy=no-user-gesture-required
//        --enable-precise-memory-info, then: node scripts/browser-audit.mjs 9222 http://localhost:4173/ <screenshot dir> [--isolate-heap]
// --isolate-heap silences console.info (retained log objects) and runs 6 instead of 3 heap cycles.
//
// HW2 browser audit: concurrency, real analyser signal, FPS, re-renders during playback, node cleanup, heap.
import { writeFileSync } from 'node:fs';

const [port, url, outDir, flag] = process.argv.slice(2);
const isolateHeap = flag === '--isolate-heap';
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.consoleAPICalled') logs.push({ t: Date.now(), type: msg.params.type, text: msg.params.args.map((a) => a.value ?? a.description).join(' ') });
  if (msg.method === 'Runtime.exceptionThrown') logs.push({ t: Date.now(), type: 'exception', text: msg.params.exceptionDetails.exception?.description });
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.result.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
const heap = async () => { await send('HeapProfiler.collectGarbage'); await sleep(200); await send('HeapProfiler.collectGarbage'); return evaluate('performance.memory.usedJSHeapSize'); };
const statuses = () => evaluate(`[...document.querySelectorAll('ol.tasks > li')].map((li) => li.dataset.status)`);
const shot = async (name) => { const { result } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${outDir}/${name}.png`, Buffer.from(result.data, 'base64')); };

// Test-harness instrumentation (not app code): counts nodes, cleanup, analyser signal and visualizer frames.
const instrument = `
  ${isolateHeap ? 'console.info = () => {};' : ''}
  window.__audit = { sourcesCreated: 0, sourcesDisconnected: 0, analyserPeak: 0, vizFrames: 0, contexts: [] };
  const ctxCreate = AudioContext.prototype.createBufferSource;
  AudioContext.prototype.createBufferSource = function () {
    const node = ctxCreate.call(this);
    window.__audit.sourcesCreated++;
    const disconnect = node.disconnect.bind(node);
    node.disconnect = (...args) => { window.__audit.sourcesDisconnected++; return disconnect(...args); };
    return node;
  };
  const NativeContext = AudioContext;
  window.AudioContext = class extends NativeContext { constructor(...a) { super(...a); window.__audit.contexts.push(this); } };
  const getFreq = AnalyserNode.prototype.getByteFrequencyData;
  AnalyserNode.prototype.getByteFrequencyData = function (array) {
    getFreq.call(this, array);
    for (let i = 0; i < array.length; i += 8) if (array[i] > window.__audit.analyserPeak) window.__audit.analyserPeak = array[i];
  };
  const clear = CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect = function (...a) { window.__audit.vizFrames++; return clear.apply(this, a); };
`;

await send('Runtime.enable');
await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: instrument });
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1300, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await sleep(1000);

const report = {};
report.heapBaseline = await heap();

// 1. Concurrency under a slow network.
await click('#slow-network');
await click('#add-all');
await sleep(300);
report.whileDownloading = await statuses();
report.activeStat = await evaluate(`document.querySelector('#stat-active-downloads').textContent`);
await shot('hw2-downloading');

// 2. Play waits for track 1, then plays.
await click('#play-toggle');
for (let i = 0; i < 60 && !(await evaluate(`document.querySelector('#now-playing').textContent.startsWith('Playing')`)); i++) await sleep(250);
report.nowPlaying = await evaluate(`document.querySelector('#now-playing').textContent`);
report.contextState = await evaluate(`window.__audit.contexts[0]?.state`);

// 3. Wait until every download is done, then measure a quiet 3 s window of playback.
for (let i = 0; i < 120 && (await statuses()).some((s) => s === 'QUEUED' || s === 'DOWNLOADING' || s === 'DECODING'); i++) await sleep(250);
report.afterDownloads = await statuses();
const frames0 = await evaluate('window.__audit.vizFrames');
const commitsBefore = logs.filter((l) => l.text.startsWith('[commit')).length;
const t0 = Date.now();
await sleep(3000);
const seconds = (Date.now() - t0) / 1000;
report.vizFps = Math.round(((await evaluate('window.__audit.vizFrames')) - frames0) / seconds);
report.commitsDuringSteadyPlayback = logs.filter((l) => l.text.startsWith('[commit')).length - commitsBefore;
report.analyserPeak = await evaluate('window.__audit.analyserPeak');
report.pageFps = await evaluate(`new Promise((resolve) => { let n = 0; const start = performance.now(); const step = (t) => { n++; if (t - start < 1000) requestAnimationFrame(step); else resolve(Math.round(n * 1000 / (t - start))); }; requestAnimationFrame(step); })`);
await shot('hw2-playing');

// 4. Skip through every track, then check node cleanup and memory.
for (let i = 0; i < 6; i++) { await click('#skip'); await sleep(400); }
report.afterSkips = await statuses();
report.liveSourcesStat = await evaluate(`document.querySelector('#stat-live-source-nodes').textContent`);
report.buffersStat = await evaluate(`document.querySelector('#stat-decoded-buffers-in-memory').textContent`);
report.sources = await evaluate(`({ created: window.__audit.sourcesCreated, disconnected: window.__audit.sourcesDisconnected })`);

// 5. Repeat 3 full cycles (add all, wait, play-skip-all, clear) and compare GC'd heap.
const heaps = [];
await click('#slow-network'); // fast network for the cycles
for (let cycle = 0; cycle < (isolateHeap ? 6 : 3); cycle++) {
  await click('#clear-queue');
  await click('#add-all');
  for (let i = 0; i < 80 && (await statuses()).some((s) => s !== 'READY'); i++) await sleep(150);
  await click('#play-toggle');
  await sleep(300);
  for (let i = 0; i < 6; i++) { await click('#skip'); await sleep(200); }
  await click('#clear-queue');
  heaps.push(await heap());
}
report.heapAfterCycles = heaps;
report.sourcesFinal = await evaluate(`({ created: window.__audit.sourcesCreated, disconnected: window.__audit.sourcesDisconnected })`);
report.errors = logs.filter((l) => l.type === 'error' || l.type === 'exception' || l.type === 'assert').map((l) => l.text);
report.auditFails = logs.filter((l) => l.text.includes('FAIL')).length;

console.log(JSON.stringify(report, null, 2));
ws.close();
