import { pointInRing } from '../data/geometry.ts';
import type { Terrain } from '../data/terrain.ts';
import { TREE_STRIDE } from '../data/trees.ts';
import type { Cell } from './cells.ts';
import { GARDEN, pick } from './palette.ts';

/**
 * What grows besides the trees, each where OpenStreetMap maps it and nowhere else, as the same
 * puffs of leaves the trees are drawn with (`createPuffMaterial`): hedges along their lines, shrubs
 * on what is mapped as scrub or woods, flowers on what is mapped as a flower bed. Which shrub stands
 * where within its mapped ground is a hash of its place, so it never changes.
 */

/** A hedge's puffs: every so many metres, this big, standing this high. */
const HEDGE = { every: 0.95, radius: 0.72, high: 0.78 } as const;
/** How much mapped scrub or woods a shrub takes (m²), and the most a single area gets. */
const SHRUB_AREA = 120;
const MOST = 60;
/** How much of a flower bed a clump takes (m²), and the most a single bed gets. */
const BED_AREA = 2.5;
const MOST_FLOWERS = 80;
/** A shrub keeps this far from a tree's trunk and a path's middle (m). */
const CLEAR = { tree: 1.8, path: 1.6 } as const;

interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function boxOf(ring: ArrayLike<number>): Box {
  let [minX, maxX, minZ, maxZ] = [Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < ring.length; i += 2) {
    [minX, maxX] = [Math.min(minX, ring[i]!), Math.max(maxX, ring[i]!)];
    [minZ, maxZ] = [Math.min(minZ, ring[i + 1]!), Math.max(maxZ, ring[i + 1]!)];
  }
  return { minX, maxX, minZ, maxZ };
}

const areaOf = ({ minX, maxX, minZ, maxZ }: Box) => (maxX - minX) * (maxZ - minZ);

/** A small, stable number in [0, 1) from a seed. */
const roll = (seed: number) => {
  const h = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return h - Math.floor(h);
};

/** What's taken in a cell, boxes first so a test is mostly comparisons. */
function takenIn(cell: Cell): (x: number, z: number) => boolean {
  const { ground } = cell;
  const rings: ArrayLike<number>[] = [
    ...cell.buildings.map((b) => b.ring),
    ...ground.water,
    ...ground.roads,
    ...ground.plazas,
    ...ground.parking,
    ...ground.bridges,
    ...ground.carriageways.map((c) => c.ring),
    ...ground.pitches.map((p) => p.ring),
  ];
  const boxes = rings.map(boxOf);
  const lines = ground.paths.map((p) => p.line);
  return (x, z) => {
    for (const [i, b] of boxes.entries()) {
      if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && pointInRing(rings[i]!, x, z))
        return true;
    }
    for (const line of lines) {
      for (let i = 0; i + 3 < line.length; i += 2) {
        const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
        const [dx, dz] = [bx - ax, bz - az];
        const t = Math.max(
          0,
          Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)),
        );
        if (Math.hypot(x - ax - dx * t, z - az - dz * t) < CLEAR.path) return true;
      }
    }
    return false;
  };
}

/** Along a hedge's line, but for where it's mapped into a house, the water or a road. */
function addHedges(
  push: (x: number, y: number, z: number, r: number, c: number) => void,
  cell: Cell,
  terrain: Pick<Terrain, 'height'>,
): void {
  const solid = [
    ...cell.buildings.map((b) => b.ring),
    ...cell.ground.water,
    ...cell.ground.carriageways.filter((c) => c.kind !== 'cycleway').map((c) => c.ring),
  ];
  const boxes = solid.map(boxOf);
  const inHouse = (x: number, z: number) =>
    boxes.some(
      (b, i) =>
        x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && pointInRing(solid[i]!, x, z),
    );
  for (const line of cell.hedges) {
    for (let i = 0; i + 3 < line.length; i += 2) {
      const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
      const length = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.round(length / HEDGE.every));
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps;
        const [x, z] = [ax + (bx - ax) * t, az + (bz - az) * t];
        if (inHouse(x, z)) continue;
        const seed = Math.round(x * 7 + z * 13);
        const r = HEDGE.radius * (0.9 + 0.2 * roll(seed));
        push(x, terrain.height(x, z) + HEDGE.high, z, r, pick(GARDEN.shrubs, seed));
      }
    }
  }
}

/**
 * Writes the hedges, shrubs and flowers of a cell into `into` and `colors`, as `addPuffs` does a
 * tree's: four numbers and four bytes a puff.
 */
export function addGarden(
  into: number[],
  colors: number[],
  cell: Cell,
  terrain: Pick<Terrain, 'height'>,
): void {
  const push = (x: number, y: number, z: number, r: number, c: number) => {
    into.push(x, y, z, r);
    colors.push(c >> 16, (c >> 8) & 255, c & 255, 255);
  };
  addHedges(push, cell, terrain);
  const { woods, flowerbeds } = cell.ground;
  if (!woods.length && !flowerbeds.length) return;
  const taken = takenIn(cell);
  const { trees } = cell;
  /** Spots inside `ring`, clear of what is taken: the same ones every time. */
  const spots = (ring: Float32Array, salt: number, want: number, keepOff: boolean) => {
    const box = boxOf(ring);
    const found: [number, number, number][] = [];
    for (let tryAt = 0; tryAt < want * 4 && found.length < want; tryAt++) {
      const seed = salt * 1009 + tryAt + Math.round(box.minX * 3 + box.minZ * 7);
      const x = box.minX + roll(seed) * (box.maxX - box.minX);
      const z = box.minZ + roll(seed + 1) * (box.maxZ - box.minZ);
      if (!pointInRing(ring, x, z) || (keepOff && taken(x, z))) continue;
      const crowded = () => {
        for (let i = 0; i < trees.length; i += TREE_STRIDE) {
          if (Math.hypot(trees[i]! - x, trees[i + 1]! - z) < CLEAR.tree) return true;
        }
        return false;
      };
      if (!(keepOff && crowded())) found.push([x, z, seed]);
    }
    return found;
  };
  for (const [g, ring] of woods.entries()) {
    const want = Math.min(MOST, Math.floor(areaOf(boxOf(ring)) / SHRUB_AREA));
    for (const [x, z, seed] of spots(ring, g, want, true)) {
      const puffs = 3 + Math.floor(roll(seed + 3) * 3);
      const color = pick(GARDEN.shrubs, seed);
      for (let i = 0; i < puffs; i++) {
        const t = i * 2.39996 + roll(seed + 4) * 6;
        const r = 0.55 + 0.3 * roll(seed + i + 5);
        push(
          x + Math.cos(t) * 0.55,
          terrain.height(x, z) + r * 0.7,
          z + Math.sin(t) * 0.55,
          r,
          color,
        );
      }
    }
  }
  for (const [g, ring] of flowerbeds.entries()) {
    const want = Math.min(MOST_FLOWERS, Math.max(3, Math.floor(areaOf(boxOf(ring)) / BED_AREA)));
    // One planting a bed, as a gardener would, and now and then a second colour.
    const main = pick(GARDEN.flowers, g * 31 + Math.round(ring[0]! * 3));
    const other = pick(GARDEN.flowers, g * 37 + Math.round(ring[1]! * 5));
    for (const [x, z, seed] of spots(ring, g + 5000, want, false)) {
      const color = roll(seed + 7) < 0.8 ? main : other;
      push(x, terrain.height(x, z) + 0.26, z, 0.3 + 0.1 * roll(seed + 8), color);
    }
  }
}
