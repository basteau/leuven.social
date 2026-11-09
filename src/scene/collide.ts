/**
 * How a body meets the city, the way a game's character controller collides and slides: a step
 * that would run into a wall goes along it instead, and whatever the body still overlaps pushes
 * it gently back out. Walls are met as drawn (`WalkGrid.wallOverlap`), not as metre cells, so
 * slanted facades and corners are glided round rather than caught on cell by cell; the edge of
 * the water or the tracks is a smooth field over the cells. The walker's body and the bike's
 * are circles of their own size in the same rules.
 */

/** The ground as a body meets it (a `WalkGrid`). */
export interface Ground {
  /** How far a circle reaches into walls (m), the way out written into `out`; 0 if clear. */
  wallOverlap(x: number, z: number, radius: number, out: [number, number]): number;
  /** How closed the ground is, 0 to 1, with its edge at a half. */
  closed(x: number, z: number): number;
}

/** A body moving over the ground: where it is, which way and how fast it goes. */
export interface Body {
  x: number;
  z: number;
  /** Unit direction it moves in. */
  dirX: number;
  dirZ: number;
  speed: number;
  /** How fast the speed is changing (m/s²). */
  accel: number;
  /** The share of its pace the ground ahead allows: 1 in the open, less sliding along a wall. */
  slide: number;
}

/** Half a body's stance, kept off closed ground: the edge of the water or the tracks is no wall. */
const FEET = 0.15;
/** A wall within this of the body (m) is touching: steps slide along it. */
const SKIN = 0.04;
/** Fastest a wall pushes the body back out (m/s), so being pushed is never a jump. */
const PUSH = 2;
/** Sliding along a wall at under this share of its pace, it stops instead of creeping. */
export const CREEP = 0.15;
/** The eight ways round the body it feels for the edge of closed ground in. */
const AROUND = Array.from({ length: 8 }, (_, k) => [
  Math.sin((k * Math.PI) / 4),
  Math.cos((k * Math.PI) / 4),
]);

/**
 * Things that stand in the street for a while, met as circles: the bikes someone left on their
 * stands. Flat [x, z, radius, …] triples, which riding fills.
 */
export const loose: number[] = [];

const wall: [number, number] = [0, 0];

/**
 * How far a body of `radius` at (x, z), `skin` metres wider than it is, overlaps walls or loose
 * things, or its feet closed ground (m, about); 0 where it's clear, or squeezed equally from both
 * sides as in a narrow lane. Writes the way out into `out`.
 */
export function overlap(
  x: number,
  z: number,
  ground: Ground,
  radius: number,
  skin: number,
  out: [number, number],
): number {
  let deep = ground.wallOverlap(x, z, radius + skin, wall);
  let [sx, sz] = deep > 0 ? [wall[0] * deep, wall[1] * deep] : [0, 0];
  for (let i = 0; i + 2 < loose.length; i += 3) {
    const [dx, dz] = [x - loose[i]!, z - loose[i + 1]!];
    const d = Math.hypot(dx, dz);
    const into = radius + skin + loose[i + 2]! - d;
    if (into <= 0 || d < 1e-9) continue;
    [sx, sz, deep] = [sx + (dx / d) * into, sz + (dz / d) * into, Math.max(deep, into)];
  }
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

const normal: [number, number] = [0, 0];
const crease: [number, number] = [0, 0];

/**
 * Steps `step` metres along the body's direction, less whatever of it runs into a wall the
 * body (a circle of `radius`) touches, so it slides along the wall (a second wall it then meets,
 * in a corner, stops it). `slide` keeps the share of its pace that leaves, for the speed to ease
 * to; head on, it stops at once. Then whatever the body still overlaps pushes it back out, no
 * faster than PUSH.
 */
export function moveBody(b: Body, step: number, dt: number, ground: Ground, radius: number): void {
  let [mx, mz] = [b.dirX, b.dirZ];
  const along = (n: [number, number]) => {
    const into = mx * n[0] + mz * n[1];
    if (into < 0) [mx, mz] = [mx - into * n[0], mz - into * n[1]];
  };
  const touching = overlap(b.x, b.z, ground, radius, SKIN, normal) > 0;
  if (touching) along(normal);
  if (overlap(b.x + mx * step, b.z + mz * step, ground, radius, SKIN, crease) > 0) {
    along(crease);
    // Back into the first wall: walls meeting in a corner, where it stops.
    const corner = normal[0] * crease[0] + normal[1] * crease[1] < 0.7;
    if (touching && corner && mx * normal[0] + mz * normal[1] < -1e-3) [mx, mz] = [0, 0];
  }
  b.slide = Math.hypot(mx, mz);
  if (b.slide < CREEP) {
    b.speed = 0;
    b.accel = 0;
  }
  const move = b.slide < CREEP ? 0 : step / b.slide;
  settle(b, b.x + mx * move, b.z + mz * move, dt, ground, radius);
}

/**
 * Puts the body at (x, z), eased back out of whatever it overlaps there at up to PUSH, and never
 * onto closed ground, nor further into it from a spot that was.
 */
export function settle(
  b: { x: number; z: number },
  x: number,
  z: number,
  dt: number,
  ground: Ground,
  radius: number,
): void {
  const deep = overlap(x, z, ground, radius, 0, normal);
  if (deep > 0) {
    const push = Math.min(deep, PUSH * dt);
    [x, z] = [x + normal[0] * push, z + normal[1] * push];
  }
  if (ground.closed(x, z) < Math.max(0.5, ground.closed(b.x, b.z))) [b.x, b.z] = [x, z];
}
