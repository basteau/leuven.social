/**
 * How a wall's windows are laid along it: a whole number of bays, fitted to the wall by the mesh
 * builder and interpolated across it in a spare vertex byte (`bay`, the colour's fourth), so no
 * window is cut by the wall's end, a corner or the house next door. The width a house aims for is
 * its own, seeded by its wall top; a wall rounds to whole bays round it, and one too short for a
 * window has none.
 *
 * Each vertex's byte packs a bay number and a flag: `2 · (8 · page + bay) + joined`. `page` varies
 * a wall's bay numbers, so its door, flowers and lit windows are its own, and a bay number is
 * still whole at both ends of a wall. `joined`, set on a wall's first corner, marks it as starting
 * against a neighbour: the shader reads it where the wall starts and draws the join there.
 */

/**
 * The bay widths a house's own rhythm aims for (m), seeded by its wall top. Wide enough that a
 * front reads as a few windows with wall between them, at this zoom, rather than a grid of them.
 */
export const BAY_MIN = 3.2;
export const BAY_MAX = 4.6;
/** How fast the wall top turns the width (a mix of the top's centimetres, the same in the shader). */
export const BAY_SPREAD = 7.3;
/** A church's lancets, a civic hall's niches: their own bays (m). */
export const LANCET_BAY = 5.5;
export const NICHE_BAY = 1.6;
/** The most bays a wall gets (the byte holds them), and how many pages a byte has to number them. */
const MOST_BAYS = 127;
export const BAYS_PER_PAGE = 8;
/** A wall shorter than this share of its bay gets none: a window would be a sliver. */
const SHORT_WALL = 0.42;
/** Nor is a pier of any kind this short (m) worth a window. */
const SHORTEST_WALL = 1.6;

const fract = (x: number) => x - Math.floor(x);

/** The width (m) a house with this wall top aims for: its windows' own rhythm. */
export function bayTarget(top: number): number {
  return BAY_MIN + (BAY_MAX - BAY_MIN) * fract(top * BAY_SPREAD);
}

/** The bays a wall of this kind and wall top aims for (m). */
export function bayTargetFor(windows: boolean | 'lancet' | 'ornate', top: number): number {
  return windows === 'lancet' ? LANCET_BAY : windows === 'ornate' ? NICHE_BAY : bayTarget(top);
}

/** The whole number of bays a wall of `length` takes, none if it is too short for a window. */
export function fitBays(length: number, target: number): number {
  if (length < Math.max(SHORTEST_WALL, target * SHORT_WALL)) return 0;
  return Math.min(MOST_BAYS, Math.max(1, Math.round(length / target)));
}

/**
 * Bays over a run of walls that bend gently, as a curved corner does: whole bays on each, spaced
 * as one wall would be, with a facet too short for a window carrying its share on. A wall in a
 * run of its own is simply `fitBays`.
 */
export function fitRun(lengths: readonly number[], target: number): number[] {
  if (lengths.length === 1) return [fitBays(lengths[0]!, target)];
  let along = 0;
  let placed = 0;
  return lengths.map((length) => {
    along += length;
    const due = Math.round(along / target);
    // Never more bays than this wall could hold spaced as one, or what a corner's short facets
    // carried on would be crammed in at under a metre each.
    const fits = Math.max(1, Math.round(length / target));
    const bays =
      length < Math.max(SHORTEST_WALL, target * SHORT_WALL)
        ? 0
        : Math.max(0, Math.min(due - placed, fits));
    placed += bays;
    return Math.min(bays, MOST_BAYS);
  });
}

/** Mixes a wall into a page of bay numbers: the same every load. */
export function bayPage(seed: number, edge: number): number {
  let h = Math.imul(seed ^ (edge * 0x9e3779b9), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) % 16;
}

/** The two corner bytes of a wall with `bays` bays, as the `bay` vertex attribute carries them. */
export function bayBytes(bays: number, page: number, joined: boolean): readonly [number, number] {
  const roomy = Math.min(page, Math.floor((MOST_BAYS - bays) / BAYS_PER_PAGE));
  const start = BAYS_PER_PAGE * roomy;
  return [2 * start + (joined && bays > 0 ? 1 : 0), 2 * (start + bays)];
}
