/**
 * Where a person can walk: anywhere on the map's ground, lawns, car parks and verges included,
 * except into a building or tank (its courtyards count too: they're private), into the water,
 * onto railway land or up onto a platform. Roads, squares, footpaths and bridge decks open the
 * ground again wherever they cross those, so a bridge carries you over the river and a level
 * crossing over the tracks. Bridge parapets are low walls: they keep you on the deck.
 *
 * A raster of 1 m cells, filled in 64 m tiles the first time anything asks about them, so the
 * map pays nothing until someone walks, and then only for the streets they reach.
 */

import { CellGrid, TILE, ringBox, wallPush } from './cell-grid.ts';
import type { Wall } from './cell-grid.ts';
import type { Bounds, City } from './city.ts';
import { areaIndex } from './geometry.ts';

/** Cell size in metres: narrower than any footpath, so every path stays connected. */
export const WALK_CELL = 1;
/** Narrow paths still get a ribbon at least this wide, so diagonal ones never break apart. */
const MIN_HALF_WIDTH = 0.75;

/**
 * A cell's value: closed ground, open ground, a street (a road, square, path or bridge deck), or
 * a building, tank or parapet (its height in metres + 3). Walks start on a street: dry ground
 * behind a block can be a garden walled in by houses, with no way out.
 */
const CLOSED = 0;
const OPEN = 1;
const STREET = 2;
/** A solid of no height: a trunk or a bench, which closes its cell but nothing over it. */
const SOLID = 3;
/** A parapet's height (m), and the half width it closes so a diagonal one leaves no gap. */
const PARAPET_HEIGHT = 1.1;
const PARAPET_HALF = 0.75;
/** Half a parapet's thickness as drawn, capstone included (m). */
const PARAPET_FACE = 0.25;

/**
 * What stands on the ground at about knee to head height and is drawn too small for the city
 * file to hold as a wall: tree trunks, lamp posts, benches, racks, statues, parasols. Posts are
 * flat [x, z, radius, …] triples, footprints closed rings, each as the scene draws it.
 */
export interface Solids {
  posts: ArrayLike<number>;
  rings: readonly ArrayLike<number>[];
}
/**
 * A post at least this round (m) also closes the walk cell its centre covers, so routes go
 * round it (a trunk); a thinner one (a lamp post) is only met as drawn, so a narrow pavement
 * with a lamp on it keeps its cells and a route along it.
 */
const GRID_POST = 0.25;

export type WalkLayers = Pick<
  City,
  'area' | 'bounds' | 'roads' | 'plazas' | 'paths' | 'buildings' | 'tanks'
> &
  Partial<Pick<City, 'water' | 'railLand' | 'platforms' | 'bridges' | 'parapets'>>;

interface Shape {
  ring: ArrayLike<number>;
  /** 0 for ground that closes, 1 for walkable surfaces, the height code for buildings. */
  value: number;
}
interface Ribbon {
  line: ArrayLike<number>;
  half: number;
  /** As for a shape: open for a path, a height code for a parapet. */
  value: number;
}

const heightCode = (height: number) => Math.min(255 - SOLID, Math.ceil(height)) + SOLID;

/** A trunk against a facade keeps the building's height in its cells. */
const keep = (value: number) => (old: number) => value === SOLID && old > SOLID;

export class WalkGrid {
  readonly #grid: CellGrid;
  readonly #area: readonly Bounds[];
  /** What touches each tile, in drawing order: surfaces and paths first, buildings on top. */
  readonly #shapes: Shape[][];
  readonly #ribbons: Ribbon[][];
  readonly #walls: Wall[][];
  /** Scratch for `wallOverlap`, which a step calls several times: nothing allocated. */
  readonly #sum: [number, number, number] = [0, 0, 0];
  #query = 0;

  constructor(city: WalkLayers, solids: Solids = { posts: [], rings: [] }) {
    this.#grid = new CellGrid(
      city.bounds,
      (tile, x0, z0, t) => this.#fill(tile, x0, z0, t),
      WALK_CELL,
    );
    this.#area = city.area;
    const tiles = this.#grid.tileCount;
    this.#shapes = Array.from({ length: tiles }, () => []);
    this.#ribbons = Array.from({ length: tiles }, () => []);
    this.#walls = Array.from({ length: tiles }, () => []);

    const each = (box: Bounds, visit: (tile: number) => void) => this.#grid.eachTile(box, visit);
    const closing = [...(city.water ?? []), ...(city.railLand ?? []), ...(city.platforms ?? [])];
    for (const ring of closing) {
      each(ringBox(ring), (t) => this.#shapes[t]!.push({ ring, value: CLOSED }));
    }
    for (const ring of [...city.roads, ...city.plazas, ...(city.bridges ?? [])]) {
      each(ringBox(ring), (t) => this.#shapes[t]!.push({ ring, value: STREET }));
    }
    for (const { line, width } of city.paths) {
      const half = Math.max(width / 2, MIN_HALF_WIDTH);
      each(ringBox(line, half), (t) => this.#ribbons[t]!.push({ line, half, value: STREET }));
    }
    // Tanks and silos are as solid as buildings, and as tall.
    for (const { ring, height } of [...city.buildings, ...city.tanks]) {
      const value = heightCode(height);
      const wall = { line: ring, ring: true, half: 0, box: ringBox(ring), seen: 0 };
      each(wall.box, (t) => {
        this.#shapes[t]!.push({ ring, value });
        this.#walls[t]!.push(wall);
      });
    }
    for (const line of city.parapets ?? []) {
      const ribbon = { line, half: PARAPET_HALF, value: heightCode(PARAPET_HEIGHT) };
      each(ringBox(line, PARAPET_HALF), (t) => this.#ribbons[t]!.push(ribbon));
      const wall = {
        line,
        ring: false,
        half: PARAPET_FACE,
        box: ringBox(line, PARAPET_FACE),
        seen: 0,
      };
      each(wall.box, (t) => this.#walls[t]!.push(wall));
    }
    // Low solids: met as drawn, and closing the cells they cover, at no height (`SOLID`), so
    // the camera and a click's ray pass over them.
    const { posts } = solids;
    for (let i = 0; i + 2 < posts.length; i += 3) {
      const [x, z, half] = [posts[i]!, posts[i + 1]!, posts[i + 2]!];
      const line = [x, z, x, z];
      const wall = { line, ring: false, half, box: ringBox(line, half), seen: 0 };
      const ribbon = { line, half, value: SOLID };
      each(wall.box, (t) => {
        this.#walls[t]!.push(wall);
        if (half >= GRID_POST) this.#ribbons[t]!.push(ribbon);
      });
    }
    for (const ring of solids.rings) {
      const wall = { line: ring, ring: true, half: 0, box: ringBox(ring), seen: 0 };
      each(wall.box, (t) => {
        this.#shapes[t]!.push({ ring, value: SOLID });
        this.#walls[t]!.push(wall);
      });
    }
    // Within each tile: what closes the ground, then what opens it again, then what stands on
    // it, so a bridge crosses the river and a building cuts through the road under it.
    for (const list of this.#shapes) list.sort((a, b) => a.value - b.value);
    for (const list of this.#ribbons) list.sort((a, b) => a.value - b.value);
  }

  get cols(): number {
    return this.#grid.cols;
  }

  get rows(): number {
    return this.#grid.rows;
  }

  /** The cell holding (x, z), or -1 off the grid. */
  cellAt(x: number, z: number): number {
    return this.#grid.cellAt(x, z);
  }

  /** The centre of a cell, in metres. */
  centre(cell: number): [number, number] {
    return this.#grid.centre(cell);
  }

  /** A cell's raw value; cells off the grid are closed. */
  value(cell: number): number {
    return this.#grid.value(cell, CLOSED);
  }

  open(cell: number): boolean {
    const v = this.value(cell);
    return v === OPEN || v === STREET;
  }

  /** Whether a cell is a road, square, path or bridge deck: somewhere a walk can start. */
  street(cell: number): boolean {
    return this.value(cell) === STREET;
  }

  /** Whether (x, z) is in an open cell. */
  walkable(x: number, z: number): boolean {
    return this.open(this.cellAt(x, z));
  }

  /**
   * How closed the ground is at (x, z), from 0 to 1: whether the cells round it are water,
   * railway or off the map, blended bilinearly between their centres. The edge runs where it
   * crosses a half, as a nearly straight line even along a staircase of cells. Walls are not
   * in it: bodies meet those as drawn (`wallOverlap`).
   */
  closed(x: number, z: number): number {
    return this.#grid.blend(x, z, (v) => v === CLOSED);
  }

  /**
   * How far a circle of `radius` at (x, z) reaches into walls (m), 0 where it's clear: the
   * outlines of buildings, tanks and parapets as drawn, not their cells, so a facade at any
   * angle is a straight line and a corner a point to slide round. Writes the way out into
   * `out`, summed over every face it touches, so in a corner it points out of the corner and in
   * a lane between two walls it balances. A centre inside a footprint is pushed out through
   * the nearest face.
   */
  wallOverlap(x: number, z: number, radius: number, out: [number, number]): number {
    const sum = this.#sum;
    [sum[0], sum[1], sum[2]] = [0, 0, 0];
    const query = ++this.#query;
    const [c0, r0] = this.#grid.tileOf(x - radius, z - radius);
    const [c1, r1] = this.#grid.tileOf(x + radius, z + radius);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        wallPush(this.#walls[r * this.#grid.tilesX + c]!, x, z, radius, query, sum);
      }
    }
    const length = Math.hypot(sum[0], sum[1]);
    if (length < 1e-9) return 0;
    [out[0], out[1]] = [sum[0] / length, sum[1] / length];
    return sum[2];
  }

  /** Roof height of the building over (x, z), or 0 where there is none. */
  buildingHeight(x: number, z: number): number {
    const v = this.value(this.cellAt(x, z));
    return v >= SOLID ? v - SOLID : 0;
  }

  /**
   * The walkable cell centre nearest (x, z) within `radius` metres, or null; with `street`, the
   * nearest street cell, so a walk never starts in a garden walled in by houses.
   */
  nearest(x: number, z: number, radius: number, street = false): [number, number] | null {
    return this.#grid.nearest(x, z, radius, (cell) =>
      street ? this.street(cell) : this.open(cell),
    );
  }

  /** Up to `most` open places within `radius` of (x, z), nearest first and spread out. */
  around(x: number, z: number, radius: number, most: number): [number, number][] {
    return this.#grid.around(x, z, radius, (cell) => this.open(cell), most);
  }

  /** Rasterises one tile from everything that touches it. */
  #fill(tile: Uint8Array, x0: number, z0: number, t: number): void {
    const grid = this.#grid;
    const [shapes, ribbons] = [this.#shapes[t]!, this.#ribbons[t]!];
    // The ground is open; water and railway close it, surfaces and paths open it again, then
    // buildings, tanks and parapets stand on it.
    tile.fill(OPEN);
    for (const s of shapes) if (s.value < SOLID) grid.fillRing(tile, s.ring, s.value, x0, z0);
    for (const r of ribbons) {
      if (r.value < SOLID) grid.fillRibbon(tile, r.line, r.half, r.value, x0, z0, keep(r.value));
    }
    for (const s of shapes) if (s.value >= SOLID) grid.fillRing(tile, s.ring, s.value, x0, z0);
    for (const r of ribbons) {
      if (r.value >= SOLID) grid.fillRibbon(tile, r.line, r.half, r.value, x0, z0, keep(r.value));
    }
    // Paths can spill a little past the map's edge: nothing off the slab is walkable.
    for (let r = 0; r < TILE; r++) {
      const z = z0 + (r + 0.5) * WALK_CELL;
      for (let c = 0; c < TILE; c++) {
        const v = tile[r * TILE + c];
        if (v !== OPEN && v !== STREET) continue;
        if (areaIndex(this.#area, x0 + (c + 0.5) * WALK_CELL, z) < 0) tile[r * TILE + c] = CLOSED;
      }
    }
  }
}

const PICK_STEP = 0.5;

/**
 * Where a tap that hit the scene at (x, z) means to go. Ground, a tree, a bench or a car: the
 * ground under what it hit. A wall facing the camera (`camera`, a horizontal unit vector toward
 * it): the street at its foot, the one the person sees. A roof: the building itself, so the
 * street on the side of it nearest the one walking (`from`), not one round the back. Out of a
 * building by half-metre steps.
 */
export function aimFor(
  grid: WalkGrid,
  x: number,
  z: number,
  camera: readonly [number, number],
  from: readonly [number, number],
): [number, number] {
  const inside = (px: number, pz: number) => grid.buildingHeight(px, pz) > 0;
  if (!inside(x, z)) return [x, z];
  const wall = !inside(x + camera[0] * WALL_DEPTH, z + camera[1] * WALL_DEPTH);
  const [dx, dz] = [from[0] - x, from[1] - z];
  const length = Math.hypot(dx, dz);
  const [ux, uz] = wall || length < 1e-6 ? camera : [dx / length, dz / length];
  for (let k = 0; k < 400 && inside(x, z); k++) {
    x += ux * PICK_STEP;
    z += uz * PICK_STEP;
  }
  return [x, z];
}
/** A hit this close to a building's camera side (m) is on its wall, not its roof. */
const WALL_DEPTH = 1;
