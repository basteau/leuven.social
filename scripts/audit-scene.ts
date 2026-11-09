/**
 * Measures, over the whole baked city, the things that would look wrong if they happened: a sign
 * hung into the house next door, a lamp in the river, a tree in a road. The numbers come from the
 * data and the same placement code the scene draws with, so a result is repeatable and any fix can
 * be shown to work. Prints each check, with where the worst ones are.
 *
 *   bun scripts/audit-scene.ts
 */

import { pointInRing } from '../src/data/geometry.ts';
import { unpackCity } from '../src/data/format.ts';
import { frontPoint } from '../src/data/shops.ts';
import { PLACES } from '../src/data/shop-kinds.ts';

const city = await unpackCity(
  new Uint8Array(await Bun.file(new URL('../public/data/city.bin', import.meta.url)).arrayBuffer()),
);

class Index {
  #cells = new Map<string, number[]>();
  #boxes: [number, number, number, number][] = [];
  constructor(readonly rings: readonly ArrayLike<number>[]) {
    for (const [r, ring] of rings.entries()) {
      let [x0, x1, z0, z1] = [Infinity, -Infinity, Infinity, -Infinity];
      for (let i = 0; i < ring.length; i += 2) {
        [x0, x1] = [Math.min(x0, ring[i]!), Math.max(x1, ring[i]!)];
        [z0, z1] = [Math.min(z0, ring[i + 1]!), Math.max(z1, ring[i + 1]!)];
      }
      this.#boxes.push([x0, x1, z0, z1]);
      for (let i = Math.floor(x0 / 32); i <= Math.floor(x1 / 32); i++) {
        for (let j = Math.floor(z0 / 32); j <= Math.floor(z1 / 32); j++) {
          const key = `${i},${j}`;
          this.#cells.set(key, [...(this.#cells.get(key) ?? []), r]);
        }
      }
    }
  }
  at(x: number, z: number): number {
    for (const r of this.#cells.get(`${Math.floor(x / 32)},${Math.floor(z / 32)}`) ?? []) {
      const b = this.#boxes[r]!;
      if (x >= b[0] && x <= b[1] && z >= b[2] && z <= b[3] && pointInRing(this.rings[r]!, x, z))
        return r;
    }
    return -1;
  }
}
const houses = new Index(city.buildings.map((b) => b.ring));
const water = new Index(city.water);
const roads = new Index(
  city.carriageways.filter((c) => c.kind === 'main' || c.kind === 'street').map((c) => c.ring),
);
const bridges = new Index(city.bridges);

interface Row {
  what: string;
  count: number;
  of: number;
  worst: string[];
}
const rows: Row[] = [];
function check<T>(what: string, items: readonly T[], bad: (item: T) => string | null): void {
  const hits = items.flatMap((item) => bad(item) ?? []);
  rows.push({ what, count: hits.length, of: items.length, worst: hits.slice(0, 6) });
}
const at = (x: number, z: number) => `(${x.toFixed(0)}, ${z.toFixed(0)})`;

const fronts = city.fronts.map((f) => ({
  f,
  b: city.buildings[f.building]!,
  p: frontPoint(city.buildings[f.building]!.ring, f),
}));

check('a shop front against the next house (nothing but wall to see)', fronts, ({ p, f }) => {
  const r = houses.at(p.x + p.nx * 0.6, p.z + p.nz * 0.6);
  return r >= 0 && r !== f.building ? `${f.kind} ${at(p.x, p.z)}` : null;
});
check('a sign that would reach into another house', fronts, ({ p, f }) => {
  for (const out of [0.8, 1.6, 2.4]) {
    const r = houses.at(p.x + p.nx * out, p.z + p.nz * out);
    if (r >= 0 && r !== f.building) return `${f.kind} ${at(p.x, p.z)}`;
  }
  return null;
});
check(
  'a public place with its door facing a house within 3 m',
  fronts.filter(({ f }) => PLACES.has(f.kind)),
  ({ p, f }) => {
    const r = houses.at(p.x + p.nx * 3, p.z + p.nz * 3);
    return r >= 0 && r !== f.building ? `${f.kind} ${at(p.x, p.z)}` : null;
  },
);

check('street furniture in a house', city.props, (p) =>
  houses.at(p.x, p.z) >= 0 ? `${p.kind} ${at(p.x, p.z)}` : null,
);
check('street furniture in the water', city.props, (p) =>
  water.at(p.x, p.z) >= 0 && bridges.at(p.x, p.z) < 0 ? `${p.kind} ${at(p.x, p.z)}` : null,
);
check(
  'a lamp on a carriageway',
  city.props.filter((p) => p.kind === 'lamp'),
  (p) => (roads.at(p.x, p.z) >= 0 ? at(p.x, p.z) : null),
);
check(
  'a bike rack on a carriageway',
  city.props.filter((p) => p.kind === 'bikes'),
  (p) => (roads.at(p.x, p.z) >= 0 ? at(p.x, p.z) : null),
);

const trees = Array.from({ length: city.treeHeights.length }, (_, i) => ({
  x: city.trees[i * 2]!,
  z: city.trees[i * 2 + 1]!,
  h: city.treeHeights[i]!,
}));
check('a trunk in a house', trees, (t) => (houses.at(t.x, t.z) >= 0 ? at(t.x, t.z) : null));
check('a trunk in the water', trees, (t) =>
  water.at(t.x, t.z) >= 0 && bridges.at(t.x, t.z) < 0 ? at(t.x, t.z) : null,
);
check('a trunk on a carriageway', trees, (t) =>
  roads.at(t.x, t.z) >= 0 ? `${t.h.toFixed(0)} m ${at(t.x, t.z)}` : null,
);

const hedgePoints = city.hedges.flatMap((line) =>
  Array.from({ length: line.length / 2 }, (_, i) => [line[i * 2]!, line[i * 2 + 1]!] as const),
);
check('a hedge point on a carriageway', hedgePoints, ([x, z]) =>
  roads.at(x, z) >= 0 ? at(x, z) : null,
);
check('a hedge point in the water', hedgePoints, ([x, z]) =>
  water.at(x, z) >= 0 ? at(x, z) : null,
);

const signAt = fronts.map(({ p, f }) => ({ x: p.x + p.nx, z: p.z + p.nz, f }));
const nearSign = Map.groupBy(signAt, (q) => `${Math.floor(q.x / 4)},${Math.floor(q.z / 4)}`);
check('two signs within 1.5 m of each other', signAt, (q) => {
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      for (const o of nearSign.get(`${Math.floor(q.x / 4) + i},${Math.floor(q.z / 4) + j}`) ?? []) {
        if (
          o.f !== q.f &&
          o.f.building === q.f.building &&
          Math.hypot(o.x - q.x, o.z - q.z) < 1.5
        ) {
          return `${q.f.kind}+${o.f.kind} ${at(q.x, q.z)}`;
        }
      }
    }
  }
  return null;
});
const placesOn = Map.groupBy(
  fronts.filter(({ f }) => PLACES.has(f.kind)),
  ({ f }) => f.building,
);
check(
  'a building with more than one public place flying its flag',
  [...placesOn.values()],
  (list) =>
    list.length > 1 ? `${list.length} ${list[0]!.f.kind} ${at(list[0]!.p.x, list[0]!.p.z)}` : null,
);
const lamps = city.props.filter((p) => p.kind === 'lamp');
const lampCells = Map.groupBy(lamps, (p) => `${Math.floor(p.x / 8)},${Math.floor(p.z / 8)}`);
check(
  'a covered rack with a lamp standing in it',
  city.props.filter((p) => p.kind === 'bikes' && p.covered),
  (r) => {
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const l of lampCells.get(`${Math.floor(r.x / 8) + i},${Math.floor(r.z / 8) + j}`) ??
          []) {
          if (Math.hypot(l.x - r.x, l.z - r.z) < 3) return at(r.x, r.z);
        }
      }
    }
    return null;
  },
);
const treeCells = Map.groupBy(trees, (t) => `${Math.floor(t.x / 8)},${Math.floor(t.z / 8)}`);
check(
  'a covered rack with a tree in it',
  city.props.filter((p) => p.kind === 'bikes' && p.covered),
  (r) => {
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const t of treeCells.get(`${Math.floor(r.x / 8) + i},${Math.floor(r.z / 8) + j}`) ??
          []) {
          if (Math.hypot(t.x - r.x, t.z - r.z) < 2.5) return at(r.x, r.z);
        }
      }
    }
    return null;
  },
);

let bad = 0;
for (const { what, count, of, worst } of rows) {
  bad += count;
  console.log(
    `${String(count).padStart(5)} of ${String(of).padEnd(6)} ${what}${count ? `  e.g. ${worst.join('; ')}` : ''}`,
  );
}
console.log(`\n${bad} in all`);
