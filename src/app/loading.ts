/**
 * What the loading screen says while the city loads: the step under way, a detail and how far
 * along the bar is. Every step is one the app really waits on: the city file's bytes, unpacking
 * it, the 3D engine's download and building the first frame. And how the load notices it has
 * stalled. Pure, but for the timers the stall watch is handed.
 */

export interface LoadState {
  /** Bytes of the city file so far, and in all (0 when the server doesn't say). */
  received: number;
  total: number;
  /** The city file is unpacked; how many buildings it holds. */
  buildings?: number;
  /** The 3D engine's code has arrived. */
  engine: boolean;
  /** The first frame is drawn. */
  built: boolean;
}

export interface LoadStep {
  /** The step, for the screen and for screen readers: a few words. */
  step: string;
  /** Numbers that change often, for the screen only. */
  detail: string;
  /** From 0 to 1. */
  fraction: number;
}

/** The share of the bar each stage fills: the download is most of the wait. */
const DOWNLOADED = 0.7;
const UNPACKED = 0.78;
/**
 * Building has no progress of its own to report: the bar heads here while it works (slowly, in
 * CSS) and fills on the first frame.
 */
const BUILDING = 0.96;

const kb = (bytes: number) => Math.round(bytes / 1024).toLocaleString('en');

export function loadStep(s: LoadState): LoadStep {
  if (s.built) return { step: 'Ready', detail: '', fraction: 1 };
  if (s.buildings === undefined) {
    const downloaded = s.total > 0 && s.received >= s.total;
    if (!downloaded) {
      const share = s.total > 0 ? s.received / s.total : 0;
      return {
        step: 'Fetching the map',
        detail: s.total > 0 ? `${kb(s.received)} of ${kb(s.total)} KB` : `${kb(s.received)} KB`,
        fraction: DOWNLOADED * share,
      };
    }
    return { step: 'Unpacking the city', detail: '', fraction: DOWNLOADED };
  }
  const buildings = `${s.buildings.toLocaleString('en')} buildings`;
  return s.engine
    ? { step: 'Building the streets', detail: buildings, fraction: BUILDING }
    : { step: 'Starting the 3D engine', detail: buildings, fraction: UNPACKED };
}

/** What a stall watch waits with: the platform's timers, or a test's. */
export interface Timers {
  set(then: () => void, ms: number): unknown;
  clear(timer: unknown): void;
}

const TIMERS: Timers = {
  set: (then, ms) => setTimeout(then, ms),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export interface StallWatch {
  /** Aborts, with a TimeoutError, once nothing has happened for the watch's time. */
  signal: AbortSignal;
  /** A sign of life (bytes arrived, a step done): the wait starts again. */
  alive(): void;
  /** Done: no more waiting. */
  stop(): void;
}

/**
 * Notices a load that has stopped moving, rather than one that is slow: a slow link that keeps
 * delivering never trips it, however long the whole download takes, and a dead one always does.
 */
export function stallWatch(ms: number, timers: Timers = TIMERS): StallWatch {
  const controller = new AbortController();
  let timer: unknown;
  const stop = () => timers.clear(timer);
  const alive = () => {
    if (controller.signal.aborted) return;
    stop();
    timer = timers.set(() => {
      controller.abort(new DOMException('The download stalled', 'TimeoutError'));
    }, ms);
  };
  alive();
  return { signal: controller.signal, alive, stop };
}

/** `promise`, unless `signal` aborts first: then its reason. For work that can't be aborted. */
export function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
