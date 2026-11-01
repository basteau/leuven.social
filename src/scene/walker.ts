import { springTo, springToAngle } from './motion.ts';
import type { Spring } from './motion.ts';

/**
 * How the walker moves: along a route or where the stick points, walking or running, easing
 * into and out of its stride, turning in an arc toward where it goes and never stepping off
 * walkable ground. Pure state and maths, so the viewer only feeds it time and input. Speed
 * and heading are critically damped springs, so starting, stopping and turning never snap;
 * step it at a fixed rate (`STEP`) and it walks the same path on any screen.
 */

/** Walking and running pace (m/s), for a figure a little larger than life. */
export const WALK_SPEED = 2.8;
export const RUN_SPEED = 7.5;
/** The simulation step (s): steps are this long whatever the frame rate. */
export const STEP = 1 / 120;
/** Metres covered by one full gait cycle (two steps) walking, and running flat out. */
const STRIDE_WALK = 2.2;
const STRIDE_RUN = 4.2;
/** Seconds the idle animation plays after stopping, before the scene can rest. */
export const IDLE_SECONDS = 4;
/** Half-lives (s) of the speed easing up, and down. */
const SPEED_UP = 0.13;
const SLOW_DOWN = 0.08;
/** Half-lives (s) of the heading turning toward where it goes: standing, and running. */
const TURN_STANDING = 0.07;
const TURN_RUNNING = 0.14;
/** Slowing to a stop at the end of a route (m/s²), before the speed's own easing. */
const ARRIVAL = 3;
const ARRIVE = 0.05;
/** How far ahead it feels for walls (m), and the angles it tries to slide along them at. */
const FEEL = 0.05;
const SLIDES = [Math.PI / 8, Math.PI / 4, (3 * Math.PI) / 8];

export interface Walker {
  x: number;
  z: number;
  /** Facing, in radians: 0 looks toward +z (south), π/2 toward +x (east). */
  heading: number;
  speed: number;
  /** How fast the speed is changing (m/s²). */
  accel: number;
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
  /** Whether a body may stand at (x, z), having moved by (dx, dz) to get there. */
  walkable: (x: number, z: number, dx: number, dz: number) => boolean,
  run = false,
): boolean {
  const pace = run ? RUN_SPEED : WALK_SPEED;
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
      // Sharp turns slow it down: it turns on the spot, then sets off in an arc.
      want = pace * Math.min(1, steer) * Math.max(0, Math.cos(wrap(facing - w.heading))) * w.slide;
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
  springTo(speedSpring, want, want > w.speed ? SPEED_UP : SLOW_DOWN, dt);
  // A spring only ever nears its goal: close enough to standing, it stands.
  w.speed = want === 0 && speedSpring.x < 0.03 ? 0 : Math.max(0, speedSpring.x);
  w.accel = w.speed > 0 ? speedSpring.v : 0;

  const turn = wrap(facing - w.heading);
  headingSpring.x = w.heading;
  headingSpring.v = w.turning;
  const blend = runBlend(w.speed);
  springToAngle(headingSpring, facing, TURN_STANDING + (TURN_RUNNING - TURN_STANDING) * blend, dt);
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
    moveAlongWalls(w, w.speed * dt, walkable);
  }

  const stride = STRIDE_WALK + (STRIDE_RUN - STRIDE_WALK) * blend;
  w.phase = (w.phase + (w.speed / stride) * Math.PI * 2 * dt) % (Math.PI * 2);
  w.still = w.speed > 0 ? 0 : w.still + dt;
  return (
    w.speed > 0 ||
    w.route !== null ||
    Math.abs(turn) > 0.01 ||
    Math.abs(w.turning) > 0.01 ||
    w.still < IDLE_SECONDS
  );
}

/**
 * Steps `step` metres along the walker's direction, or, where a wall is in the way, along the
 * nearest direction that slides past it, slower the more it has to turn aside. Feels ahead
 * even standing, so `slide` says what the next step may do and the speed eases to it.
 */
function moveAlongWalls(
  w: Walker,
  step: number,
  walkable: (x: number, z: number, dx: number, dz: number) => boolean,
): void {
  const feel = Math.max(step, FEEL);
  if (walkable(w.x + w.dirX * feel, w.z + w.dirZ * feel, w.dirX * feel, w.dirZ * feel)) {
    w.slide = 1;
    w.x += w.dirX * step;
    w.z += w.dirZ * step;
    return;
  }
  for (const angle of SLIDES) {
    for (const side of [1, -1]) {
      const [c, s] = [Math.cos(angle), Math.sin(angle * side)];
      const dx = w.dirX * c + w.dirZ * s;
      const dz = w.dirZ * c - w.dirX * s;
      if (!walkable(w.x + dx * feel * c, w.z + dz * feel * c, dx * feel * c, dz * feel * c)) {
        continue;
      }
      w.slide = c;
      w.x += dx * step * c;
      w.z += dz * step * c;
      return;
    }
  }
  // Head on into a wall: it stops, and stays stopped while pushed against it.
  w.slide = 0;
  w.speed = 0;
  w.accel = 0;
}
