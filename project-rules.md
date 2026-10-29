# Project Rules — Lab 02 / Homework 2: Concurrent FIFO Audio Visualizer Queue Engine

These rules are binding for every human or AI contribution to this repository.
A change that violates any rule below must not be committed.

## 1. Workflow (Anti-Monolithic Vibe Coding)

1. **Functional slicing**: work only on tasks listed in `TASK_DECOMPOSITION.md`.
2. **Contract first**: interfaces in `src/audio/types.ts` are written before the code that uses them.
3. **Atomic generation**: one sub-task per prompt and one sub-task per commit.
4. **Independent verification**: unit tests with fakes, `npm run typecheck`, and a real-Chrome check of FPS, memory and node cleanup.
5. Tick the matching checkbox in `TASK_DECOMPOSITION.md` in the same commit that completes the task.

## 2. Git

- Conventional Commits. `npm run typecheck` **and** `npm test` must pass before every commit (gated).

## 3. Language & Tooling

- TypeScript `strict`; no `any`. ES modules bundled with Vite.
- **BANNED:** `var`, implicit globals, `keypress`, `e.keyCode`, `innerHTML` and friends, inline handlers.
- UI events go through the root delegation hub. Non-DOM event targets (AbortSignal, AudioNode, MediaQueryList)
  may use `addEventListener` but must remove the listener in the matching cleanup.

## 4. Concurrency Controller (FIFO queue)

- Tasks **start** in strict FIFO order; at most `concurrency` tasks download/decode at the same time.
- Every task owns an `AbortController`. Cancelling a task aborts its fetch **and** its decode result; a queued task
  that is cancelled never starts.
- Each task's status is a finite state machine:
  `QUEUED → DOWNLOADING → DECODING → READY → PLAYING → PLAYED`, with `FAILED` and `CANCELLED` as terminal branches.
  Illegal transitions throw.
- `enqueue(url)` returns a `Promise<AudioBuffer>` that settles exactly once.
- Snapshots handed to the UI are immutable; the UI never reads mutable queue internals.

## 5. Memory Safety

- An `AudioBufferSourceNode` is single-use: after it ends or is stopped, its `onended` handler is cleared,
  it is `disconnect()`ed and every reference to it is dropped.
- Decoded `AudioBuffer`s are released (`release(id)`) once played, cancelled or removed. The queue never keeps
  buffers for finished tasks.
- Every `requestAnimationFrame`, `ResizeObserver`, media-query listener and abort listener has a teardown path.
- Unmounting the app stops playback, cancels every task, stops the visualizer and closes the `AudioContext`.

## 6. Rendering Performance (60 fps, no state thrashing)

- The visualizer is driven by `requestAnimationFrame` and draws directly to `<canvas>`. Audio frames **never** go
  through `useState`; the reactive UI only re-renders on queue and player events.
- The per-frame loop allocates nothing: analyser data goes into a preallocated `Uint8Array`, which is reallocated
  only when `fftSize` changes.
- The canvas is sized once per resize (devicePixelRatio aware), never per frame.

## 7. Accessibility & Semantics

- Zero div-soup: `<main>`, `<section>`, `<ol>` for the FIFO queue, `<ul>` for the library, `<progress>`, `<button>`,
  `<label>`, `<output>`.
- The canvas has `role="img"` and a label; a visible text equivalent (track title and status) is always present.
- The visualizer can be paused (WCAG 2.2.2). Every control has a visible label. Status changes are announced via `role="status"`.
