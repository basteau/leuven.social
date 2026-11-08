/**
 * Dynamic resolution: when the frames of a continuous loop (walking, riding, the day passing) run
 * slow, the canvas draws at a fraction of its size until they don't. Pure, so it is tested; the
 * viewer feeds it and applies the scale.
 *
 * Resizing the drawing buffer reallocates it, which itself costs a frame, so the scaler moves
 * rarely: it decides once per window of frames, tries one step at a time, and takes a step back
 * (and waits longer before the next try) when a step down bought nothing, as on a phone capped at
 * 30 fps or a CPU-bound frame, where fewer pixels can't help, or when a step up made it slow again.
 */

/** Scales the canvas can draw at, as a share of its resolution each way. */
export const SCALES = [1, 0.85, 0.72, 0.6] as const;

/** How long a window of frames lasts (ms): also the shortest time between two steps. */
export const WINDOW_MS = 500;
/** A window averaging more than this (ms a frame) is slow: under 50 fps. */
const SLOW_MS = 20;
/** And under this it has room to spare: about 60 fps or better. */
const FAST_MS = 17.5;
/** A step down has to cut the frame time by at least this share to count as a gain. */
const GAIN = 0.08;
/** A gap this long between two frames (ms) is a pause, not a slow frame: the window starts over. */
const GAP_MS = 250;
/** How long frames have to run fast (ms) before a step back up is tried. */
const CALM_MS = 3000;
/** How long to leave it alone after a step that didn't help (ms), doubling each time. */
const BACK_OFF_MS = 2000;
const MOST_BACK_OFF_MS = 64_000;

export interface Scaler {
  /** The share of the canvas's resolution to draw at now. */
  readonly scale: number;
  /** Notes a frame of a continuous loop at `now` (ms); true when the scale changed. */
  frame(now: number): boolean;
  /** Back to full resolution, and forgets what it has learned; true when the scale changed. */
  reset(): boolean;
}

export function createScaler(): Scaler {
  let level = 0;
  let last = Number.NaN;
  let windowStart = 0;
  let frames = 0;
  /** The mean of the window before a step down, while the step is on trial. */
  let before = Number.NaN;
  /** A step up on trial. */
  let climbing = false;
  let calmSince = Number.NaN;
  let notBefore = 0;
  let backOff = BACK_OFF_MS;

  function restartWindow(now: number): void {
    windowStart = now;
    frames = 0;
  }

  function waitLonger(now: number): void {
    notBefore = now + backOff;
    backOff = Math.min(backOff * 2, MOST_BACK_OFF_MS);
    calmSince = Number.NaN;
  }

  /** At the end of a window: whether to change the scale, by the frames' mean. */
  function decide(mean: number, now: number): boolean {
    if (!Number.isNaN(before)) {
      const gained = mean <= before * (1 - GAIN);
      before = Number.NaN;
      if (!gained) {
        level--;
        waitLonger(now);
        return true;
      }
    }
    if (climbing) {
      climbing = false;
      if (mean > SLOW_MS) {
        level++;
        waitLonger(now);
        return true;
      }
      backOff = BACK_OFF_MS;
    }
    if (now < notBefore) return false;
    if (mean > SLOW_MS) {
      calmSince = Number.NaN;
      if (level === SCALES.length - 1) return false;
      before = mean;
      level++;
      return true;
    }
    if (mean > FAST_MS) {
      calmSince = Number.NaN;
      return false;
    }
    if (Number.isNaN(calmSince)) calmSince = now;
    if (level === 0 || now - calmSince < CALM_MS) return false;
    level--;
    climbing = true;
    calmSince = Number.NaN;
    return true;
  }

  return {
    get scale() {
      return SCALES[level]!;
    },
    frame(now) {
      const gap = now - last;
      last = now;
      if (!(gap < GAP_MS)) {
        restartWindow(now);
        return false;
      }
      frames++;
      const elapsed = now - windowStart;
      if (elapsed < WINDOW_MS) return false;
      const changed = decide(elapsed / frames, now);
      restartWindow(now);
      return changed;
    },
    reset() {
      const changed = level !== 0;
      level = 0;
      last = calmSince = before = Number.NaN;
      climbing = false;
      backOff = BACK_OFF_MS;
      notBefore = 0;
      return changed;
    },
  };
}

/** The pixel ratio to draw at: the device's, capped at 2, times the scale, never under 0.5. */
export function pixelRatio(device: number, scale: number): number {
  return Math.max(0.5, Math.min(device || 1, 2) * scale);
}
