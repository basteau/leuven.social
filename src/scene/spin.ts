/**
 * The map turning on its own: under a held control or key, and gliding on after a flick. One
 * motion from press to rest, however short the press: it gets up to speed at once, and let go it
 * brakes to a stop wherever that lands. The map rests at any angle. A quick tap still goes a
 * useful way (`NUDGE`), and taps in a row add up.
 */

/** Held, the map turns this fast (rad/s): once round in three seconds. */
export const SPIN_RATE = (2 * Math.PI) / 3;
/** It gets up to speed, and slows down, at this rate (rad/s²): about a seventh of a second. */
export const SPIN_EASE = 14;
/** The least one press turns the map (rad), the same however short: an eighth of the way round. */
export const NUDGE = Math.PI / 4;
/** A flick slower than this (rad/s) just stops: 60°/s, as MapLibre has it. */
export const COAST_MIN = Math.PI / 3;
/** A flick glides as if no faster than this (rad/s), so it goes on 40° at most. */
export const COAST_MAX = Math.PI;
/** A flick dies away more gently than a control lets go (rad/s²). */
export const COAST_EASE = 7;

export interface Spin {
  /** The control held: -1 left, 1 right, 0 let go. */
  held: number;
  /** How fast it turns now (rad/s), signed like `held`; 0 at rest. */
  rate: number;
  /** The yaw a press has to reach at least, let go however soon; NaN when there's no press. */
  least: number;
  /** The yaw it stops at, known once it's let go; NaN until then. */
  to: number;
  /** How firmly it speeds up and brakes (rad/s²). */
  ease: number;
}

export const newSpin = (): Spin => ({
  held: 0,
  rate: 0,
  least: Number.NaN,
  to: Number.NaN,
  ease: SPIN_EASE,
});

/** Stops dead: something else has taken the map. */
export function stopSpin(spin: Spin): void {
  Object.assign(spin, newSpin());
}

/** Whether there's anything left to animate. */
export const spinning = (spin: Spin): boolean =>
  spin.held !== 0 || spin.rate !== 0 || !Number.isNaN(spin.least) || !Number.isNaN(spin.to);

/** A turn control goes down. Going the same way as a turn still under way, it adds to it. */
export function pressSpin(spin: Spin, yaw: number, direction: number): void {
  const bound = [spin.to, spin.least].find((end) => Math.sign(end - yaw) === direction);
  spin.held = direction;
  spin.least = (bound ?? yaw) + direction * NUDGE;
  spin.to = Number.NaN;
  spin.ease = SPIN_EASE;
}

/** A hand comes off the map at `rate` (rad/s): whether that's fast enough to glide on. */
export function coastSpin(spin: Spin, rate: number): boolean {
  if (Math.abs(rate) < COAST_MIN) return false;
  stopSpin(spin);
  spin.rate = Math.sign(rate) * Math.min(COAST_MAX, Math.abs(rate));
  spin.ease = COAST_EASE;
  return true;
}

const approach = (from: number, to: number, step: number) =>
  Math.abs(to - from) <= step ? to : from + Math.sign(to - from) * step;

/**
 * Turns `yaw` on by `dt` seconds and returns where it is. Held it keeps turning; let go it brakes
 * to a stop, going at least as far as the press asked, so it never reverses or jolts, and it lands
 * with no speed left.
 */
export function spinStep(spin: Spin, yaw: number, dt: number, ease = spin.ease): number {
  const toward = Math.sign(spin.least - yaw);
  // A tap against a turn under way: carry on turning it round, even once let go.
  const push = spin.held || (spin.rate * toward < 0 ? toward : 0);
  if (push) {
    spin.rate = approach(spin.rate, push * SPIN_RATE, ease * dt);
    const next = yaw + spin.rate * dt;
    // Gone as far as it had to: from here on, it stops wherever it's let go.
    if ((next - spin.least) * push >= 0) spin.least = Number.NaN;
    return next;
  }
  if (Number.isNaN(spin.to)) {
    const going = Math.sign(spin.rate || toward);
    if (!going) return yaw;
    const stops = yaw + going * (spin.rate ** 2 / (2 * ease));
    const least = Number.isNaN(spin.least) ? stops : spin.least;
    spin.to = going * Math.max(going * stops, going * least);
    spin.least = Number.NaN;
  }
  const way = Math.sign(spin.rate || spin.to - yaw);
  const left = (spin.to - yaw) * way;
  // The brake that stops right on it: once that's as firm as the ease, it's time to slow down.
  const brake = spin.rate ** 2 / (2 * left);
  spin.rate =
    brake >= ease * 0.999
      ? spin.rate - way * brake * dt
      : approach(spin.rate, way * SPIN_RATE, ease * dt);
  const next = yaw + spin.rate * dt;
  if ((spin.to - next) * way > 1e-4 && spin.rate * way > 0) return next;
  const to = spin.to;
  stopSpin(spin);
  return to;
}
