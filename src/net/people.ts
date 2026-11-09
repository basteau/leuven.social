/**
 * Everyone this browser knows of, in flat arrays, so a frame of thousands allocates nothing and
 * every drawing of them (the street, the markers, the minimap, the full map) reads the one list.
 *
 * Someone is known in one of two ways, and goes from one to the other as the same person, at the
 * same spot, in the same slot:
 *
 * - **in full** (`FINE`): heard of by name, in their clothes, up to ten times a second;
 * - **coarsely**: a spot and a shirt, about once a second, from further off. Their heading and
 *   speed are worked out from how they moved.
 *
 * They are drawn a moment behind the network, between two updates and never past the last, so
 * nobody overshoots a corner and comes back. How far behind depends on how often that person is
 * heard of, and changes smoothly as that does: each has a playhead of their own, which only ever
 * goes forward. Coming and going is a `fade` from 0 to 1 and back, so nobody pops.
 *
 * Slots are packed: `0` to `count - 1` are all in use, and leaving moves the last one into the
 * gap, so hold on to an id, not a slot, from one frame to the next. Growing replaces the arrays:
 * read them from `people` each frame.
 */

import type { Outfit, PlayerState } from './protocol.ts';

/** Heard of in full: `who` has their name and clothes, and heading and speed are as they said. */
export const FINE = 1;
/** On a bike (known only for those heard of in full). */
export const BIKE = 2;
/** In a room: `place` and `floor` say which. */
export const INDOORS = 4;

/** Someone heard of in full: who they are and how they look. */
export interface Who {
  id: number;
  name: string;
  outfit: Outfit;
}

/** What `move` takes: those of a `PlayerState` a move can change. */
export type Stride = Pick<PlayerState, 'x' | 'z' | 'heading' | 'speed' | 'mode'>;

export interface People {
  /** How many slots are in use. */
  readonly count: number;
  readonly ids: Int32Array;
  /** Where each is drawn at the last `sample` (m), which way they face (0 is +z) and how fast (m/s). */
  readonly x: Float32Array;
  readonly z: Float32Array;
  readonly heading: Float32Array;
  readonly speed: Float32Array;
  /** How far each has gone (m), for the swing of their legs; wraps at 4096. */
  readonly travelled: Float32Array;
  /** Their shirt, 24-bit sRGB. */
  readonly colour: Int32Array;
  /** `FINE`, `BIKE` and `INDOORS`, or'd. */
  readonly flags: Uint8Array;
  /** How much of them is there, 0 (just come, or about to go) to 1. */
  readonly fade: Float32Array;
  /** How many people this one stands for: more than 1 where a crowd is thinned out far off. */
  readonly weight: Uint16Array;
  /** Who a slot is, if heard of in full. */
  who(slot: number): Who | null;
  /** The room a slot is in ('' the street). */
  place(slot: number): string;
  floor(slot: number): number;
  /** The slot of `id`, or -1. */
  slotOf(id: number): number;
  /** Changes whenever someone comes, goes, or changes name or clothes. */
  readonly version: number;

  /** Heard of in full, now: someone new, or someone known coarsely who carries on from there. */
  join(now: number, id: number, name: string, outfit: Outfit, state: PlayerState): void;
  /** Where someone heard of in full is now. Someone unknown is ignored. */
  move(now: number, id: number, stride: Stride): void;
  /** Went through a door or changed floor: at the new spot at once. */
  jump(now: number, id: number, state: PlayerState): void;
  /** Gone, or no longer of interest: fades out. */
  leave(now: number, id: number): void;
  /** No longer heard of in full, but still coarsely: stays until a coarse frame says otherwise. */
  demote(id: number): void;
  /** A new name or new clothes. */
  restyle(id: number, change: Partial<Pick<Who, 'name' | 'outfit'>>): void;

  /** A coarse frame starts: everyone known coarsely is listed in it, or has gone. */
  beginCoarse(): void;
  /** Someone in the frame: at (x, z), in a shirt, standing for `weight` people. */
  coarse(now: number, id: number, x: number, z: number, colour: number, weight: number): void;
  /** The frame is over: whoever known coarsely wasn't in it fades out. */
  endCoarse(now: number): void;

  /** The full list is being sent again: from here, whoever isn't said to be there has gone. */
  beginRecount(): void;
  /** The list is complete. Those heard of in full and not mentioned since `beginRecount` go. */
  endRecount(now: number): void;

  /** Everyone gone at once: a new connection's ids aren't the old one's. */
  forget(): void;
  /** Moves everyone on to `now` (ms). Returns whether anyone is still moving or fading. */
  sample(now: number): boolean;
}

/** The other players as the map gets them: the list, and what the map says back. */
export interface Roster {
  people: People;
  /**
   * Says where the view looks and how far from there it shows anything (m), as it changes: what
   * the server sends depends on it. 0 asks for nobody: a tab nobody can see.
   */
  look(x: number, z: number, reach: number): void;
  /** Calls `news` at most once a frame when anything changed; returns an unsubscribe. */
  listen(news: () => void): () => void;
}

/** The updates kept for each person. */
const RING = 8;
/** The sum of `RING` numbers per slot: x, z, heading, speed. */
const FIELDS = 4;
/** How long coming or going takes (ms). */
const FADE_MS = 220;
/** How far behind the latest update they are drawn at most, and at least (ms). */
const LEAST_BEHIND = 120;
const MOST_BEHIND = 1500;
/** Time between updates assumed for someone new: full, coarse (ms). */
const FINE_GAP = 100;
const COARSE_GAP = 1000;
/** A playhead too far behind is brought along at most this much faster or slower than the clock. */
const SLOWEST = 0.6;
const FASTEST = 1.8;
/** The playhead closes the gap to where it should be over about this long (ms). */
const SLEW_MS = 400;
/** A playhead is never further back than this, whatever else: hidden tabs catch up at once. */
const FURTHEST_BACK = 3000;
/** Under this, someone stands (m/s). */
const STANDING = 0.05;
/** No one covers ground faster than this, plus the margin: further is a teleport (m/s, m). */
const FASTEST_MOVER = 30;
const JUMP_MARGIN = 15;
/** How long someone keeps going in the legs after the last update (ms). */
const LEGS_LINGER = 400;
/** Where `travelled` wraps (m). */
const TRAVELLED_WRAP = 4096;
/** How a longer gap, and a shorter one, count toward the usual gap between updates. */
const WIDEN = 0.5;
const NARROW = 0.1;
/** A gap longer than this isn't a rate: the person stood, or the tab slept (ms). */
const LONGEST_GAP = 2500;

const TURN = Math.PI * 2;
const shortWay = (from: number, to: number) => {
  const d = (to - from) % TURN;
  return d > Math.PI ? d - TURN : d < -Math.PI ? d + TURN : d;
};
const clamp = (value: number, least: number, most: number) =>
  value < least ? least : value > most ? most : value;

type Flat = Int32Array | Float32Array | Float64Array | Uint8Array | Uint16Array | Uint32Array;

/** A longer array of the same kind, starting with what `from` holds. */
function wider<T extends Flat>(from: T, length: number): T {
  const to = new (from.constructor as new (n: number) => T)(length);
  to.set(from);
  return to;
}

export function createPeople(): People {
  let capacity = 64;
  let count = 0;
  let version = 0;
  /** When `sample` last ran (ms). */
  let lastNow = Number.NaN;
  let coarseFrame = 0;
  let recounting = false;
  let recount = 0;
  const slots = new Map<number, number>();

  let ids = new Int32Array(capacity);
  let x = new Float32Array(capacity);
  let z = new Float32Array(capacity);
  let heading = new Float32Array(capacity);
  let speed = new Float32Array(capacity);
  let travelled = new Float32Array(capacity);
  let colour = new Int32Array(capacity);
  let flags = new Uint8Array(capacity);
  let fade = new Float32Array(capacity);
  let weight = new Uint16Array(capacity);
  // The ring of updates: `RING` times of arrival, and `RING` × `FIELDS` numbers.
  let times = new Float64Array(capacity * RING);
  let ring = new Float32Array(capacity * RING * FIELDS);
  let head = new Uint8Array(capacity);
  let length = new Uint8Array(capacity);
  let playhead = new Float64Array(capacity);
  let gap = new Float32Array(capacity);
  /** Fading out, and whether a coarse frame or a recount has them. */
  let leaving = new Uint8Array(capacity);
  let seen = new Uint32Array(capacity);
  let counted = new Uint32Array(capacity);
  let floors = new Uint8Array(capacity);
  const whos: (Who | null)[] = [];
  const places: string[] = [];

  function grow(): void {
    capacity *= 2;
    ids = wider(ids, capacity);
    x = wider(x, capacity);
    z = wider(z, capacity);
    heading = wider(heading, capacity);
    speed = wider(speed, capacity);
    travelled = wider(travelled, capacity);
    colour = wider(colour, capacity);
    flags = wider(flags, capacity);
    fade = wider(fade, capacity);
    weight = wider(weight, capacity);
    times = wider(times, capacity * RING);
    ring = wider(ring, capacity * RING * FIELDS);
    head = wider(head, capacity);
    length = wider(length, capacity);
    playhead = wider(playhead, capacity);
    gap = wider(gap, capacity);
    leaving = wider(leaving, capacity);
    seen = wider(seen, capacity);
    counted = wider(counted, capacity);
    floors = wider(floors, capacity);
  }

  function add(id: number, shirt: number, usual: number): number {
    if (count === capacity) grow();
    const s = count++;
    slots.set(id, s);
    ids[s] = id;
    colour[s] = shirt;
    flags[s] = 0;
    fade[s] = 0;
    weight[s] = 1;
    head[s] = 0;
    length[s] = 0;
    travelled[s] = 0;
    gap[s] = usual;
    leaving[s] = 0;
    seen[s] = coarseFrame;
    counted[s] = recount;
    floors[s] = 0;
    whos[s] = null;
    places[s] = '';
    version++;
    return s;
  }

  /** Moves the last slot into `s`, which is done with. */
  function remove(s: number): void {
    slots.delete(ids[s]!);
    const last = --count;
    version++;
    if (s === last) {
      whos[last] = null;
      return;
    }
    ids[s] = ids[last]!;
    x[s] = x[last]!;
    z[s] = z[last]!;
    heading[s] = heading[last]!;
    speed[s] = speed[last]!;
    travelled[s] = travelled[last]!;
    colour[s] = colour[last]!;
    flags[s] = flags[last]!;
    fade[s] = fade[last]!;
    weight[s] = weight[last]!;
    times.copyWithin(s * RING, last * RING, (last + 1) * RING);
    ring.copyWithin(s * RING * FIELDS, last * RING * FIELDS, (last + 1) * RING * FIELDS);
    head[s] = head[last]!;
    length[s] = length[last]!;
    playhead[s] = playhead[last]!;
    gap[s] = gap[last]!;
    leaving[s] = leaving[last]!;
    seen[s] = seen[last]!;
    counted[s] = counted[last]!;
    floors[s] = floors[last]!;
    whos[s] = whos[last]!;
    places[s] = places[last]!;
    whos[last] = null;
    slots.set(ids[s]!, s);
  }

  /** Starts someone's updates over from this one, standing there. */
  function restart(s: number, now: number, px: number, pz: number, h: number, v: number): void {
    head[s] = 0;
    length[s] = 1;
    playhead[s] = now;
    times[s * RING] = now;
    const at = s * RING * FIELDS;
    ring[at] = px;
    ring[at + 1] = pz;
    ring[at + 2] = h;
    ring[at + 3] = v;
    x[s] = px;
    z[s] = pz;
    heading[s] = h;
    speed[s] = v;
  }

  /** Adds an update. A leap too far to have been covered in the time starts them over there. */
  function push(s: number, now: number, px: number, pz: number, h: number, v: number): void {
    if (length[s] === 0) return restart(s, now, px, pz, h, v);
    const newest = s * RING + head[s]!;
    const last = times[newest]!;
    const at = newest * FIELDS;
    const elapsed = now - last;
    const moved = Math.hypot(px - ring[at]!, pz - ring[at + 1]!);
    if (moved > JUMP_MARGIN + (FASTEST_MOVER * Math.min(elapsed, LONGEST_GAP)) / 1000) {
      return restart(s, now, px, pz, h, v);
    }
    const stood = ring[at + 3]! <= STANDING;
    if (stood || elapsed > LONGEST_GAP) {
      // Nothing was happening in that gap, so it says nothing of the rate, and the walk from
      // here shouldn't be stretched over it: they stood until one usual gap ago.
      if (elapsed > gap[s]!) times[newest] = now - gap[s]!;
      if (playhead[s]! < times[newest]!) playhead[s] = times[newest]!;
    } else {
      const usual = gap[s]!;
      gap[s] = usual + (elapsed - usual) * (elapsed > usual ? WIDEN : NARROW);
    }
    head[s] = (head[s]! + 1) % RING;
    if (length[s]! < RING) length[s]!++;
    const next = s * RING + head[s]!;
    times[next] = now;
    const to = next * FIELDS;
    ring[to] = px;
    ring[to + 1] = pz;
    ring[to + 2] = h;
    ring[to + 3] = v;
  }

  function setState(s: number, state: PlayerState): void {
    places[s] = state.place;
    floors[s] = state.floor;
    let f = flags[s]! & FINE;
    if (state.mode === 'bike') f |= BIKE;
    if (state.place !== '') f |= INDOORS;
    flags[s] = f;
  }

  /** Draws `s` between the two updates round its playhead. Returns whether it has more to play. */
  function play(s: number, now: number, dt: number): boolean {
    const newest = head[s]!;
    const latest = times[s * RING + newest]!;
    const behind = clamp(gap[s]! * 1.25 + 30, LEAST_BEHIND, MOST_BEHIND);
    const wanted = now - behind;
    const off = wanted - playhead[s]! - dt;
    let p = playhead[s]! + dt * clamp(1 + off / SLEW_MS, SLOWEST, FASTEST);
    p = Math.min(latest, Math.max(p, now - FURTHEST_BACK));
    playhead[s] = p;
    const n = length[s]!;
    // The two updates round the playhead, walking back from the newest.
    let i = 0;
    let after = s * RING + newest;
    let before = after;
    while (i < n - 1 && times[before]! > p) {
      after = before;
      i++;
      before = s * RING + ((newest + RING - i) % RING);
    }
    const a = before * FIELDS;
    const b = after * FIELDS;
    const span = times[after]! - times[before]!;
    const t = span > 0 ? clamp((p - times[before]!) / span, 0, 1) : 1;
    const nx = ring[a]! + (ring[b]! - ring[a]!) * t;
    const nz = ring[a + 1]! + (ring[b + 1]! - ring[a + 1]!) * t;
    const walked = Math.hypot(nx - x[s]!, nz - z[s]!);
    x[s] = nx;
    z[s] = nz;
    travelled[s] = (travelled[s]! + walked) % TRAVELLED_WRAP;
    heading[s] = ring[a + 2]! + shortWay(ring[a + 2]!, ring[b + 2]!) * t;
    const stale = p >= latest && now - latest > behind + LEGS_LINGER;
    speed[s] = stale ? 0 : ring[a + 3]! + (ring[b + 3]! - ring[a + 3]!) * t;
    return p < latest || speed[s]! > STANDING;
  }

  return {
    get count() {
      return count;
    },
    get ids() {
      return ids;
    },
    get x() {
      return x;
    },
    get z() {
      return z;
    },
    get heading() {
      return heading;
    },
    get speed() {
      return speed;
    },
    get travelled() {
      return travelled;
    },
    get colour() {
      return colour;
    },
    get flags() {
      return flags;
    },
    get fade() {
      return fade;
    },
    get weight() {
      return weight;
    },
    get version() {
      return version;
    },
    who: (slot) => whos[slot] ?? null,
    place: (slot) => places[slot] ?? '',
    floor: (slot) => floors[slot] ?? 0,
    slotOf: (id) => slots.get(id) ?? -1,

    join(now, id, name, outfit, state) {
      let s = slots.get(id);
      if (s === undefined) s = add(id, outfit.shirt, FINE_GAP);
      else if (leaving[s] && !(flags[s]! & FINE)) leaving[s] = 0;
      else if (leaving[s]) {
        // The id's old holder was still fading: this is someone else.
        remove(s);
        s = add(id, outfit.shirt, FINE_GAP);
      }
      whos[s] = { id, name, outfit };
      colour[s] = outfit.shirt;
      weight[s] = 1;
      counted[s] = recount;
      leaving[s] = 0;
      setState(s, state);
      flags[s]! |= FINE;
      version++;
      push(s, now, state.x, state.z, state.heading, state.speed);
    },
    move(now, id, stride) {
      const s = slots.get(id);
      if (s === undefined) return;
      if (stride.mode === 'bike') flags[s]! |= BIKE;
      else flags[s]! &= ~BIKE;
      push(s, now, stride.x, stride.z, stride.heading, stride.speed);
    },
    jump(now, id, state) {
      const s = slots.get(id);
      if (s === undefined) return;
      setState(s, state);
      restart(s, now, state.x, state.z, state.heading, state.speed);
    },
    leave(_now, id) {
      const s = slots.get(id);
      if (s !== undefined) leaving[s] = 1;
    },
    demote(id) {
      const s = slots.get(id);
      if (s !== undefined) flags[s]! &= ~FINE;
    },
    restyle(id, change) {
      const s = slots.get(id);
      const was = s === undefined ? null : whos[s];
      if (s === undefined || !was) return;
      whos[s] = { ...was, ...change };
      colour[s] = whos[s].outfit.shirt;
      version++;
    },

    beginCoarse() {
      coarseFrame = (coarseFrame + 1) >>> 0;
    },
    coarse(now, id, px, pz, shirt, stands) {
      let s = slots.get(id);
      if (s === undefined) s = add(id, shirt, COARSE_GAP);
      seen[s] = coarseFrame;
      if (flags[s]! & FINE) return;
      leaving[s] = 0;
      colour[s] = shirt;
      weight[s] = stands;
      if (length[s] === 0) return restart(s, now, px, pz, heading[s]!, 0);
      const newest = (s * RING + head[s]!) * FIELDS;
      const [dx, dz] = [px - ring[newest]!, pz - ring[newest + 1]!];
      const moved = Math.hypot(dx, dz);
      const elapsed = Math.max(1, now - times[s * RING + head[s]!]!);
      // Worked out from how they moved; a step of the grid (1.4 m) is about standing.
      const pace = moved > 0.5 ? (moved / elapsed) * 1000 : 0;
      const turned = pace > 0 ? Math.atan2(dx, dz) : ring[newest + 2]!;
      push(s, now, px, pz, turned, pace);
    },
    endCoarse() {
      for (let s = 0; s < count; s++) {
        if (!(flags[s]! & FINE) && seen[s] !== coarseFrame) leaving[s] = 1;
      }
    },

    beginRecount() {
      recount = (recount + 1) >>> 0;
      recounting = true;
    },
    endRecount() {
      if (!recounting) return;
      recounting = false;
      for (let s = 0; s < count; s++) {
        if (flags[s]! & FINE && counted[s] !== recount) leaving[s] = 1;
      }
    },

    forget() {
      if (count) version++;
      count = 0;
      recounting = false;
      slots.clear();
      whos.length = 0;
      places.length = 0;
      lastNow = Number.NaN;
    },
    sample(now) {
      const dt = Number.isNaN(lastNow) ? 0 : Math.max(0, now - lastNow);
      lastNow = now;
      let busy = false;
      const step = dt / FADE_MS;
      // Backwards: leaving moves the last slot into the gap, which has been done already.
      for (let s = count - 1; s >= 0; s--) {
        if (leaving[s]) {
          fade[s] = Math.max(0, fade[s]! - step);
          if (fade[s] === 0) {
            remove(s);
            continue;
          }
          busy = true;
        } else if (fade[s]! < 1) {
          fade[s] = Math.min(1, fade[s]! + step);
          busy = true;
        }
        if (length[s]! > 0 && play(s, now, dt)) busy = true;
      }
      return busy;
    },
  };
}
