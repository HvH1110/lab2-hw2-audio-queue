import { IllegalTransitionError, canTransition, isActive, transitionTask } from '../src/audio/task-state';
import { TASK_STATUSES, TERMINAL_STATUSES, type TaskEvent, type TaskStatus } from '../src/audio/types';

const EVENTS: readonly TaskEvent[] = ['START', 'DOWNLOADED', 'DECODED', 'PLAY', 'FINISH', 'FAIL', 'CANCEL'];

describe('transitionTask', () => {
  it.each<[TaskStatus, TaskEvent, TaskStatus]>([
    ['QUEUED', 'START', 'DOWNLOADING'],
    ['DOWNLOADING', 'DOWNLOADED', 'DECODING'],
    ['DECODING', 'DECODED', 'READY'],
    ['READY', 'PLAY', 'PLAYING'],
    ['PLAYING', 'FINISH', 'PLAYED'],
    ['DOWNLOADING', 'FAIL', 'FAILED'],
    ['DECODING', 'FAIL', 'FAILED'],
    ['QUEUED', 'CANCEL', 'CANCELLED'],
    ['DOWNLOADING', 'CANCEL', 'CANCELLED'],
    ['DECODING', 'CANCEL', 'CANCELLED'],
    ['READY', 'CANCEL', 'CANCELLED'],
    ['PLAYING', 'CANCEL', 'CANCELLED'],
  ])('%s + %s → %s', (from, event, to) => {
    expect(transitionTask(from, event)).toBe(to);
  });

  it('happy path visits every non-failure status in order', () => {
    const path: TaskStatus[] = ['QUEUED'];
    for (const event of ['START', 'DOWNLOADED', 'DECODED', 'PLAY', 'FINISH'] as const) {
      path.push(transitionTask(path[path.length - 1] ?? 'QUEUED', event));
    }
    expect(path).toEqual(['QUEUED', 'DOWNLOADING', 'DECODING', 'READY', 'PLAYING', 'PLAYED']);
  });

  it.each([...TERMINAL_STATUSES])('%s is terminal: every event is illegal', (status) => {
    for (const event of EVENTS) expect(() => transitionTask(status, event)).toThrow(IllegalTransitionError);
  });

  it.each<[TaskStatus, TaskEvent]>([
    ['QUEUED', 'DECODED'], // skipping the download
    ['QUEUED', 'PLAY'],
    ['DOWNLOADING', 'PLAY'], // playing an undecoded buffer
    ['READY', 'FAIL'], // decoded buffers cannot fail any more
    ['DECODING', 'START'], // double start
  ])('rejects %s + %s', (from, event) => {
    expect(() => transitionTask(from, event)).toThrow(`Illegal task transition: ${event} from ${from}`);
  });

  it('canTransition agrees with transitionTask for every pair', () => {
    for (const status of TASK_STATUSES) {
      for (const event of EVENTS) {
        let legal = true;
        try {
          transitionTask(status, event);
        } catch {
          legal = false;
        }
        expect(canTransition(status, event)).toBe(legal);
      }
    }
  });

  it('only DOWNLOADING and DECODING occupy a concurrency slot', () => {
    expect(TASK_STATUSES.filter(isActive)).toEqual(['DOWNLOADING', 'DECODING']);
  });
});
