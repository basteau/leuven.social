import { decay, decayAngle } from './motion.ts';

/**
 * The walking camera: a perspective camera on a boom behind the walker, turned by dragging,
 * pulled in when a house stands between it and the walker, and flown in from the map's
 * isometric view and back. Pure maths, so the glue in walk.ts only feeds it input and time.
 * Input moves where the boom aims; the boom eases there by half-lives (motion.ts), so it
 * moves the same at any frame rate and pointer events that arrive unevenly don't judder.
 */

export type Vec3 = [number, number, number];

/** Field of view while walking, and at the ends of the flight to and from the map (degrees). */
export const CHASE_FOV = 50;
export const MAP_FOV = 6;
/** Tall screens see at least this much side to side (degrees), so phones keep the street. */
const MIN_SIDE_FOV = 44;
/** Where the camera looks: a little above the walker's head (m). */
export const LOOK_HEIGHT = 2.6;
/** Boom pitch (radians, down is positive) and length (m): default and limits. */
export const PITCH = 0.32;
export const PITCH_RANGE = [-0.22, 1.3] as const;
export const DISTANCE = 7.5;
export const DISTANCE_RANGE = [2.5, 40] as const;
/** A run widens the lens by this much (degrees) and lengthens the boom by this share. */
const RUN_FOV = 5;
const RUN_PULL = 0.12;
/** Half-lives (s): the boom turning to where it's aimed, and changing length. */
const AIM_EASE = 0.035;
const LENGTH_EASE = 0.15;
/** Half-lives (s) of pulling in for a wall, and letting out again once past it. */
const PULL_IN = 0.045;
const LET_OUT = 0.3;
/** How close the camera may come to a wall, a roof or the ground (m). */
const CLEARANCE = 0.5;
/** Steps the boom is checked in (m). */
const STEP = 0.5;
/** Above this (m) nothing in the city stands: the tallest roof is 74 m, heights stop at 90. */
const ROOF_LIMIT = 100;

export interface Boom {
  /** Direction from the walker to the camera, in radians: 0 is toward +z, π/2 toward +x. */
  yaw: number;
  pitch: number;
  /** Where input and recentring point the boom; yaw and pitch ease there. */
  aimYaw: number;
  aimPitch: number;
  /** Length the person chose, the length it is easing to that, and the length free of walls. */
  distance: number;
  length: number;
  reach: number;
  /**
   * The lowest the boom may sit just now (pitch), raised where a short boom would bring the
   * camera into the walker's head; the boom is drawn at whichever of this and `pitch` is higher.
   */
  floor: number;
}

export const createBoom = (yaw: number): Boom => ({
  yaw,
  pitch: PITCH,
  aimYaw: yaw,
  aimPitch: PITCH,
  distance: DISTANCE,
  length: DISTANCE,
  reach: DISTANCE,
  floor: PITCH,
});

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));
export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Aims the boom further round by the given angles, its pitch between looking up and down. */
export function turnBoom(boom: Boom, yaw: number, pitch: number): void {
  boom.aimYaw = wrap(boom.aimYaw + yaw);
  boom.aimPitch = clamp(boom.aimPitch + pitch, PITCH_RANGE);
}

/**
 * Eases the boom toward its aim and its length toward the one chosen, a little longer at a
 * run (`run`, 0 to 1). Returns whether it is still on its way.
 */
export function easeBoom(boom: Boom, run: number, dt: number): boolean {
  boom.yaw = decayAngle(boom.yaw, boom.aimYaw, AIM_EASE, dt);
  boom.pitch = decay(boom.pitch, boom.aimPitch, AIM_EASE, dt);
  const length = boom.distance * (1 + RUN_PULL * run);
  boom.length = decay(boom.length, length, LENGTH_EASE, dt);
  return (
    Math.abs(wrap(boom.aimYaw - boom.yaw)) > 1e-4 ||
    Math.abs(boom.aimPitch - boom.pitch) > 1e-4 ||
    Math.abs(boom.length - length) > 1e-3
  );
}

/** Lengthens the boom by `factor`, within its limits. */
export function stretchBoom(boom: Boom, factor: number): void {
  boom.distance = clamp(boom.distance * factor, DISTANCE_RANGE);
}

/**
 * The vertical field of view for a screen's aspect: wider on tall screens, and a little wider
 * at a run (`run`, 0 to 1) for the sense of speed (degrees).
 */
export function chaseFov(aspect: number, run = 0): number {
  const side = Math.tan((MIN_SIDE_FOV * Math.PI) / 360) / aspect;
  return Math.max(CHASE_FOV, (Math.atan(side) * 360) / Math.PI) + RUN_FOV * run;
}

/** Unit direction from the look point out along the boom, written into `out`. */
export function boomDirection(yaw: number, pitch: number, out: Vec3): Vec3 {
  out[0] = Math.sin(yaw) * Math.cos(pitch);
  out[1] = Math.sin(pitch);
  out[2] = Math.cos(yaw) * Math.cos(pitch);
  return out;
}

/**
 * Whether a point is inside something besides the houses and the ground that the camera keeps
 * out of, such as a tree; things that hold `from`, where the boom starts, don't count.
 */
export type Solid = (x: number, y: number, z: number, from: Vec3) => boolean;

/**
 * How far the camera can back away from `from` along `dir` (up to `max`) before it would sit
 * inside a building, under the ground or in something `solid`, less a margin. It walks the boom
 * in steps, then halves the step it hit in a few times, so the length changes smoothly as the
 * walker moves rather than jumping a step at a time. Never less than one step.
 */
export function freeLength(
  heightAt: (x: number, z: number) => number,
  from: Vec3,
  dir: Vec3,
  max: number,
  solid?: Solid,
): number {
  const blocked = (t: number) => {
    const [x, y, z] = [from[0] + dir[0] * t, from[1] + dir[1] * t, from[2] + dir[2] * t];
    return y < heightAt(x, z) + CLEARANCE || (solid !== undefined && solid(x, y, z, from));
  };
  for (let t = STEP; t <= max; t += STEP) {
    // Rising above every roof, it's clear the rest of the way.
    if (dir[1] >= 0 && from[1] + dir[1] * t > ROOF_LIMIT) return max;
    if (!blocked(t)) continue;
    let [clear, hit] = [t - STEP, t];
    for (let i = 0; i < 4; i++) {
      const mid = (clear + hit) / 2;
      if (blocked(mid)) hit = mid;
      else clear = mid;
    }
    return Math.max(STEP, clear - STEP / 2);
  }
  return max;
}

/**
 * What length to ease the boom to, from the length free along it and along two whiskers
 * either side: a wall that reaches a whisker starts the pull in before it cuts the view, so
 * passing a corner is a short dolly, not a jump.
 */
export const reachGoal = (free: number, left: number, right: number) =>
  Math.min(free, (free + Math.min(left, right)) / 2);

/** Whiskers either side of the boom (radians) feel for corners before they cut the view. */
const WHISKER = 0.15;
const ray: Vec3 = [0, 0, 0];

/**
 * The length to ease a boom at `yaw` and `pitch` to, up to `max`: the free length along it and
 * along its whiskers (`reachGoal`).
 */
export function boomReach(
  heightAt: (x: number, z: number) => number,
  from: Vec3,
  yaw: number,
  pitch: number,
  max: number,
  solid?: Solid,
): number {
  const along = (turn: number) =>
    freeLength(heightAt, from, boomDirection(yaw + turn, pitch, ray), max, solid);
  return reachGoal(along(0), along(-WHISKER), along(WHISKER));
}

/**
 * Eases the boom toward a free length: in quickly, out gently. `inside` says the camera,
 * where it is now, would sit in a house, a tree or under ground: then it is in at once.
 */
export function settleReach(reach: number, goal: number, dt: number, inside = false): number {
  if (inside && goal < reach) return goal;
  return decay(reach, goal, goal < reach ? PULL_IN : LET_OUT, dt);
}

/** Below this free length (m) the boom rises to look down over the walker's shoulder. */
export const SHORT_BOOM = 2;
/** Half-lives (s) of the boom rising for a tight spot, and sinking back once out of it. */
const RISE = 0.08;
const SINK = 0.4;
/** Pitches tried on the way up, before the one that frees the boom is narrowed down. */
const RISE_TRIES = 6;

/**
 * The lowest pitch, from `pitch` up to the boom's limit, at which the boom reaches at least
 * SHORT_BOOM (`freeAt` gives its reach at a pitch, up to that): in a narrow street, a
 * camera that would back into a wall rises and looks down over the walker's shoulder instead
 * of closing in on its head, as third-person cameras do. Where no pitch has that much room it
 * takes the roomiest (the lowest of equals: under a low crown, where it was), and the figure
 * fades if the camera still comes close.
 */
export function shoulderPitch(freeAt: (pitch: number) => number, pitch: number): number {
  let [best, room] = [pitch, freeAt(pitch)];
  if (room >= SHORT_BOOM) return pitch;
  const top = PITCH_RANGE[1];
  let low = pitch;
  for (let i = 1; i <= RISE_TRIES; i++) {
    const high = pitch + ((top - pitch) * i) / RISE_TRIES;
    const free = freeAt(high);
    if (free > room + 1e-6) [best, room] = [high, free];
    if (free < SHORT_BOOM) {
      low = high;
      continue;
    }
    let [blocked, open] = [low, high];
    for (let k = 0; k < 4; k++) {
      const mid = (blocked + open) / 2;
      if (freeAt(mid) >= SHORT_BOOM) open = mid;
      else blocked = mid;
    }
    return open;
  }
  return best;
}

/** Eases the boom's floor toward the pitch a tight spot needs: up quickly, down gently. */
export const settleFloor = (floor: number, goal: number, dt: number) =>
  decay(floor, goal, goal > floor ? RISE : SINK, dt);

/** The walker's height and half its width, drawn 1.3× life size (m). */
const FIGURE_TOP = 2.4;
const FIGURE_RADIUS = 0.4;
/** The figure fades out as the camera comes from this far to this near it (m). */
const FADE_FROM = 1;
const FADE_TO = 0.3;

/**
 * How much of the figure to draw (0 to 1) with the camera at (dx, dy, dz) from its feet: all of
 * it until the camera is about a metre away, then less and less, so a camera squeezed against
 * it never shows the inside of a head. It follows the camera's own smooth motion.
 */
export function figureOpacity(dx: number, dy: number, dz: number): number {
  const up = dy < 0 ? dy : Math.max(0, dy - FIGURE_TOP);
  const gap = Math.hypot(dx, up, dz) - FIGURE_RADIUS;
  const t = Math.min(1, Math.max(0, (gap - FADE_TO) / (FADE_FROM - FADE_TO)));
  return t * t * (3 - 2 * t);
}

/**
 * Turns where the boom aims round behind a walker facing `heading`, by a share of the way each
 * second (`rate`): the auto-recentre while walking. Its pitch eases back to the default too.
 */
export function recentre(boom: Boom, heading: number, rate: number, dt: number): void {
  const keep = Math.exp(-rate * dt);
  boom.aimYaw = wrap(heading + Math.PI - wrap(heading + Math.PI - boom.aimYaw) * keep);
  boom.aimPitch = PITCH + (boom.aimPitch - PITCH) * keep;
}

/**
 * How much the boom should recentre behind a walker going `heading` with the boom at `yaw`:
 * fully walking away from the camera, a little sideways, not at all walking toward it (that
 * would swing the camera round in front and turn the controls with it).
 */
export function recentreWeight(heading: number, yaw: number): number {
  const away = Math.cos(wrap(heading + Math.PI - yaw));
  return Math.min(1, Math.max(0, (away + 0.3) / 1.3)) ** 2;
}

/** Where the head turns, from where the camera looks: ahead, or back at the camera when it's in front. */
export function headLook(heading: number, boomYaw: number): number {
  const look = wrap(boomYaw + Math.PI - heading);
  return Math.abs(look) <= Math.PI / 2 ? look : wrap(look - Math.PI);
}

/** How close the camera may come to a trunk or a crown (m). */
const TREE_CLEARANCE = 0.3;
/** Side of the squares trees are filed under for lookups (m). */
const TREE_BUCKET = 16;

/**
 * Trees as the camera boom meets them: a post of the trunk's radius up to the middle of the
 * crown, and the crown as an ellipsoid. Filed once into 16 m squares by the ground they cover,
 * so a lookup reads the few trees of one square; nothing is built per frame.
 */
export class TreeObstacles {
  /** x, z, trunk radius, crown middle height, crown radius across and up; each with clearance. */
  readonly #shape: Float32Array;
  readonly #start: Int32Array;
  readonly #items: Int32Array;
  readonly #x0: number;
  readonly #z0: number;
  readonly #cols: number;
  readonly #rows: number;

  /** `shapes` holds six numbers a tree: x, z, trunk radius, crown middle height, crown radii across and up. */
  constructor(shapes: ArrayLike<number>) {
    const n = Math.floor(shapes.length / 6);
    this.#shape = new Float32Array(n * 6);
    let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      const at = (k: number) => shapes[i * 6 + k] ?? 0;
      const [x, z, trunk, wide] = [at(0), at(1), at(2), at(4)];
      this.#shape.set(
        [x, z, trunk + TREE_CLEARANCE, at(3), wide + TREE_CLEARANCE, at(5) + TREE_CLEARANCE],
        i * 6,
      );
      const r = Math.max(trunk, wide) + TREE_CLEARANCE;
      [x0, z0, x1, z1] = [
        Math.min(x0, x - r),
        Math.min(z0, z - r),
        Math.max(x1, x + r),
        Math.max(z1, z + r),
      ];
    }
    if (n === 0) [x0, z0, x1, z1] = [0, 0, 0, 0];
    this.#x0 = x0;
    this.#z0 = z0;
    this.#cols = Math.floor((x1 - x0) / TREE_BUCKET) + 1;
    this.#rows = Math.floor((z1 - z0) / TREE_BUCKET) + 1;
    // Counted, then filled: one flat list of trees per square, every square they reach into.
    this.#start = new Int32Array(this.#cols * this.#rows + 1);
    const each = (i: number, visit: (bucket: number) => void) => {
      const [x, z] = [this.#shape[i * 6]!, this.#shape[i * 6 + 1]!];
      const r = Math.max(this.#shape[i * 6 + 2]!, this.#shape[i * 6 + 4]!);
      const [c0, c1] = [this.#col(x - r), this.#col(x + r)];
      const [r0, r1] = [this.#row(z - r), this.#row(z + r)];
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) visit(row * this.#cols + col);
      }
    };
    for (let i = 0; i < n; i++) each(i, (b) => this.#start[b + 1]!++);
    for (let b = 0; b < this.#cols * this.#rows; b++) this.#start[b + 1]! += this.#start[b]!;
    this.#items = new Int32Array(this.#start[this.#cols * this.#rows]!);
    const fill = this.#start.slice(0, -1);
    for (let i = 0; i < n; i++) each(i, (b) => (this.#items[fill[b]!++] = i));
  }

  #col(x: number): number {
    return Math.min(this.#cols - 1, Math.max(0, Math.floor((x - this.#x0) / TREE_BUCKET)));
  }

  #row(z: number): number {
    return Math.min(this.#rows - 1, Math.max(0, Math.floor((z - this.#z0) / TREE_BUCKET)));
  }

  #inside(i: number, x: number, y: number, z: number): boolean {
    const s = this.#shape;
    const [dx, dz] = [x - s[i * 6]!, z - s[i * 6 + 1]!];
    const flat = dx * dx + dz * dz;
    const [trunk, middle, wide, tall] = [
      s[i * 6 + 2]!,
      s[i * 6 + 3]!,
      s[i * 6 + 4]!,
      s[i * 6 + 5]!,
    ];
    if (y < middle && flat < trunk * trunk) return true;
    const dy = y - middle;
    return flat / (wide * wide) + (dy * dy) / (tall * tall) < 1;
  }

  /** Whether (x, y, z) is in a tree, leaving out any tree that holds `from` (the boom's start). */
  readonly solid: Solid = (x, y, z, from) => {
    const bucket = this.#row(z) * this.#cols + this.#col(x);
    for (let k = this.#start[bucket]!; k < this.#start[bucket + 1]!; k++) {
      const i = this.#items[k]!;
      if (this.#inside(i, x, y, z) && !this.#inside(i, from[0], from[1], from[2])) return true;
    }
    return false;
  };
}

/** One end of the flight between the map and the walk. */
export interface Shot {
  look: Vec3;
  yaw: number;
  pitch: number;
  fov: number;
  /** Height of the view (m) at the look point. */
  span: number;
}

/** A camera placed for a moment of the flight: where it looks from and with which lens. */
export interface Lens {
  look: Vec3;
  yaw: number;
  pitch: number;
  fov: number;
  distance: number;
}

const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Height of the view at `distance` from the camera, with a vertical field of view in degrees. */
export const spanAt = (distance: number, fov: number) =>
  2 * distance * Math.tan((fov * Math.PI) / 360);

/**
 * The camera `t` of the way (0 to 1) from shot `a` to shot `b`. The lens widens while the
 * camera closes in so the view's height at the look point shrinks steadily (in log scale):
 * at the narrow end it looks just like the isometric map.
 */
export function flight(a: Shot, b: Shot, t: number, out: Lens): Lens {
  const s = smoother(Math.min(1, Math.max(0, t)));
  for (let i = 0; i < 3; i++) out.look[i] = a.look[i]! + (b.look[i]! - a.look[i]!) * s;
  out.yaw = wrap(a.yaw + wrap(b.yaw - a.yaw) * s);
  // The tilt lags the rest, so the camera keeps sinking as it closes in: one arc down behind.
  out.pitch = a.pitch + (b.pitch - a.pitch) * s * s;
  out.fov = a.fov + (b.fov - a.fov) * s;
  const span = Math.exp(Math.log(a.span) + (Math.log(b.span) - Math.log(a.span)) * s);
  out.distance = span / spanAt(1, out.fov);
  return out;
}

/**
 * The lowest pitch, from `low` up to the boom's limit, at which a camera `distance` along the
 * boom from `look` sees `look` over every roof: the flight climbs over the houses round a
 * square instead of cutting in through them. Bisected, as a higher boom only clears more.
 */
export function clearPitch(
  heightAt: (x: number, z: number) => number,
  look: Vec3,
  yaw: number,
  distance: number,
  low: number,
): number {
  const dir: Vec3 = [0, 0, 0];
  const clear = (pitch: number) =>
    freeLength(heightAt, look, boomDirection(yaw, pitch, dir), distance) >= distance;
  let [lo, hi]: [number, number] = [low, PITCH_RANGE[1]];
  if (lo >= hi || clear(lo)) return lo;
  if (!clear(hi)) return hi;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    if (clear(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** The parts of a wheel event that tell a trackpad from a mouse. */
export interface Wheel {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  /** Non-standard, but Chrome, Safari and Firefox all send it: ±120 a notch on a mouse. */
  wheelDeltaY?: number;
}

/**
 * What a wheel event is: a pinch (the browser sends trackpad pinches as ctrl + wheel), a
 * two-finger swipe on a trackpad, or a mouse wheel. Swipes look around, the others zoom.
 */
export function wheelKind(event: Wheel): 'pinch' | 'swipe' | 'wheel' {
  if (event.ctrlKey) return 'pinch';
  if (event.deltaMode !== 0) return 'wheel';
  if (event.deltaX !== 0) return 'swipe';
  const notch = event.wheelDeltaY;
  // Chrome and Safari give a trackpad's movement as -3 × its delta; a mouse's as 120 a notch.
  if (notch && Math.abs(notch + 3 * event.deltaY) < 1) return 'swipe';
  if (notch && Number.isInteger(notch / 120)) return 'wheel';
  return 'swipe';
}

/** The isometric map's yaw nearest a walk's camera: the map only turns in quarters. */
export const mapYaw = (yaw: number) =>
  Math.round((yaw - Math.PI / 4) / (Math.PI / 2)) * (Math.PI / 2) + Math.PI / 4;
