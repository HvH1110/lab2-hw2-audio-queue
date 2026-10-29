import type { TaskEvent, TaskStatus } from './types';

/**
 *   QUEUED ─START─► DOWNLOADING ─DOWNLOADED─► DECODING ─DECODED─► READY ─PLAY─► PLAYING ─FINISH─► PLAYED
 *     │                 │                        │                 │              │
 *     └──CANCEL─────────┴──────CANCEL / FAIL─────┴───CANCEL────────┴──CANCEL──────┘──► CANCELLED / FAILED
 */
const TRANSITIONS: Readonly<Record<TaskStatus, Partial<Record<TaskEvent, TaskStatus>>>> = {
  QUEUED: { START: 'DOWNLOADING', CANCEL: 'CANCELLED' },
  DOWNLOADING: { DOWNLOADED: 'DECODING', FAIL: 'FAILED', CANCEL: 'CANCELLED' },
  DECODING: { DECODED: 'READY', FAIL: 'FAILED', CANCEL: 'CANCELLED' },
  READY: { PLAY: 'PLAYING', CANCEL: 'CANCELLED' },
  PLAYING: { FINISH: 'PLAYED', CANCEL: 'CANCELLED' },
  PLAYED: {},
  FAILED: {},
  CANCELLED: {},
};

export class IllegalTransitionError extends Error {
  override readonly name = 'IllegalTransitionError';

  constructor(readonly from: TaskStatus, readonly event: TaskEvent) {
    super(`Illegal task transition: ${event} from ${from}`);
  }
}

/** Pure transition. Throws on events that are not legal in `from` (they indicate an engine bug). */
export function transitionTask(from: TaskStatus, event: TaskEvent): TaskStatus {
  const to = TRANSITIONS[from][event];
  if (to === undefined) throw new IllegalTransitionError(from, event);
  return to;
}

export function canTransition(from: TaskStatus, event: TaskEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

/** Downloading or decoding: occupies a concurrency slot. */
export const isActive = (status: TaskStatus): boolean => status === 'DOWNLOADING' || status === 'DECODING';
