/**
 * Smoothing that looks the same at 30, 60 or 120 frames a second: exponential decay and
 * critically damped springs in closed form, timed by half-lives, and a fixed-step clock for
 * the simulation under them. Never `x += (goal - x) * k` with a fixed `k`: that eases faster
 * on a faster screen.
 */

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Moves `value` toward `goal`, halving the gap every `halfLife` seconds. */
export function decay(value: number, goal: number, halfLife: number, dt: number): number {
  return halfLife > 0 ? goal + (value - goal) * 2 ** (-dt / halfLife) : goal;
}

/** The same for an angle in radians, the short way round. */
export const decayAngle = (value: number, goal: number, halfLife: number, dt: number) =>
  wrap(decay(value, value + wrap(goal - value), halfLife, dt));

/** A value with momentum: where it is and how fast it's going (per second). */
export interface Spring {
  x: number;
  v: number;
}

export const spring = (x = 0): Spring => ({ x, v: 0 });

/**
 * Pulls a spring toward `goal` without overshooting, exactly for any `dt`: it sets off
 * gently, so a goal that jumps never makes a corner in the motion, and settles about as fast
 * as a decay with the same half-life. After Daniel Holden's "Spring-It-On".
 */
export function springTo(s: Spring, goal: number, halfLife: number, dt: number): void {
  if (halfLife <= 0) {
    s.x = goal;
    s.v = 0;
    return;
  }
  const y = (2 * Math.LN2) / halfLife;
  const j0 = s.x - goal;
  const j1 = s.v + j0 * y;
  const e = Math.exp(-y * dt);
  s.x = e * (j0 + j1 * dt) + goal;
  s.v = e * (s.v - j1 * y * dt);
}

/** The same for an angle in radians, the short way round. */
export function springToAngle(s: Spring, goal: number, halfLife: number, dt: number): void {
  springTo(s, s.x + wrap(goal - s.x), halfLife, dt);
  s.x = wrap(s.x);
}

/** Simulation time kept in whole steps, and how far the clock has run into the next one. */
export interface Clock {
  step: number;
  /** Seconds not yet simulated, under one step. */
  left: number;
}

export const clock = (step: number): Clock => ({ step, left: 0 });

/**
 * Advances the clock by `elapsed` seconds: how many whole steps to simulate now (at most
 * `most`, so a stalled tab doesn't fast-forward). `clock.left / clock.step` is then how far
 * to blend from the previous step's state to the latest for drawing.
 */
export function ticks(c: Clock, elapsed: number, most = 8): number {
  c.left += elapsed;
  const n = Math.min(most, Math.floor(c.left / c.step));
  c.left = n === most ? Math.min(c.left - n * c.step, c.step * 0.999) : c.left - n * c.step;
  return n;
}
