/**
 * Shop fronts from OpenStreetMap: each shop, café, bar, restaurant, pharmacy or bank mapped in or
 * beside a footprint has a front on the ground floor, on the wall that faces its street
 * (`frontWall`). The scene draws it by its kind (src/data/shop-kinds.ts):
 * a glazed ground floor under the kind's awning or fascia, and up close a hanging sign and, where
 * OSM maps outdoor seating and the pavement has room, a table with two chairs.
 */

import type { Building, Kind, ShopFront } from './city.ts';
import { footprintOf, frontWall, nearestOn } from './facades.ts';
import type { Facades, Facing } from './facades.ts';
import { CLEARANCE, discInFootprint, footprintsOverlap } from './props.ts';
import type { Footprint, Shapes } from './props.ts';
import { rank, shopKind } from './shop-kinds.ts';

type Tags = Record<string, string | undefined>;

/** Only these kinds turn into shops; churches, civic buildings and sheds keep theirs. */
const PROMOTED = new Set<Kind>(['house', 'apartments', 'other']);
/** A second front of the same kind on the same wall this close (m) is the same shop mapped twice. */
const TWIN = 1.5;

/** Where a front is: its point on the wall, the wall's direction (u) and its outward normal (n). */
export interface FrontPoint {
  x: number;
  z: number;
  ux: number;
  uz: number;
  nx: number;
  nz: number;
  /** The wall's length (m); the front lies `along` it. */
  length: number;
}

/** A front's place on its building's ring (counter-clockwise, as the bake stores them). */
export function frontPoint(
  ring: ArrayLike<number>,
  f: Pick<ShopFront, 'edge' | 'along'>,
): FrontPoint {
  const n = ring.length;
  const [ax, az] = [ring[f.edge * 2]!, ring[f.edge * 2 + 1]!];
  const [bx, bz] = [ring[(f.edge * 2 + 2) % n]!, ring[(f.edge * 2 + 3) % n]!];
  const length = Math.hypot(bx - ax, bz - az) || 1;
  const [ux, uz] = [(bx - ax) / length, (bz - az) / length];
  return { x: ax + ux * f.along, z: az + uz * f.along, ux, uz, nx: uz, nz: -ux, length };
}

/**
 * A terrace as drawn (src/scene/storefronts.ts): a café table and two chairs along the wall, a
 * third larger than life like the furniture, `out` metres from it, reaching `u` along it and `v`
 * towards and away from the wall (m).
 */
export const TERRACE = { u: 1.15, v: 0.45, out: 0.75 } as const;
/**
 * A café table on a square, under its parasol (src/scene/storefronts.ts): its chairs stand
 * `chair` metres from its middle, their backs reaching `reach`, which the walk grid keeps clear.
 */
export const CAFE_TABLE = { chair: 0.85, reach: 1.15 } as const;
/** A terrace leaves this much pavement (m) clear between it and the carriageway. */
export const WALKWAY = 1.5;

/** What a terrace covers on the ground, from the middle of its table outward. */
export function terraceFootprint(p: FrontPoint): Footprint {
  const { u, v, out } = TERRACE;
  return {
    x: p.x + p.nx * out,
    z: p.z + p.nz * out,
    fx: p.nx,
    fz: p.nz,
    u0: -u,
    u1: u,
    v0: -v,
    v1: v,
  };
}

/** A shop, as an OSM point: where it is mapped and its tags. */
export interface ShopPoint {
  x: number;
  z: number;
  tags: Tags;
}

export interface FrontInput {
  facades: Facades;
  /** Each street's centre lines by its name's place in the table (`streetSegments`). */
  streets: ReadonlyMap<number, readonly number[]>;
  /** The name table, by name. */
  names: ReadonlyMap<string, number>;
  /** Each named square's outlines, by its name's place in the table. */
  squares: ReadonlyMap<number, readonly ArrayLike<number>[]>;
  /** Whether (x, z) is public ground: a road, a square. */
  open: (x: number, z: number) => boolean;
  /** Buildings with no front: landmark models stand proud of their footprints. */
  skip: ReadonlySet<number>;
}

export interface PlacedFronts {
  fronts: ShopFront[];
  placed: Partial<Record<Facing, number>>;
  skipped: Record<string, number>;
}

/** The street a shop with no usable `addr:street` is on: the one nearest it. */
function nearestStreet(streets: ReadonlyMap<number, readonly number[]>, x: number, z: number) {
  let [best, distance] = [-1, Infinity];
  for (const [name, segments] of streets) {
    const d = nearestOn(segments, x, z)[2];
    if (d < distance) [best, distance] = [name, d];
  }
  return best;
}

/**
 * Each shop's front: its kind, on the wall of its footprint (or the nearest within 3 m) that
 * faces its `addr:street` (or, without one, the nearest street), where its point meets it. One
 * mapped twice (a node and its building) is placed once. Sorted by building, each building's
 * most telling front first: that one is its main front, which its facade shows.
 */
export function placeFronts(points: readonly ShopPoint[], input: FrontInput): PlacedFronts {
  const { facades, streets, names, squares, open, skip } = input;
  const fronts: ShopFront[] = [];
  const placed: Partial<Record<Facing, number>> = {};
  const skipped: Record<string, number> = {};
  const miss = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
  for (const { x, z, tags } of points) {
    const kind = shopKind(tags);
    if (!kind) continue;
    const building = footprintOf(facades, x, z);
    if (building < 0 || skip.has(building)) {
      miss(building < 0 ? 'no footprint' : 'landmark');
      continue;
    }
    const street = names.get(tags['addr:street']?.trim() ?? '') ?? nearestStreet(streets, x, z);
    const found = frontWall(facades, building, x, z, {
      segments: streets.get(street) ?? [],
      square: squares.get(street) ?? [],
      open,
    });
    if (!found) {
      miss('no wall facing the street');
      continue;
    }
    const wall = facades.walls[found.w]!;
    const along = (found.px - wall.ax) * wall.ux + (found.pz - wall.az) * wall.uz;
    const twin = fronts.find(
      (f) =>
        f.building === building &&
        f.edge === wall.edge &&
        f.kind === kind &&
        Math.abs(f.along - along) < TWIN,
    );
    if (twin) {
      miss('mapped twice');
      continue;
    }
    placed[found.how] = (placed[found.how] ?? 0) + 1;
    const front = {
      building,
      edge: wall.edge,
      along,
      kind,
      terrace: tags.outdoor_seating === 'yes',
    };
    fronts.push(front);
  }
  fronts.sort(
    (a, b) =>
      a.building - b.building ||
      rank(a.kind) - rank(b.kind) ||
      a.edge - b.edge ||
      a.along - b.along,
  );
  return { fronts, placed, skipped };
}

/**
 * Hangs each building's main front (its first) on it as `front`, as the decoder does, and makes
 * houses, flats and other buildings with one `retail`. Returns how many changed kind.
 */
export function markShopFronts(buildings: Building[], fronts: readonly ShopFront[]): number {
  let marked = 0;
  for (const front of fronts) {
    const b = buildings[front.building]!;
    b.front ??= front;
    if (!PROMOTED.has(b.kind)) continue;
    b.kind = 'retail';
    marked++;
  }
  return marked;
}

/** What a terrace must keep clear of. */
export interface TerraceSurroundings {
  /** Carriageways and cycle tracks: a terrace stays off them and leaves WALKWAY before them. */
  roads: Shapes;
  /** Footprints, tanks and parapets. */
  solid: Shapes;
  water: Shapes;
  /** Street furniture and monuments as placed (`propFootprint`). */
  props: readonly Footprint[];
  /** Tree trunks (x, z, radius). */
  trunks: readonly (readonly [number, number, number])[];
}

const grow = (f: Footprint, by: number): Footprint => ({
  ...f,
  u0: f.u0 - by,
  u1: f.u1 + by,
  v0: f.v0 - by,
  v1: f.v1 + by,
});
/** What in `list` lies within `r` (m) of a footprint's centre, by its own. */
const near = <T extends { x: number; z: number }>(list: readonly T[], f: Footprint, r: number) =>
  list.filter((o) => Math.abs(o.x - f.x) < r && Math.abs(o.z - f.z) < r);
/** A terrace may slide this far (m) along its wall, in these steps, to find room. */
const SLIDE = 1.5;
const SLIDE_STEP = 0.25;

/**
 * Keeps a terrace only where it fits, by the rules street furniture is placed by (`placeProps`):
 * its table and chairs, with CLEARANCE round them, off walls, kerbs, water, trunks, furniture and
 * the other terraces, and WALKWAY of pavement left between them and the carriageway, so a narrow
 * pavement is never blocked. It may slide along its wall a little, and its front with it. In
 * place; returns how many terraces stand.
 */
export function fitTerraces(
  fronts: ShopFront[],
  rings: readonly ArrayLike<number>[],
  around: TerraceSurroundings,
): number {
  const placed: Footprint[] = [];
  const trunks = around.trunks.map(([x, z, r]) => ({ x, z, r }));
  const fits = (f: Footprint) => {
    const room = grow(f, CLEARANCE);
    const walkway = { ...f, v0: f.v1, v1: f.v1 + WALKWAY };
    if (around.solid.touches(room) || around.water.touches(room)) return false;
    if (around.roads.touches(room) || around.roads.touches(walkway)) return false;
    if (around.solid.touches(walkway)) return false;
    const others = [...near(around.props, f, 12), ...near(placed, f, 12)];
    if (others.some((o) => footprintsOverlap(room, o))) return false;
    return !near(trunks, f, 6).some((t) => discInFootprint(room, t.x, t.z, t.r));
  };
  for (const front of fronts) {
    if (!front.terrace) continue;
    front.terrace = false;
    const ring = rings[front.building]!;
    const { length } = frontPoint(ring, front);
    for (let k = 0; k <= (SLIDE / SLIDE_STEP) * 2; k++) {
      const along = front.along + Math.ceil(k / 2) * SLIDE_STEP * (k % 2 ? 1 : -1);
      if (along < TERRACE.u || along > length - TERRACE.u) continue;
      const f = terraceFootprint(frontPoint(ring, { edge: front.edge, along }));
      if (!fits(f)) continue;
      Object.assign(front, { along, terrace: true });
      placed.push(f);
      break;
    }
  }
  return placed.length;
}
