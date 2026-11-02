import { springTo, springToAngle } from './motion.ts';
import type { Spring } from './motion.ts';

/**
 * How the walker moves: along a route or where the stick points, walking or running, easing
 * into and out of its stride, turning in an arc toward where it goes and never stepping off
 * walkable ground. Pure state and maths, so the viewer only feeds it time and input. Speed
 * and heading are critically damped springs, so starting, stopping and turning never snap;
 * step it at a fixed rate (`STEP`) and it walks the same path on any screen.
 *
 * Its body is a circle kept clear of walls, the way a game's character controller collides and
 * slides: a step that would run into a wall goes along it instead, and whatever it still
 * overlaps pushes it gently back out. Walls are met as drawn (`WalkGrid.wallOverlap`), not as
 * metre cells, so slanted facades and corners are glided round rather than caught on cell by
 * cell; the edge of the water or the tracks is a smooth field over the cells.
 */

/** Walking and running pace (m/s), for a figure a little larger than life. */
export const WALK_SPEED = 4;
export const RUN_SPEED = 10.6;
/** The simulation step (s): steps are this long whatever the frame rate. */
export const STEP = 1 / 120;
/** Metres covered by one full gait cycle (two steps) walking, and running flat out. */
export const STRIDE_WALK = 2.1;
export const STRIDE_RUN = 4.8;
/** Seconds the idle animation plays after stopping, before the scene can rest. */
export const IDLE_SECONDS = 4;
/** Half-lives (s) of the speed easing up, and down; below this speed (m/s) it stands. */
const SPEED_UP = 0.13;
const SLOW_DOWN = 0.06;
const STANDING = 0.1;
/** Half-lives (s) of the heading turning toward where it goes: standing, and running. */
const TURN_STANDING = 0.07;
const TURN_RUNNING = 0.14;
/** Slowing to a stop at the end of a route (m/s²), before the speed's own easing. */
const ARRIVAL = 3;
const ARRIVE = 0.05;
/**
 * Half the body's width (m), kept clear of walls, and half its stance, kept off closed ground:
 * the edge of the water or the tracks is no wall, so it may walk right up to it.
 */
const BODY = 0.45;
const FEET = 0.15;
/** A wall within this of the body (m) is touching: steps slide along it. */
const SKIN = 0.04;
/** Fastest a wall pushes the body back out (m/s), so being pushed is never a jump. */
const PUSH = 2;
/** Sliding along a wall at under this share of its pace, it stops instead of creeping. */
const CREEP = 0.15;
/** The eight ways round the body it feels for the edge of closed ground in. */
const AROUND = Array.from({ length: 8 }, (_, k) => [
  Math.sin((k * Math.PI) / 4),
  Math.cos((k * Math.PI) / 4),
]);

/** The ground as a body meets it (a `WalkGrid`). */
export interface Ground {
  /** How far a circle reaches into walls (m), the way out written into `out`; 0 if clear. */
  wallOverlap(x: number, z: number, radius: number, out: [number, number]): number;
  /** How closed the ground is, 0 to 1, with its edge at a half. */
  closed(x: number, z: number): number;
}

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
  ground: Ground,
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
  springTo(speedSpring, want, want > w.speed ? SPEED_UP : SLOW_DOWN, dt);
  // A spring only ever nears its goal: close enough to standing, it stands.
  w.speed = want === 0 && speedSpring.x < STANDING ? 0 : Math.max(0, speedSpring.x);
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
    moveBody(w, w.speed * dt, dt, ground);
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

const normal: [number, number] = [0, 0];
const crease: [number, number] = [0, 0];

const wall: [number, number] = [0, 0];

/**
 * How far the body at (x, z), `skin` metres wider than it is, overlaps walls, or its feet
 * closed ground (m, about); 0 where it's clear, or squeezed equally from both sides as in a
 * narrow lane. Writes the way out into `out`.
 */
function overlap(x: number, z: number, ground: Ground, skin: number, out: [number, number]) {
  let deep = ground.wallOverlap(x, z, BODY + skin, wall);
  let [sx, sz] = deep > 0 ? [wall[0] * deep, wall[1] * deep] : [0, 0];
  for (const [dx, dz] of AROUND) {
    const into = ground.closed(x + dx! * (FEET + skin), z + dz! * (FEET + skin)) - 0.5;
    if (into <= 0) continue;
    [sx, sz, deep] = [sx - dx! * into, sz - dz! * into, Math.max(deep, into)];
  }
  const length = Math.hypot(sx, sz);
  if (length < 1e-6) return 0;
  [out[0], out[1]] = [sx / length, sz / length];
  return deep;
}

/**
 * Steps `step` metres along the walker's direction, less whatever of it runs into a wall the
 * body touches, so it slides along the wall (a second wall it then meets, in a corner, stops
 * it). `slide` keeps the share of its pace that leaves, for the speed to ease to; head on, it
 * stops at once. Then whatever the body still overlaps pushes it back out, no faster than
 * PUSH.
 */
function moveBody(w: Walker, step: number, dt: number, ground: Ground): void {
  let [mx, mz] = [w.dirX, w.dirZ];
  const along = (n: [number, number]) => {
    const into = mx * n[0] + mz * n[1];
    if (into < 0) [mx, mz] = [mx - into * n[0], mz - into * n[1]];
  };
  const touching = overlap(w.x, w.z, ground, SKIN, normal) > 0;
  if (touching) along(normal);
  if (overlap(w.x + mx * step, w.z + mz * step, ground, SKIN, crease) > 0) {
    along(crease);
    // Back into the first wall: walls meeting in a corner, where it stops.
    const corner = normal[0] * crease[0] + normal[1] * crease[1] < 0.7;
    if (touching && corner && mx * normal[0] + mz * normal[1] < -1e-3) [mx, mz] = [0, 0];
  }
  w.slide = Math.hypot(mx, mz);
  if (w.slide < CREEP) {
    w.speed = 0;
    w.accel = 0;
  }
  const move = w.slide < CREEP ? 0 : step / w.slide;
  let [x, z] = [w.x + mx * move, w.z + mz * move];
  const deep = overlap(x, z, ground, 0, normal);
  if (deep > 0) {
    const push = Math.min(deep, PUSH * dt);
    [x, z] = [x + normal[0] * push, z + normal[1] * push];
  }
  // Never onto closed ground, nor further into it from a spot that was.
  if (ground.closed(x, z) < Math.max(0.5, ground.closed(w.x, w.z))) [w.x, w.z] = [x, z];
}
