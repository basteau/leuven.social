import type { TreeKind } from './city.ts';

/**
 * Merges the two tree sources: OpenStreetMap's mapped street trees and the crowns found in the
 * LiDAR canopy (parks, gardens and courtyards nobody mapped). A mapped tree takes the height of
 * the crown it stands under, and that crown isn't added twice.
 */

/** A crown within this distance of a mapped tree is that tree (m). */
const SAME_TREE = 4;
/** Height for a mapped tree with no crown over it: young, or planted after the 2013–15 survey. */
export const DEFAULT_TREE_HEIGHT = 7;

export interface Trees {
  /** Flat [x0, z0, x1, z1, …] positions. */
  positions: number[];
  heights: number[];
  /** Each tree's place in `TREE_KINDS` (a LiDAR crown's is 0, broad). */
  kinds: number[];
}

/** How many numbers a cell keeps a tree in: x, z, its seed, its height and its kind. */
export const TREE_STRIDE = 5;

const CONIFER = /pinus|picea|abies|apies|taxus|thuja|larix|cedrus|pseudotsuga|conifeer|levensboom/;
const POPLAR = /populus|populier/;
const WILLOW = /salix|wilg/;
const COPPER = /atropunicea|purpurea|rode beuk|bruine beuk/;

/** What kind of tree OSM says it is (`TREE_KINDS`): its leaves, and its genus and species. */
export function treeKindOf(tags: Record<string, string | undefined>): TreeKind {
  const name =
    `${tags.genus ?? ''} ${tags.species ?? ''} ${tags['species:nl'] ?? ''}`.toLowerCase();
  if (tags.leaf_type === 'needleleaved' || CONIFER.test(name)) return 'conifer';
  if (POPLAR.test(name)) return 'column';
  if (WILLOW.test(name)) return 'willow';
  if (COPPER.test(name)) return 'copper';
  return 'broad';
}

const cell = (x: number, z: number) => `${Math.floor(x / SAME_TREE)},${Math.floor(z / SAME_TREE)}`;

/**
 * `osm` is flat [x, z, …], `osmKinds` their kinds (`TREE_KINDS`, broad if left out); `crowns` is
 * [x, z, height] triples from the LiDAR.
 */
export function mergeTrees(
  osm: ArrayLike<number>,
  crowns: readonly (readonly [number, number, number])[],
  osmKinds: ArrayLike<number> = [],
): Trees {
  const grid = new Map<string, number[]>();
  for (const [i, [x, z]] of crowns.entries()) {
    const key = cell(x, z);
    grid.set(key, [...(grid.get(key) ?? []), i]);
  }
  const used = new Set<number>();
  const positions: number[] = [];
  const heights: number[] = [];
  const kinds: number[] = [];
  for (let i = 0; i < osm.length; i += 2) {
    const x = osm[i]!;
    const z = osm[i + 1]!;
    let best = -1;
    let bestDistance = SAME_TREE;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const j of grid.get(cell(x + dx * SAME_TREE, z + dz * SAME_TREE)) ?? []) {
          const d = Math.hypot(crowns[j]![0] - x, crowns[j]![1] - z);
          if (!used.has(j) && d < bestDistance) [best, bestDistance] = [j, d];
        }
      }
    }
    if (best >= 0) used.add(best);
    positions.push(x, z);
    heights.push(best >= 0 ? crowns[best]![2] : DEFAULT_TREE_HEIGHT);
    kinds.push(osmKinds[i / 2] ?? 0);
  }
  for (const [j, [x, z, h]] of crowns.entries()) {
    if (used.has(j)) continue;
    positions.push(x, z);
    heights.push(h);
    kinds.push(0);
  }
  return { positions, heights, kinds };
}

/** How much larger than its model a tree this tall is drawn (src/scene/trees.ts). */
export const treeScale = (height: number): number => Math.min(Math.max(height / 6.8, 0.7), 2.8);
/**
 * The widest any trunk is drawn (m). A crown spreads with the tree's height, but a 12 m lime
 * or plane by the street is about half a metre across at the foot, not two and a half.
 */
export const MAX_TRUNK = 0.35;
/**
 * The widest a tree's trunk is drawn at the ground (m): what street furniture keeps clear of,
 * and what a walker walks round.
 */
export const trunkRadius = (height: number): number =>
  Math.min(0.55 * treeScale(height) ** 0.8, MAX_TRUNK);

/**
 * Drops the LiDAR crowns (every tree after the first `mapped`) whose trunk would stand in
 * something mapped, such as a bench or a statue: the survey took it for a crown, or the crown
 * leans over it from a trunk elsewhere. Mapped trees stay.
 */
export function clearCrowns(
  trees: Trees,
  mapped: number,
  blocked: (x: number, z: number, radius: number) => boolean,
): Trees {
  const out: Trees = { positions: [], heights: [], kinds: [] };
  for (const [i, h] of trees.heights.entries()) {
    const [x, z] = [trees.positions[i * 2]!, trees.positions[i * 2 + 1]!];
    if (i >= mapped && blocked(x, z, trunkRadius(h))) continue;
    out.positions.push(x, z);
    out.heights.push(h);
    out.kinds.push(trees.kinds[i]!);
  }
  return out;
}
