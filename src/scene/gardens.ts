import { pointInRing } from '../data/geometry.ts';
import type { Terrain } from '../data/terrain.ts';
import type { Cell } from './cells.ts';
import { GARDEN, pick } from './palette.ts';

/**
 * What grows between a park's trees: shrubs and beds of flowers on the green ground of a cell, as
 * the same puffs of leaves its trees are drawn with (`createPuffMaterial`), so a lawn isn't only
 * trees on a lawn. Never on a road, a path, a pitch, water or a house. Nothing to walk round: the
 * walker brushes through them.
 */

/** How much green a shrub takes (m²), and the most a single lawn gets. */
const SHRUB_AREA = 220;
const MOST = 40;
/** A shrub keeps this far from a tree's trunk and a path's middle (m). */
const CLEAR = { tree: 1.8, path: 1.6 } as const;
/** The share of them that are beds of flowers. */
const FLOWER_BEDS = 0.15;

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

function areaOf({ minX, maxX, minZ, maxZ }: Box): number {
  return (maxX - minX) * (maxZ - minZ);
}

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
      if (
        x >= b.minX &&
        x <= b.maxX &&
        z >= b.minZ &&
        z <= b.maxZ &&
        pointInRing(rings[i]!, x, z)
      ) {
        return true;
      }
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

/**
 * Writes the shrubs and flower beds of a cell's green into `into` and `colors`, as `addPuffs` does
 * a tree's.
 */
export function addGarden(
  into: number[],
  colors: number[],
  cell: Cell,
  terrain: Pick<Terrain, 'height'>,
): void {
  const { green } = cell.ground;
  if (!green.length) return;
  const taken = takenIn(cell);
  const { trees } = cell;
  const push = (x: number, y: number, z: number, r: number, c: number) => {
    into.push(x, y, z, r);
    colors.push(c >> 16, (c >> 8) & 255, c & 255, 255);
  };
  for (const [g, ring] of green.entries()) {
    const box = boxOf(ring);
    const want = Math.min(MOST, Math.floor(areaOf(box) / SHRUB_AREA));
    let found = 0;
    for (let tryAt = 0; tryAt < want * 3 && found < want; tryAt++) {
      const seed = g * 1009 + tryAt + Math.round(box.minX * 3 + box.minZ * 7);
      const x = box.minX + roll(seed) * (box.maxX - box.minX);
      const z = box.minZ + roll(seed + 1) * (box.maxZ - box.minZ);
      if (!pointInRing(ring, x, z) || taken(x, z)) continue;
      let clear = true;
      for (let i = 0; i < trees.length && clear; i += 4) {
        clear = Math.hypot(trees[i]! - x, trees[i + 1]! - z) >= CLEAR.tree;
      }
      if (!clear) continue;
      found++;
      const y = terrain.height(x, z);
      const flowers = roll(seed + 2) < FLOWER_BEDS;
      const puffs = flowers ? 6 : 3 + Math.floor(roll(seed + 3) * 3);
      const color = pick(flowers ? GARDEN.flowers : GARDEN.shrubs, seed);
      for (let i = 0; i < puffs; i++) {
        const t = i * 2.39996 + roll(seed + 4) * 6;
        const [spread, r] = flowers ? [0.6, 0.3] : [0.55, 0.55 + 0.3 * roll(seed + i + 5)];
        push(x + Math.cos(t) * spread, y + r * 0.7, z + Math.sin(t) * spread, r, color);
      }
    }
  }
}
