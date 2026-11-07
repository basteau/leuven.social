import type { Ground } from './collide.ts';
import { IDLE_SECONDS, ON_FOOT, createWalker, stepWalker } from './walker.ts';
import type { Pace, Walker } from './walker.ts';

/**
 * The one avatar, from the first frame: on foot or on a bike, in the street or in a room. There
 * is no map mode and no walk mode; the map is the camera far from the avatar. Its state is a
 * plain object, stepped by pure functions, with no three.js in it: what a later multiplayer
 * layer would send is `avatarState`. Movement is the walker's (walker.ts: springs, collide and
 * slide, routes), at a bike's paces with momentum when riding.
 */

export type Mode = 'foot' | 'bike';

/** The serialisable state: where the avatar is, which way it faces, how fast it goes. */
export interface AvatarState {
  x: number;
  z: number;
  /** Radians, 0 facing +z (south), π/2 facing +x (east), from its movement. */
  facing: number;
  /** m/s, eased. */
  speed: number;
  mode: Mode;
  /** The room it is in (rooms.ts), or null in the street. */
  place: string | null;
  /** 0 the street or a room's ground floor. */
  floor: number;
}

/** The avatar as it is stepped: its walker (springs and route included) and where it is. */
export interface Avatar {
  walker: Walker;
  mode: Mode;
  place: string | null;
  floor: number;
  /** How high its feet are over the ground at its spot (m): a floor or a stair, in a room. */
  rise: number;
}

/**
 * Metres a turn of the crank carries a bike (`BIKE_STRIDE` in rider.ts, which turns the drawn
 * wheels at it too; the avatar's chunk doesn't import the bikes' for one number).
 */
export const BIKE_STRIDE = 5;

/**
 * A bike: the walker's handling at a bike's paces, a cruise and a sprint well above a run, and a
 * body a little wider. Riding is walking faster, with a bell: the same keys and taps, the same
 * starts, stops and turns, only its look, its speed and its pedalling differ.
 */
export const ON_BIKE: Pace = {
  ...ON_FOOT,
  walk: 11.5,
  run: 17.5,
  body: 0.5,
  stride: BIKE_STRIDE,
};

export const paceOf = (mode: Mode): Pace => (mode === 'bike' ? ON_BIKE : ON_FOOT);

/** A new avatar standing at (x, z), facing `facing`, idle already, so nothing animates. */
export function createAvatar(x: number, z: number, facing = 0): Avatar {
  const walker = createWalker(x, z, facing);
  walker.still = IDLE_SECONDS;
  return { walker, mode: 'foot', place: null, floor: 0, rise: 0 };
}

/**
 * One fixed step: steered toward world (steerX, steerZ) (length up to 1), or along its route,
 * running or sprinting with `run`, at its mode's pace, against `ground`. Returns whether it still
 * moves, turns or idles.
 */
export function stepAvatar(
  a: Avatar,
  dt: number,
  steerX: number,
  steerZ: number,
  ground: Ground,
  run = false,
): boolean {
  return stepWalker(a.walker, dt, steerX, steerZ, ground, run, paceOf(a.mode));
}

/** What the avatar is now, as plain data. */
export function avatarState(a: Avatar): AvatarState {
  const w = a.walker;
  return {
    x: w.x,
    z: w.z,
    facing: w.heading,
    speed: w.speed,
    mode: a.mode,
    place: a.place,
    floor: a.floor,
  };
}
