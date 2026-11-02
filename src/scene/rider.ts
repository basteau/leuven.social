import { overlap, settle } from './collide.ts';
import type { Ground } from './collide.ts';
import { decay, decayAngle, springTo } from './motion.ts';
import type { Spring } from './motion.ts';

/**
 * How a bike rides: a kinematic bicycle (the front wheel steers, the rear follows, no tyre slip)
 * that leans a little into its turns and never tips over, pedalled up to a
 * cruise or a sprint, braked, coasted, and at a crawl walked round on the spot or backed up.
 * Pure state and maths, stepped at the walker's fixed rate (`STEP`) and allocating nothing, so
 * the same keys ride the same line on any screen. It meets the city through the walker's collide
 * and slide (collide.ts): a body circle and a probe at the front wheel. A glancing hit keeps the
 * cosine share of its speed and turns it along the wall; head on, it stops with a little bounce.
 *
 * Units are metres, seconds and radians, the walker's: heading 0 faces +z, π/2 faces +x, and a
 * positive turn, steer or lean is toward +x from +z, which is to the rider's left.
 */

/** The bike is drawn 1.3× life size, like the figure: a 1.43 m wheelbase on 0.44 m wheels. */
const SCALE = 1.3;
export const WHEELBASE = 1.1 * SCALE;
export const WHEEL = 0.34 * SCALE;
/**
 * Pedalling and sprinting speeds (m/s): 41 and 63 km/h, a cartoon past a city bike's 18, and 35%
 * up from 8.5 and 13, as walking is, so the city's long streets go by.
 */
export const CRUISE = 11.5;
export const SPRINT = 17.5;
/**
 * Pedalling force as acceleration from a standstill (m/s²), fading toward the speed it aims at:
 * 95% of a cruise in 3.1 s, as it was at 8.5 m/s.
 */
const PUSH = 6.8;
/** Coasting: rolling drag plus a little air (m/s²), about 0.3 at a cruise. */
const ROLL = 0.22;
const AIR = 0.0015;
/**
 * Braking (m/s²): firmer than a real bike's 2.4–3, a cartoon that stops when asked: from a
 * cruise in 1.8 s and 10 m.
 */
export const BRAKE = 6.5;
/** Let go below this pace (m/s), it slows at 1.5 m/s² to a stop. */
const DAWDLE = 3.4;
/** Off a sprint it eases back to a cruise (m/s²) rather than braking. */
const EASE_BACK = 2;
/**
 * Turning as hard as it can (the keys held, or a heading well round) faster than this (m/s), the
 * rider eases off at SCRUB (m/s²): the tightest turn grows with v², 11 m round at a cruise, so
 * a street corner taken at speed slows a little to where it fits (5.3 m round at 8 m/s).
 */
export const CORNER = 8;
const SCRUB = 3;
/** The tightest turn at a crawl (m), and the most sideways grip (m/s²), a cartoon's. */
const MIN_RADIUS = 1.5;
const GRIP = 12;
/**
 * The bike is drawn leaning a share of what the turn would ask of a real one (atan v ω / g),
 * never past SHOWN_LEAN: a gentle tilt that says "turning" without the street tipping about.
 */
const LEAN_GAIN = 0.45;
export const MAX_LEAN = (16 * Math.PI) / 180;
/** Half-lives (s): the bars turning, and the lean catching up with the turn. */
const STEER_EASE = 0.035;
const LEAN_EASE = 0.09;
/** Below this speed (m/s) the rider walks the bike round on the spot, up to PIVOT (rad/s). */
export const CRAWL = 1.2;
const PIVOT = 2.2;
/** Backing up (m/s), and how quickly it gets there (m/s²). */
export const BACK = 1.5;
const BACK_ACCEL = 2;
/** A target more than this far behind (radians, 135°) brakes rather than turning at speed. */
export const BEHIND = (3 * Math.PI) / 4;
/** Steering toward a heading closes the gap in about this long (s). */
const AIM = 0.25;
/**
 * Crank turns per wheel turn: 3.2 wheel turns a crank turn (a 51/16), so the crank keeps a city
 * cadence, 78 rpm at a cruise and 118 flat out, rather than spinning 35% faster with the wheel.
 */
export const GEAR = 1 / 3.2;
/** Coasting, the pedals come level with this half-life (s): ready to push again. */
const LEVEL_EASE = 0.15;
/** The body circle (m), and the probe round the front wheel: its radius and how far ahead. */
export const BODY = 0.5;
const NOSE = 0.25;
const NOSE_AHEAD = 0.9;
/** Hitting a wall at more than this angle to it (60°) is head on: it stops with a bounce. */
const HEAD_ON = Math.sin(Math.PI / 3);
const BOUNCE = 0.12;
/** Sliding along a wall, the heading turns along it with this half-life (s). */
const ALONG_EASE = 0.06;
/** Stopped with a foot down, the bike leans onto that side (radians). */
export const FOOT_LEAN = 0.12;
/** Half-lives (s) of standing up on the pedals, and of putting a foot down. */
const STAND_EASE = 0.15;
const FOOT_EASE = 0.12;
const G = 9.81;

export interface Rider {
  /** The bike's middle, between its wheels, on the ground. */
  x: number;
  z: number;
  heading: number;
  /** Along the heading (m/s); negative is backing up. */
  speed: number;
  /** Steer angle of the front wheel and how fast it turns; the lean and its rate. */
  steer: number;
  steerRate: number;
  lean: number;
  leanRate: number;
  /** The heading's rate of turn (rad/s). */
  turning: number;
  /** Wheel and crank angles (radians): the crank turns with the wheel only while pedalling. */
  wheel: number;
  crank: number;
  /** Whether the pedals drive this step. */
  pedalling: boolean;
  /** How far the rider is standing up on the pedals (a sprint), and has a foot down: 0 to 1. */
  stand: number;
  foot: number;
  /** How hard it last hit something (m/s), for the thud; whoever plays it sets it back to 0. */
  bump: number;
  /** Whether it is sliding along a wall. */
  scraping: boolean;
}

export const createRider = (x: number, z: number, heading: number): Rider => ({
  x,
  z,
  heading,
  speed: 0,
  steer: 0,
  steerRate: 0,
  lean: 0,
  leanRate: 0,
  turning: 0,
  wheel: 0,
  crank: Math.PI / 2,
  pedalling: false,
  stand: 0,
  foot: 1,
  bump: 0,
  scraping: false,
});

export interface RideInput {
  /** From -1 (brake, then back up) to 1 (pedal hard). */
  throttle: number;
  /** The bars, for keys: -1 left to 1 right. */
  turn: number;
  /** Or a heading to ride toward (the stick, a route), steered to; NaN for none. */
  toward: number;
  sprint: boolean;
  /** The fastest to go (m/s): a route slows for its corners and its end. */
  limit: number;
}

export const createInput = (): RideInput => ({
  throttle: 0,
  turn: 0,
  toward: Number.NaN,
  sprint: false,
  limit: Infinity,
});

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The tightest steer angle at a speed: a crawl's tight turn, then what grip allows. */
export function maxSteer(speed: number): number {
  return Math.atan(WHEELBASE / Math.max(MIN_RADIUS, (speed * speed) / GRIP));
}

const steering: Spring = { x: 0, v: 0 };
const leaning: Spring = { x: 0, v: 0 };
const normal: [number, number] = [0, 0];
const nose: [number, number] = [0, 0];

/**
 * Advances the bike by `dt` seconds (best a whole `STEP`) on `ground`. Returns whether anything
 * still moves (rolling, turning, leaning or settling), i.e. whether another frame is worth drawing.
 */
export function stepRider(r: Rider, dt: number, input: RideInput, ground: Ground): boolean {
  const v0 = r.speed;
  let throttle = input.throttle;
  // Keys turn the bars: right turns the heading toward -x from +z.
  let want = -input.turn * maxSteer(Math.abs(v0));
  let pivot = -input.turn;
  if (!Number.isNaN(input.toward)) {
    const gap = wrap(input.toward - r.heading);
    // Behind the rider at speed: brake first, then turn round at a crawl.
    if (Math.abs(gap) > BEHIND && v0 > CRAWL) throttle = -1;
    want = Math.atan(((gap / AIM) * WHEELBASE) / Math.max(Math.abs(v0), 1)) * Math.sign(v0 || 1);
    pivot = clamp(gap * 3, -1, 1);
  }
  const most = maxSteer(Math.abs(v0));
  [steering.x, steering.v] = [r.steer, r.steerRate];
  springTo(steering, clamp(want, -most, most), STEER_EASE, dt);
  [r.steer, r.steerRate] = [steering.x, steering.v];

  // Pedal, brake, back up or coast.
  const top = Math.min(input.sprint ? SPRINT : CRUISE, input.limit);
  const drag = ROLL + AIR * v0 * v0;
  let accel = -drag * Math.sign(v0);
  r.pedalling = throttle > 0.05 && v0 >= 0 && v0 < top * throttle + 0.3;
  if (r.pedalling) accel = throttle * PUSH * Math.max(0, 1 - (v0 / top) ** 2);
  if (throttle < -0.05) {
    accel = v0 > 0.05 ? BRAKE * throttle : v0 > -BACK ? -BACK_ACCEL : 0;
  } else if (v0 < 0)
    accel = BRAKE; // let go of S while backing: stop
  // Let go at a walking pace, the rider drags a foot and stops rather than rolling on and on.
  else if (!r.pedalling && v0 < DAWDLE) accel = Math.min(accel, -1.5);
  if (v0 > top + 0.2) accel = Math.min(accel, v0 > input.limit + 0.2 ? -0.7 * BRAKE : -EASE_BACK);
  // Turning as hard as it can at speed, it eases off until the turn fits.
  if (v0 > CORNER && (Math.abs(input.turn) > 0.9 || Math.abs(want) > 2 * most))
    accel = Math.min(accel, -SCRUB);
  let v = Math.max(-BACK, v0 + accel * dt);
  // Coasting or braking doesn't roll it the other way.
  if (throttle >= -0.05 && Math.sign(v) !== Math.sign(v0) && v0 !== 0) v = 0;
  if (throttle > -0.05 && !r.pedalling && Math.abs(v) < 0.05) v = 0;

  // A kinematic bicycle about its rear axle; at a crawl the rider can also walk it round on the
  // spot, about its middle.
  const half = WHEELBASE / 2;
  const kinematic = (v * Math.tan(r.steer)) / WHEELBASE;
  const crawl = Math.max(0, 1 - Math.abs(v) / CRAWL);
  const walked = (input.turn || !Number.isNaN(input.toward) ? pivot : 0) * PIVOT * crawl;
  const [sin0, cos0] = [Math.sin(r.heading), Math.cos(r.heading)];
  const heading = wrap(r.heading + kinematic * dt);
  const rearX = r.x - sin0 * half + sin0 * v * dt;
  const rearZ = r.z - cos0 * half + cos0 * v * dt;
  let [x, z] = [rearX + Math.sin(heading) * half, rearZ + Math.cos(heading) * half];
  r.heading = wrap(heading + walked * dt);
  r.turning = kinematic + walked;

  // Into a wall: slide along it at the cosine share of the pace, or head on, stop and bounce.
  const [mx, mz] = [x - r.x, z - r.z];
  const step = Math.hypot(mx, mz);
  let hit = false;
  let scraping = false;
  if (step > 1e-6) {
    const body = overlap(x, z, ground, BODY, 0.02, normal);
    const dir = Math.sign(v);
    const [nx, nz] = [
      x + Math.sin(r.heading) * NOSE_AHEAD * dir,
      z + Math.cos(r.heading) * NOSE_AHEAD * dir,
    ];
    const front = overlap(nx, nz, ground, NOSE, 0.02, nose);
    if (front > body) [normal[0], normal[1]] = nose;
    const [ux, uz] = [mx / step, mz / step];
    const into = body || front ? ux * normal[0] + uz * normal[1] : 0;
    if (into < -HEAD_ON) {
      r.bump = Math.max(r.bump, Math.abs(v));
      v = -dir * Math.min(0.8, BOUNCE * Math.abs(v));
      [x, z] = [r.x, r.z];
      hit = true;
    } else if (into < -1e-3) {
      const [tx, tz] = [ux - into * normal[0], uz - into * normal[1]];
      const share = Math.hypot(tx, tz);
      // Meeting the wall costs the speed into it, once; scraping along it after that moves at
      // the share the wall leaves, while the heading turns along it.
      if (!r.scraping && Math.abs(v) * -into > 1.5) r.bump = Math.max(r.bump, Math.abs(v) * -into);
      if (!r.scraping) v *= share;
      scraping = true;
      [x, z] = [r.x + tx * step, r.z + tz * step];
      const along = Math.atan2(tx * dir, tz * dir);
      r.heading = decayAngle(r.heading, along, ALONG_EASE, dt);
    }
  }
  const [fromX, fromZ] = [r.x, r.z];
  settle(r, x, z, dt, ground, BODY);
  // Refused by the edge of the water or the tracks: as good as a wall head on. (Pushed back out
  // of something it overlaps, as a bike taken out of a rack is, it still moves.)
  if (!hit && step > 1e-3 && r.x === fromX && r.z === fromZ && Math.abs(v) > 0.5) {
    r.bump = Math.max(r.bump, Math.abs(v));
    v = 0;
  }
  r.speed = v;
  r.scraping = scraping;

  // Lean into the turn by a share of what it asks (atan v ω / g), lagging a little; stopped
  // with a foot down, onto that foot.
  const still = !r.pedalling && Math.abs(v) < 0.3 ? 1 : 0;
  r.foot = decay(r.foot, still, FOOT_EASE, dt);
  r.stand = decay(r.stand, input.sprint && r.pedalling ? 1 : 0, STAND_EASE, dt);
  const lean =
    clamp(LEAN_GAIN * Math.atan((v * kinematic) / G), -MAX_LEAN, MAX_LEAN) + FOOT_LEAN * r.foot;
  [leaning.x, leaning.v] = [r.lean, r.leanRate];
  springTo(leaning, lean, LEAN_EASE, dt);
  [r.lean, r.leanRate] = [leaning.x, leaning.v];

  // The wheels roll; the crank turns with them while pedalling, and freewheels, level, otherwise.
  const roll = (v / WHEEL) * dt;
  r.wheel = (r.wheel + roll) % (Math.PI * 2);
  if (r.pedalling) r.crank = (r.crank + roll * GEAR) % (Math.PI * 2);
  else r.crank = decay(r.crank, level(r.crank), LEVEL_EASE, dt);

  return (
    v !== 0 ||
    Math.abs(r.turning) > 1e-3 ||
    Math.abs(r.steerRate) > 1e-3 ||
    Math.abs(r.leanRate) > 1e-3 ||
    Math.abs(r.lean - lean) > 1e-3 ||
    Math.abs(r.foot - still) > 1e-3 ||
    r.stand > 1e-3
  );
}

/** The nearest crank angle with the pedals level, front and back. */
export const level = (crank: number) =>
  Math.round((crank - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2;

/** A route being ridden: its points, the index of the next, and the metres ridden along it. */
export interface Path {
  route: Float32Array | null;
  next: number;
  travelled: number;
}

/** Slowing for a corner or the end of a route (m/s²), and the slowest round a hairpin (m/s). */
const ROUTE_DECEL = 4;
const HAIRPIN = 3.4;
/** Within this of the end (m), the route is ridden. */
const ARRIVE = 0.6;

/**
 * Rides along a route (a click on a street): steers for a point a little way along it, further
 * the faster it goes, and slows for the next corner by how sharp it is, and for the end, where
 * it lets go of the route. Writes the steering into `input` and advances `path`.
 */
export function routeInput(r: Rider, path: Path, input: RideInput): void {
  const route = path.route;
  if (!route) return;
  const last = route.length / 2 - 1;
  const point = (i: number, k: 0 | 1) => route[i * 2 + k]!;
  const leg = (i: number) =>
    Math.hypot(point(i, 0) - point(i - 1, 0), point(i, 1) - point(i - 1, 1));
  path.next = Math.max(1, path.next);
  // Past the corner, or close to it at speed: on to the next leg.
  let along = 0;
  for (;;) {
    const i = path.next;
    const [ax, az] = [point(i - 1, 0), point(i - 1, 1)];
    const [dx, dz] = [point(i, 0) - ax, point(i, 1) - az];
    const length = Math.hypot(dx, dz) || 1;
    along = clamp(((r.x - ax) * dx + (r.z - az) * dz) / length, 0, length);
    const close = Math.hypot(point(i, 0) - r.x, point(i, 1) - r.z) < 1;
    if (i < last && (along >= length - 1e-6 || close)) {
      path.travelled += length - along;
      path.next++;
      along = 0;
    } else break;
  }
  let done = 0;
  for (let i = 1; i < path.next; i++) done += leg(i);
  path.travelled = done + along;
  // How far there is to go, to the next corner and to the end.
  const corner = leg(path.next) - along;
  let left = corner;
  for (let i = path.next + 1; i <= last; i++) left += leg(i);
  if (left < ARRIVE) {
    path.route = null;
    input.toward = Number.NaN;
    input.throttle = r.speed > 0.3 ? -0.6 : 0;
    input.limit = Infinity;
    return;
  }
  // The point to steer for, `ahead` metres on along the route.
  let ahead = 1.5 + 0.5 * Math.abs(r.speed);
  let i = path.next;
  let [px, pz] = [point(i - 1, 0), point(i - 1, 1)];
  let from = along;
  for (;;) {
    const rest = leg(i) - from;
    const t = Math.min(1, (from + ahead) / (leg(i) || 1));
    [px, pz] = [
      point(i - 1, 0) + (point(i, 0) - point(i - 1, 0)) * t,
      point(i - 1, 1) + (point(i, 1) - point(i - 1, 1)) * t,
    ];
    if (ahead <= rest || i === last) break;
    ahead -= rest;
    from = 0;
    i++;
  }
  input.toward = Math.atan2(px - r.x, pz - r.z);
  input.throttle = 1;
  input.sprint = false;
  // A hairpin slows it to a walk, a gentle bend hardly at all.
  let turn = Math.PI;
  if (path.next < last) {
    const [ax, az] = [
      point(path.next, 0) - point(path.next - 1, 0),
      point(path.next, 1) - point(path.next - 1, 1),
    ];
    const [bx, bz] = [
      point(path.next + 1, 0) - point(path.next, 0),
      point(path.next + 1, 1) - point(path.next, 1),
    ];
    turn = Math.abs(wrap(Math.atan2(bx, bz) - Math.atan2(ax, az)));
  }
  const round = Math.max(HAIRPIN, CRUISE * Math.cos(turn / 2) ** 2);
  input.limit = Math.min(
    Math.sqrt(round * round + 2 * ROUTE_DECEL * corner),
    Math.sqrt(2 * ROUTE_DECEL * left),
  );
}
