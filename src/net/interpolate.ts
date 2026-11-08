/**
 * Smooths another player's figure between the server's 10 Hz updates. Each update is kept with
 * the time it arrived, and the figure is drawn a little in the past (`delay`), between the two
 * updates around that moment, so it glides at an even pace however unevenly packets land. When
 * the updates run out it carries on the way it faces at its own pace for a moment, about as long
 * as the last gap between updates (in a crowd a far figure is told of once a second), then stops,
 * rather than running off. A jump of more than `snap` metres, or a change of room or floor, is a door or a
 * teleport: the figure is shown at the old spot until the new one's time and then at the new
 * one, never sliding through walls in between.
 */

import type { PlayerState } from './protocol.ts';

export interface InterpolationOptions {
  /** How far in the past to draw (ms): a little over one server tick. */
  delay?: number;
  /** The figure keeps going past its last update for at least this long (ms), and longer if
   * updates come further apart, up to `MOST_AHEAD`. */
  extrapolate?: number;
  /** Two updates further apart than this (m) are a jump, not a walk. */
  snap?: number;
  /** Updates kept; older ones are no longer needed once the draw time has passed them. */
  keep?: number;
}

export interface Snapshots {
  /** Records a state received at `time` (ms, any steady clock such as `performance.now()`). */
  push(time: number, state: PlayerState): void;
  /**
   * The state to draw at `now` (ms, the same clock), or null before the first update. Written
   * into `out` if given, so a frame of a crowd allocates nothing.
   */
  sample(now: number, out?: PlayerState): PlayerState | null;
  /** The latest state received, unsmoothed. */
  latest(): PlayerState | null;
}

export const DEFAULT_DELAY = 120;
export const DEFAULT_EXTRAPOLATE = 200;
export const DEFAULT_SNAP = 15;

const TURN = Math.PI * 2;
/** The server's tick (ms), and a gap between updates that means the figure stood still. */
const TICK = 100;
const PAUSE = 250;
/** How much of a gap (at most `MOST_AHEAD` ms) it dead-reckons across while updates are sparse. */
const AHEAD_SHARE = 1.25;
const MOST_AHEAD = 1500;

/** The signed angle from `a` to `b` the short way round, in (-π, π]. */
export function shortestArc(a: number, b: number): number {
  const d = (((b - a) % TURN) + TURN) % TURN;
  return d > Math.PI ? d - TURN : d;
}

interface Snapshot {
  time: number;
  state: PlayerState;
}

const jumped = (a: PlayerState, b: PlayerState, snap: number) =>
  a.place !== b.place || a.floor !== b.floor || Math.hypot(b.x - a.x, b.z - a.z) > snap;

/** Writes a copy of `from` into `out` (if any); returns the one to hand back. */
function copy(from: PlayerState, out: PlayerState | undefined): PlayerState {
  return out ? Object.assign(out, from) : from;
}

export function createSnapshots(options: InterpolationOptions = {}): Snapshots {
  const delay = options.delay ?? DEFAULT_DELAY;
  const extrapolate = options.extrapolate ?? DEFAULT_EXTRAPOLATE;
  const snap = options.snap ?? DEFAULT_SNAP;
  const keep = Math.max(2, options.keep ?? 32);
  const buffer: Snapshot[] = [];

  return {
    push(time, state) {
      // Two updates in the same millisecond (or a clock that stepped back): the newer one wins.
      const last = buffer.at(-1);
      if (last && time <= last.time) {
        last.state = state;
        return;
      }
      // After a pause (the server only sends a figure that moved), start from where it stood one
      // tick ago, or its first steps would be squeezed into the tail of the pause.
      // A figure that was moving is one a crowd only tells of in turns: it glides across the gap.
      if (last && time - last.time > PAUSE && last.state.speed === 0) {
        buffer.push({ time: time - TICK, state: last.state });
      }
      buffer.push({ time, state });
      while (buffer.length > keep) buffer.shift();
    },

    sample(now, out) {
      const first = buffer[0];
      const last = buffer.at(-1);
      if (!first || !last) return null;
      const t = now - delay;
      if (t <= first.time) return copy(first.state, out);

      if (t >= last.time) {
        const before = buffer.at(-2);
        if (!before || last.state.speed === 0 || jumped(before.state, last.state, snap)) {
          return copy(last.state, out);
        }
        // Keep going for a moment only, the way it faces at the pace it said: not the way the last
        // two updates went, which two packets a millisecond apart would stretch into a leap.
        const reach = Math.max(
          extrapolate,
          Math.min(MOST_AHEAD, (last.time - before.time) * AHEAD_SHARE),
        );
        const ahead = (Math.min(t - last.time, reach) / 1000) * last.state.speed;
        const { x, z, heading } = last.state;
        const to = out ?? { ...last.state };
        Object.assign(to, last.state);
        to.x = x + Math.sin(heading) * ahead;
        to.z = z + Math.cos(heading) * ahead;
        return to;
      }

      // Drop what the draw time has passed, keeping the update just before it.
      let i = 0;
      while (buffer[i + 1]!.time <= t) i++;
      buffer.splice(0, i);
      const a = buffer[0]!;
      const b = buffer[1]!;
      if (jumped(a.state, b.state, snap)) return copy(a.state, out);
      const u = (t - a.time) / (b.time - a.time);
      const to = out ?? { ...a.state };
      Object.assign(to, u < 1 ? a.state : b.state);
      to.x = a.state.x + (b.state.x - a.state.x) * u;
      to.z = a.state.z + (b.state.z - a.state.z) * u;
      to.heading = a.state.heading + shortestArc(a.state.heading, b.state.heading) * u;
      to.speed = a.state.speed + (b.state.speed - a.state.speed) * u;
      return to;
    },

    latest: () => buffer.at(-1)?.state ?? null,
  };
}
