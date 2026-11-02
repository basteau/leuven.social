/**
 * The map turning while a turn control is held: it gathers speed, keeps turning, and once let go
 * slows onto a quarter view, the only views the isometric map rests at. Never back: it settles
 * on the next quarter view ahead.
 */

const QUARTER = Math.PI / 2;
/** Held, the map turns this fast (rad/s): a quarter turn in half a second. */
export const SPIN_RATE = Math.PI;
/** It gets up to speed, and slows down, at this rate (rad/s²): a quarter of a second. */
export const SPIN_EASE = 4 * Math.PI;

export interface Spin {
  /** The control held: -1 left, 1 right, 0 let go. */
  held: number;
  /** How fast it turns now (rad/s), signed like `held`; 0 at rest. */
  rate: number;
  /** The quarter view it settles on once let go; NaN until then. */
  to: number;
}

/** The first quarter view at or past `yaw`, going `direction`. */
export function quarterAhead(yaw: number, direction: number): number {
  const quarters = (yaw - Math.PI / 4) / QUARTER;
  const whole = direction > 0 ? Math.ceil(quarters - 1e-9) : Math.floor(quarters + 1e-9);
  return whole * QUARTER + Math.PI / 4;
}

const approach = (from: number, to: number, step: number) =>
  Math.abs(to - from) <= step ? to : from + Math.sign(to - from) * step;

/**
 * Turns `yaw` on by `dt` seconds and returns where it is. Let go, it brakes onto the first
 * quarter view past where a brake twice as firm as `ease` would stop, so it never reverses or
 * jolts, and it lands with no speed left: `spin.rate` is then 0.
 */
export function spinStep(spin: Spin, yaw: number, dt: number, ease = SPIN_EASE): number {
  const way = Math.sign(spin.held || spin.rate);
  if (!way) return yaw;
  if (spin.held) {
    spin.rate = approach(spin.rate, way * SPIN_RATE, ease * dt);
    return yaw + spin.rate * dt;
  }
  if (Number.isNaN(spin.to)) spin.to = quarterAhead(yaw + (spin.rate ** 2 / (4 * ease)) * way, way);
  const left = (spin.to - yaw) * way;
  // The brake that stops right on it: once that's as firm as the ease, it's time to slow down.
  const brake = spin.rate ** 2 / (2 * left);
  spin.rate =
    brake >= ease ? spin.rate - way * brake * dt : approach(spin.rate, way * SPIN_RATE, ease * dt);
  const next = yaw + spin.rate * dt;
  if ((spin.to - next) * way > 1e-4 && spin.rate * way > 0) return next;
  const to = spin.to;
  [spin.rate, spin.to] = [0, Number.NaN];
  return to;
}
