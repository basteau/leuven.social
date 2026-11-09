import type { City } from '../data/city.ts';
import { createPeople } from '../net/people.ts';
import type { Roster, People } from '../net/people.ts';
import type { Outfit, PlayerState } from '../net/protocol.ts';
import type { Viewer } from '../scene/viewer.ts';
import { live } from './live.ts';

/**
 * Made-up people walking the streets, for looking at every level of detail with no server and no
 * bots: `?crowd=2000&spread=600`. They go through the same `People` the network fills, so what
 * shows is the real drawing of them, fed in the same two ways: in full near where the map looks,
 * and coarsely once a second further off. Development only: the import in App.tsx is behind
 * `import.meta.env.DEV`, so none of this reaches a production bundle.
 */

/** Heard of in full within this many metres of where the map looks. */
const FINE_RANGE = 525;
/** Time between ticks (ms): how often the near ones report, as the network does. */
const TICK_MS = 100;
const SKIN = [0xf0c49c, 0xe8b488, 0xc68642, 0x8d5524];
const HAIR = [0x7a4a2c, 0x2c2b30, 0xc8a165, 0xb54b2b];
const SHIRT = [0xfa8064, 0x3b82c4, 0x4aa365, 0xeab308, 0x8b5cf6, 0xe0567a, 0x2db8b0, 0xf2f0ea];
const SHORTS = [0xe9dcbf, 0x3f5578, 0x5f5a50, 0x8a6a42];

interface Walker {
  id: number;
  name: string;
  outfit: Outfit;
  line: Float32Array;
  /** Along `line` (metres). */
  along: number;
  dir: 1 | -1;
  speed: number;
  bike: boolean;
  fine: boolean;
  x: number;
  z: number;
  heading: number;
}

function pointOn(line: Float32Array, along: number, out: [number, number, number]): void {
  let left = along;
  for (let i = 0; i + 3 < line.length; i += 2) {
    const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
    const d = Math.hypot(bx - ax, bz - az);
    if (left <= d || i + 5 >= line.length) {
      const t = d ? Math.min(1, left / d) : 0;
      out[0] = ax + (bx - ax) * t;
      out[1] = az + (bz - az) * t;
      out[2] = Math.atan2(bx - ax, bz - az);
      return;
    }
    left -= d;
  }
  out[0] = line[0]!;
  out[1] = line[1]!;
  out[2] = 0;
}

const pick = <T>(list: readonly T[], at: number): T => list[at % list.length]!;

const lengthOf = (line: Float32Array) => {
  let sum = 0;
  for (let i = 0; i + 3 < line.length; i += 2) {
    sum += Math.hypot(line[i + 2]! - line[i]!, line[i + 3]! - line[i + 1]!);
  }
  return sum;
};

export function startFakeCrowd(viewer: Viewer, city: City, search: string): void {
  const query = new URLSearchParams(search);
  const count = Math.max(0, Number(query.get('crowd') ?? 0) | 0);
  const spread = Number(query.get('spread') ?? 600);
  // Long enough to walk: the streets near the middle, and something to walk along whatever else.
  const lines = city.streets
    .map((s) => s.line)
    .filter((l) => lengthOf(l) > 20 && Math.hypot(l[0]!, l[1]!) < spread);
  if (!lines.length) return;
  const people: People = createPeople();
  const scratch: [number, number, number] = [0, 0, 0];
  const walkers: Walker[] = Array.from({ length: count }, (_, id) => {
    const r = (id * 2654435761) >>> 0;
    const line = lines[r % lines.length]!;
    const bike = r % 13 === 0;
    return {
      id,
      name: `Fake ${id}`,
      outfit: {
        shirt: pick(SHIRT, r >>> 3),
        shorts: pick(SHORTS, r >>> 7),
        hair: pick(HAIR, r >>> 11),
        skin: pick(SKIN, r >>> 15),
      },
      line,
      along: (((r >> 4) % 1000) / 1000) * lengthOf(line),
      dir: r & 1 ? 1 : -1,
      // Some stand a while, most walk, a few are in a hurry: every kind of feet for the crowd's.
      speed: bike ? 9 + (r % 40) / 10 : r % 7 === 0 ? 0 : 1.5 + (r % 30) / 10,
      bike,
      fine: false,
      x: 0,
      z: 0,
      heading: 0,
    };
  });

  let lookX = 0;
  let lookZ = 0;
  let reach = 350;
  const listeners = new Set<() => void>();
  let queued = false;
  const tell = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      for (const news of listeners) news();
    });
  };

  const state = (w: Walker): PlayerState => ({
    x: w.x,
    z: w.z,
    heading: w.heading,
    speed: w.speed,
    mode: w.bike ? 'bike' : 'foot',
    place: '',
    floor: 0,
  });

  let ticks = 0;
  function tick(): void {
    const now = performance.now();
    const coarseFrame = ticks++ % 10 === 0;
    for (const w of walkers) {
      w.along += w.dir * w.speed * (TICK_MS / 1000);
      const length = lengthOf(w.line);
      if (w.along < 0 || w.along > length) w.dir = w.dir === 1 ? -1 : 1;
      w.along = Math.max(0, Math.min(length, w.along));
      pointOn(w.line, w.along, scratch);
      [w.x, w.z] = [scratch[0], scratch[1]];
      w.heading = w.dir === 1 ? scratch[2] : scratch[2] + Math.PI;
      const near = reach > 0 && Math.hypot(w.x - lookX, w.z - lookZ) < FINE_RANGE;
      if (near && !w.fine) {
        people.join(now, w.id, w.name, w.outfit, state(w));
        w.fine = true;
      } else if (w.fine && !near) {
        w.fine = false;
        people.demote(w.id);
      } else if (w.fine) {
        people.move(now, w.id, state(w));
      }
    }
    if (coarseFrame) {
      people.beginCoarse();
      for (const w of walkers) {
        if (!w.fine && reach > 0) people.coarse(now, w.id, w.x, w.z, w.outfit.shirt, 1);
      }
      people.endCoarse(now);
    }
    tell();
  }
  setInterval(tick, TICK_MS);

  const roster: Roster = {
    people,
    look(x, z, r) {
      [lookX, lookZ, reach] = [x, z, r];
    },
    listen(news) {
      listeners.add(news);
      return () => listeners.delete(news);
    },
  };
  viewer.others(roster);
  live.people = people;
  // For looking at it, and for scripts/perf.ts: how many, where they are.
  Object.assign(globalThis, { leuvenFakeCrowd: { people, walkers: count } });
}
