# Work Breakdown Structure (WBS) — Homework 2

Objective: a Web Audio player whose tracks flow through a FIFO concurrency-controlled download/decode queue,
with AbortController cancellation, explicit cleanup of audio nodes and buffers, and a 60 fps
`requestAnimationFrame` canvas visualizer fed by an `AnalyserNode` (FFT 256/512). The visualizer causes no
reactive state thrashing.

> RULE: Never prompt AI with more than one sub-task at a time. One task = one commit.

| # | Task | Verification | Commit |
|---|------|--------------|--------|
| 2.0 | Project rules & WBS | Review | `chore: add project rules and task decomposition` |
| 2.1 | Import the Mini-React engine (reconciliation + `useEffect`) from Homework 1 | `npm test`, `npm run typecheck` | `chore: import mini-react engine from homework 1` |
| 2.2 | Deterministic synthetic track generator + WAV assets (+ a corrupt file) | Script output, unit test of WAV header | `chore(assets): add synthetic track generator and tracks` |
| 2.3 | Contracts: task FSM, snapshots, queue/player/visualizer interfaces, Web Audio subsets | `npm run typecheck` | `feat(types): define audio queue contracts` |
| 2.4 | Task status FSM (`transitionTask`) | Unit tests (legal + illegal) | `feat(queue): implement task status state machine` |
| 2.5 | `AudioTaskQueue`: FIFO start order, bounded concurrency, streamed download progress, decode, snapshots | Unit tests with fake fetch/decode | `feat(queue): implement fifo concurrency controlled queue` |
| 2.6 | Cancellation & memory: `cancel`, `clear`, `release`, AbortController wiring | Unit tests (aborts, no leaks) | `feat(queue): add abort controller cancellation and buffer release` |
| 2.7 | Throttled fetch for slow-network simulation | Unit tests (fake timers) | `feat(net): add throttled fetch for slow network simulation` |
| 2.8 | `AudioEngine`: analyser (FFT 256/512), gain, play/stop/pause, source-node cleanup | Unit tests with fake AudioContext | `feat(audio): implement playback engine with node cleanup` |
| 2.9 | Canvas visualizer: rAF loop, preallocated buffers, DPR sizing, FPS meter, teardown | Unit tests (no allocation per frame) | `feat(viz): implement allocation-free canvas visualizer` |
| 2.10 | UI: library, FIFO queue, player controls, live stats, auto-advance | Checkpoint tests + real Chrome | `feat(ui): assemble audio queue visualizer app` |
| 2.11 | README with architecture, memory/FPS evidence | Chrome measurements | `docs: add readme with performance and memory audit` |

## Checklist

- [x] Task 2.0: Write `project-rules.md` and `TASK_DECOMPOSITION.md`
- [x] Task 2.1: Import engine from Homework 1
- [x] Task 2.2: Generate synthetic tracks
- [x] Task 2.3: Define audio queue contracts
- [x] Task 2.4: Implement task status FSM
- [ ] Task 2.5: Implement FIFO concurrency-controlled queue
- [ ] Task 2.6: Add cancellation and buffer release
- [ ] Task 2.7: Add throttled fetch
- [ ] Task 2.8: Implement playback engine with node cleanup
- [ ] Task 2.9: Implement allocation-free canvas visualizer
- [ ] Task 2.10: Assemble the app
- [ ] Task 2.11: README with performance and memory audit
