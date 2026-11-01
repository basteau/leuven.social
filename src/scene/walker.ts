/**
 * How the walker moves: along a route or where the keys point, easing into and out of its
 * stride, turning toward where it goes, never stepping off walkable ground. Pure state and
 * maths, so the viewer only feeds it time and input.
 */

/** Walking pace (m/s): brisk, since the character is a little larger than life. */
export const WALK_SPEED = 4.2;
/** Metres covered by one full gait cycle (two steps) at walking pace. */
export const STRIDE = 2.6;
/** Seconds the idle animation plays after stopping, before the scene can rest. */
export const IDLE_SECONDS = 4;
const ACCELERATION = 16;
/** How quickly the heading follows the direction of travel (per second, exponential). */
const TURN_RATE = 12;
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

/**
 * Advances the walker by `dt` seconds. A steering direction (world x, z; length up to 1) wins
 * over a route and cancels it. Returns whether it is still moving, turning or idling, i.e.
 * whether another frame is worth drawing.
 */
export function stepWalker(
  w: Walker,
  dt: number,
  steerX: number,
  steerZ: number,
  /** Whether a body may stand at (x, z), having moved by (dx, dz) to get there. */
  walkable: (x: number, z: number, dx: number, dz: number) => boolean,
): boolean {
  let want = 0;
  let leg = Infinity;
  const steer = Math.hypot(steerX, steerZ);
  const route = steer > 1e-3 ? null : w.route;
  const last = route ? route.length / 2 - 1 : 0;
  if (!route) {
    w.route = null;
    if (steer > 1e-3) {
      [w.dirX, w.dirZ] = [steerX / steer, steerZ / steer];
      want = WALK_SPEED * Math.min(1, steer);
    }
  } else {
    let [dx, dz] = [route[w.next * 2]! - w.x, route[w.next * 2 + 1]! - w.z];
    while (w.next < last && Math.hypot(dx, dz) < ARRIVE) {
      w.next++;
      [dx, dz] = [route[w.next * 2]! - w.x, route[w.next * 2 + 1]! - w.z];
    }
    leg = Math.hypot(dx, dz);
    if (leg > 0) [w.dirX, w.dirZ] = [dx / leg, dz / leg];
    // Slow down over the last metres instead of stopping dead on the spot.
    let left = leg;
    for (let i = w.next; i < last; i++) {
      left += Math.hypot(route[i * 2 + 2]! - route[i * 2]!, route[i * 2 + 3]! - route[i * 2 + 1]!);
    }
    want = Math.min(WALK_SPEED, Math.sqrt(2 * ACCELERATION * left) + 0.5);
  }

  const change = want - w.speed;
  w.speed += Math.max(-ACCELERATION * dt, Math.min(ACCELERATION * dt, change));
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

  const facing = Math.atan2(w.dirX, w.dirZ);
  const turn = wrap(facing - w.heading);
  w.heading = wrap(w.heading + turn * (1 - Math.exp(-TURN_RATE * dt)));
  w.phase = (w.phase + (w.speed / STRIDE) * Math.PI * 2 * dt) % (Math.PI * 2);
  w.still = w.speed > 0 ? 0 : w.still + dt;
  return w.speed > 0 || w.route !== null || Math.abs(turn) > 0.01 || w.still < IDLE_SECONDS;
}
