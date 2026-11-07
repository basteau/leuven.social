import { CREEP, moveBody } from './collide.ts';
import type { Ground } from './collide.ts';
import { springTo, springToAngle } from './motion.ts';
import type { Spring } from './motion.ts';

/**
 * How the walker moves: along a route or where the stick points, walking or running, easing
 * into and out of its stride, turning in an arc toward where it goes and never stepping off
 * walkable ground. Pure state and maths, so the viewer only feeds it time and input. Speed
 * and heading are critically damped springs, so starting, stopping and turning never snap;
 * step it at a fixed rate (`STEP`) and it walks the same path on any screen.
 *
 * Its body is a circle kept clear of walls by collide and slide (collide.ts).
 */

/**
 * Walking and running pace (m/s). The figure is a third larger than life, so its paces are
 * too: 5.4 is the jog that open-world games move at by default (about 4.4 m/s life-size, as
 * GTA's and PUBG's), and running a sprint 1.7 times it (about 7 m/s life-size: a game's sprint,
 * and about what a person can keep up), where it was 14.3, faster than a bicycle. Walking is
 * for the streets; the bike (rider.ts) is how to go fast.
 */
export const WALK_SPEED = 5.4;
export const RUN_SPEED = 9.2;
/** The simulation step (s): steps are this long whatever the frame rate. */
export const STEP = 1 / 120;
/** Metres covered by one full gait cycle (two steps) walking, and running flat out. */
export const STRIDE_WALK = 2.6;
export const STRIDE_RUN = 4.8;
/** Seconds the idle animation plays after stopping, before the scene can rest. */
export const IDLE_SECONDS = 7;
/** Half-lives (s) of the speed easing up, and down; below this speed (m/s) it stands. */
const SPEED_UP = 0.13;
const SLOW_DOWN = 0.06;
/** How quickly the lean follows the acceleration (s, a time constant). */
const SURGE_EASE = 0.1;
const STANDING = 0.1;
/** Half-lives (s) of the heading turning toward where it goes: standing, and running. */
const TURN_STANDING = 0.07;
const TURN_RUNNING = 0.14;
/** Slowing to a stop at the end of a route (m/s²), before the speed's own easing. */
const ARRIVAL = 3;
const ARRIVE = 0.05;
/** Half the body's width (m), kept clear of walls (collide.ts). */
const BODY = 0.45;

/**
 * How a body moves: its paces walking and running (m/s), the half-lives of its speed easing up
 * and down and of its heading turning standing and flat out (s), its radius (m), and, for a
 * wheel rather than legs, the metres one turn of `phase` covers. On foot by default; a bike
 * (bikes.ts) is the same body with momentum.
 */
export interface Pace {
  walk: number;
  run: number;
  up: number;
  down: number;
  turn: readonly [standing: number, running: number];
  body: number;
  stride?: number;
}

export const ON_FOOT: Pace = {
  walk: WALK_SPEED,
  run: RUN_SPEED,
  up: SPEED_UP,
  down: SLOW_DOWN,
  turn: [TURN_STANDING, TURN_RUNNING],
  body: BODY,
};

export interface Walker {
  x: number;
  z: number;
  /** Facing, in radians: 0 looks toward +z (south), π/2 toward +x (east). */
  heading: number;
  speed: number;
  /** How fast the speed is changing (m/s²). */
  accel: number;
  /**
   * The same eased over a few hundredths of a second (m/s²), which leans the body setting off
   * and stopping: letting go, `accel` leaps in a step, and the lean would with it.
   */
  surge: number;
  /** Gait phase in radians: the legs swing with its sine. */
  phase: number;
  /** Unit direction of the last move, kept while easing to a stop. */
  dirX: number;
  dirZ: number;
  /** How fast the heading is turning (rad/s): positive turns toward +x from +z. */
  turning: number;
  /** The share of its pace the ground ahead allows: 1 in the open, less sliding along a wall. */
  slide: number;
  /** Waypoints being walked, and the index (in points) of the next one. */
  route: Float32Array | null;
  next: number;
  /** Metres walked along the current route. */
  travelled: number;
  /** Seconds since it last stood still, or 0 while moving. */
  still: number;
}

export function createWalker(x: number, z: number, heading = 0): Walker {
  return {
    x,
    z,
    heading,
    speed: 0,
    accel: 0,
    surge: 0,
    phase: 0,
    dirX: Math.sin(heading),
    dirZ: Math.cos(heading),
    turning: 0,
    slide: 1,
    route: null,
    next: 0,
    travelled: 0,
    still: 0,
  };
}

/** Starts walking a route that begins where the walker stands. */
export function followRoute(w: Walker, route: Float32Array): void {
  w.route = route;
  w.next = 1;
  w.travelled = 0;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** How far from a walk into a run a speed is: 0 at walking pace or slower, 1 flat out. */
export const runBlend = (speed: number) =>
  Math.min(1, Math.max(0, (speed - WALK_SPEED) / (RUN_SPEED - WALK_SPEED)));

const speedSpring: Spring = { x: 0, v: 0 };
const headingSpring: Spring = { x: 0, v: 0 };

/**
 * Advances the walker by `dt` seconds (best a whole `STEP`). A steering direction (world x,
 * z; length up to 1) wins over a route and cancels it; `run` runs instead of walking. Returns
 * whether it is still moving, turning or idling, i.e. whether another frame is worth drawing.
 */
export function stepWalker(
  w: Walker,
  dt: number,
  steerX: number,
  steerZ: number,
  ground: Ground,
  run = false,
  how: Pace = ON_FOOT,
): boolean {
  const pace = run ? how.run : how.walk;
  let want = 0;
  let leg = Infinity;
  let facing = w.heading;
  const steer = Math.hypot(steerX, steerZ);
  const route = steer > 1e-3 ? null : w.route;
  const last = route ? route.length / 2 - 1 : 0;
  if (!route) {
    w.route = null;
    if (steer > 1e-3) {
      facing = Math.atan2(steerX, steerZ);
      // Sharp turns slow it down: it turns on the spot, then sets off in an arc. Along a wall it
      // goes at the share of its pace the wall leaves; into one, not at all.
      const turning = Math.max(0, Math.cos(wrap(facing - w.heading)));
      want = pace * Math.min(1, steer) * turning * (w.slide < CREEP ? 0 : w.slide);
    }
  } else {
    let dx = route[w.next * 2]! - w.x;
    let dz = route[w.next * 2 + 1]! - w.z;
    while (w.next < last && Math.hypot(dx, dz) < ARRIVE) {
      w.next++;
      dx = route[w.next * 2]! - w.x;
      dz = route[w.next * 2 + 1]! - w.z;
    }
    leg = Math.hypot(dx, dz);
    if (leg > 0) {
      w.dirX = dx / leg;
      w.dirZ = dz / leg;
    }
    facing = Math.atan2(w.dirX, w.dirZ);
    // Slow down over the last metres instead of stopping dead on the spot.
    let left = leg;
    for (let i = w.next; i < last; i++) {
      left += Math.hypot(route[i * 2 + 2]! - route[i * 2]!, route[i * 2 + 3]! - route[i * 2 + 1]!);
    }
    want = Math.min(pace, Math.sqrt(2 * ARRIVAL * left));
  }

  speedSpring.x = w.speed;
  speedSpring.v = w.accel;
  springTo(speedSpring, want, want > w.speed ? how.up : how.down, dt);
  // A spring only ever nears its goal: close enough to standing, it stands.
  w.speed = want === 0 && speedSpring.x < STANDING ? 0 : Math.max(0, speedSpring.x);
  w.accel = w.speed > 0 ? speedSpring.v : 0;
  w.surge += (w.accel - w.surge) * (1 - Math.exp(-dt / SURGE_EASE));
  if (Math.abs(w.surge) < 1e-3) w.surge = 0;

  const turn = wrap(facing - w.heading);
  headingSpring.x = w.heading;
  headingSpring.v = w.turning;
  const blend = runBlend(w.speed);
  const [standing, running] = how.turn;
  springToAngle(headingSpring, facing, standing + (running - standing) * blend, dt);
  w.heading = headingSpring.x;
  w.turning = headingSpring.v;
  // Off a route it goes where it faces, so a change of direction is a curve, not a skid.
  if (!route && steer > 1e-3) {
    w.dirX = Math.sin(w.heading);
    w.dirZ = Math.cos(w.heading);
  }

  if (route) {
    // A route only crosses walkable ground already.
    const step = Math.min(w.speed * dt, leg);
    w.x += w.dirX * step;
    w.z += w.dirZ * step;
    w.travelled += step;
    // At the end it lets go of the route and coasts the last few centimetres to a stop.
    if (step === leg && w.next === last) w.route = null;
  } else if (w.speed > 0 || steer > 1e-3) {
    moveBody(w, w.speed * dt, dt, ground, how.body);
  }

  const stride = how.stride ?? STRIDE_WALK + (STRIDE_RUN - STRIDE_WALK) * blend;
  w.phase = (w.phase + (w.speed / stride) * Math.PI * 2 * dt) % (Math.PI * 2);
  w.still = w.speed > 0 ? 0 : w.still + dt;
  return (
    w.speed > 0 ||
    w.route !== null ||
    Math.abs(turn) > 0.01 ||
    Math.abs(w.turning) > 0.01 ||
    w.surge !== 0 ||
    w.still < IDLE_SECONDS
  );
}
