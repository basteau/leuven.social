/**
 * How the walker moves: along a route or where the stick points, walking or running, easing
 * into and out of its stride, turning in an arc toward where it goes and never stepping off
 * walkable ground. Pure state and maths, so the viewer only feeds it time and input.
 */

/** Walking and running pace (m/s), for a figure a little larger than life. */
export const WALK_SPEED = 2.3;
export const RUN_SPEED = 6.2;
/** Metres covered by one full gait cycle (two steps) walking, and running flat out. */
const STRIDE_WALK = 1.9;
const STRIDE_RUN = 3.6;
/** Seconds the idle animation plays after stopping, before the scene can rest. */
export const IDLE_SECONDS = 4;
/** Speeding up, and slowing down (m/s²). */
const ACCELERATION = 9;
const BRAKE = 14;
/** How quickly the heading follows the wanted direction (per second, exponential): standing, and running. */
const TURN_STANDING = 14;
const TURN_RUNNING = 6;
/** How quickly the measured turn rate settles, for leaning into curves (per second). */
const TURN_SMOOTHING = 10;
const ARRIVE = 0.05;

export interface Walker {
  x: number;
  z: number;
  /** Facing, in radians: 0 looks toward +z (south), π/2 toward +x (east). */
  heading: number;
  speed: number;
  /** Gait phase in radians: the legs swing with its sine. */
  phase: number;
  /** Unit direction of the last move, kept while easing to a stop. */
  dirX: number;
  dirZ: number;
  /** How fast the heading is turning (rad/s, smoothed): positive turns toward +x from +z. */
  turning: number;
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
    phase: 0,
    dirX: Math.sin(heading),
    dirZ: Math.cos(heading),
    turning: 0,
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

/**
 * Advances the walker by `dt` seconds. A steering direction (world x, z; length up to 1) wins
 * over a route and cancels it; `run` runs instead of walking. Returns whether it is still
 * moving, turning or idling, i.e. whether another frame is worth drawing.
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
      want = pace * Math.min(1, steer) * Math.max(0, Math.cos(wrap(facing - w.heading)));
    }
  } else {
    let [dx, dz] = [route[w.next * 2]! - w.x, route[w.next * 2 + 1]! - w.z];
    while (w.next < last && Math.hypot(dx, dz) < ARRIVE) {
      w.next++;
      [dx, dz] = [route[w.next * 2]! - w.x, route[w.next * 2 + 1]! - w.z];
    }
    leg = Math.hypot(dx, dz);
    if (leg > 0) [w.dirX, w.dirZ] = [dx / leg, dz / leg];
    facing = Math.atan2(w.dirX, w.dirZ);
    // Slow down over the last metres instead of stopping dead on the spot.
    let left = leg;
    for (let i = w.next; i < last; i++) {
      left += Math.hypot(route[i * 2 + 2]! - route[i * 2]!, route[i * 2 + 3]! - route[i * 2 + 1]!);
    }
    want = Math.min(pace, Math.sqrt(2 * BRAKE * left) + 0.5);
  }

  const change = want - w.speed;
  w.speed += change > 0 ? Math.min(ACCELERATION * dt, change) : Math.max(-BRAKE * dt, change);

  const turn = wrap(facing - w.heading);
  const rate = TURN_STANDING + (TURN_RUNNING - TURN_STANDING) * runBlend(w.speed);
  const turned = turn * (1 - Math.exp(-rate * dt));
  w.heading = wrap(w.heading + turned);
  const turning = dt > 0 ? turned / dt : 0;
  w.turning += (turning - w.turning) * (1 - Math.exp(-TURN_SMOOTHING * dt));
  // Off a route it goes where it faces, so a change of direction is a curve, not a skid.
  if (!route && steer > 1e-3) {
    w.dirX = Math.sin(w.heading);
    w.dirZ = Math.cos(w.heading);
  }

  if (route) {
    // A route only crosses walkable ground already.
    const step = Math.min(w.speed * dt, leg);
    [w.x, w.z] = [w.x + w.dirX * step, w.z + w.dirZ * step];
    w.travelled += step;
    if (step === leg && w.next === last) {
      w.route = null;
      w.speed = 0;
    }
  } else if (w.speed > 0) {
    const step = w.speed * dt;
    const [nx, nz] = [w.x + w.dirX * step, w.z + w.dirZ * step];
    if (walkable(nx, nz, nx - w.x, nz - w.z)) {
      [w.x, w.z] = [nx, nz];
    } else if (Math.abs(w.dirX) > 0.1 && walkable(nx, w.z, nx - w.x, 0)) {
      w.x = nx; // slide along the wall
    } else if (Math.abs(w.dirZ) > 0.1 && walkable(w.x, nz, 0, nz - w.z)) {
      w.z = nz;
    } else {
      w.speed = 0;
    }
  }

  const stride = STRIDE_WALK + (STRIDE_RUN - STRIDE_WALK) * runBlend(w.speed);
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
