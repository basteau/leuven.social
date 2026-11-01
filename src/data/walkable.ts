/**
 * Where a person can walk: road surfaces (pavements included), squares and footpaths. Never
 * inside a building's footprint (its courtyards count too: they're private), and never on water
 * or green that no road or path crosses, so private gardens and the river stay out of reach.
 *
 * A raster of 1 m cells, filled in 64 m tiles the first time anything asks about them, so the
 * map pays nothing until someone walks, and then only for the streets they reach.
 */

import type { Bounds, City } from './city.ts';
import { areaIndex } from './geometry.ts';

/** Cell size in metres: narrower than any footpath, so every path stays connected. */
export const WALK_CELL = 1;
const TILE = 64;
/** Narrow paths still get a ribbon at least this wide, so diagonal ones never break apart. */
const MIN_HALF_WIDTH = 0.75;

/** A cell's value: closed ground, walkable, or a building or tank (its height in metres + 1). */
const CLOSED = 0;
const OPEN = 1;

export type WalkLayers = Pick<
  City,
  'area' | 'bounds' | 'roads' | 'plazas' | 'paths' | 'buildings' | 'tanks'
>;

interface Shape {
  ring: ArrayLike<number>;
  /** 1 for walkable surfaces, the height code for buildings. */
  value: number;
}
interface Ribbon {
  line: ArrayLike<number>;
  half: number;
}

const ringBox = (ring: ArrayLike<number>, pad = 0): Bounds => {
  let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < ring.length; i += 2) {
    [minX, maxX] = [Math.min(minX, ring[i]!), Math.max(maxX, ring[i]!)];
    [minZ, maxZ] = [Math.min(minZ, ring[i + 1]!), Math.max(maxZ, ring[i + 1]!)];
  }
  return { minX: minX - pad, minZ: minZ - pad, maxX: maxX + pad, maxZ: maxZ + pad };
};

export class WalkGrid {
  readonly cols: number;
  readonly rows: number;
  readonly #origin: [number, number];
  readonly #area: readonly Bounds[];
  readonly #tilesX: number;
  readonly #tiles: (Uint8Array | undefined)[];
  /** What touches each tile, in drawing order: surfaces and paths first, buildings on top. */
  readonly #shapes: Shape[][];
  readonly #ribbons: Ribbon[][];
  #crossings = new Float64Array(64);

  constructor(city: WalkLayers) {
    const { minX, minZ, maxX, maxZ } = city.bounds;
    this.#origin = [minX, minZ];
    this.#area = city.area;
    this.cols = Math.ceil((maxX - minX) / WALK_CELL);
    this.rows = Math.ceil((maxZ - minZ) / WALK_CELL);
    this.#tilesX = Math.ceil(this.cols / TILE);
    const tiles = this.#tilesX * Math.ceil(this.rows / TILE);
    this.#tiles = Array.from({ length: tiles });
    this.#shapes = Array.from({ length: tiles }, () => []);
    this.#ribbons = Array.from({ length: tiles }, () => []);

    const each = (box: Bounds, visit: (tile: number) => void) => {
      const [c0, r0] = this.#tileOf(box.minX, box.minZ);
      const [c1, r1] = this.#tileOf(box.maxX, box.maxZ);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) visit(r * this.#tilesX + c);
    };
    for (const ring of [...city.roads, ...city.plazas]) {
      each(ringBox(ring), (t) => this.#shapes[t]!.push({ ring, value: OPEN }));
    }
    for (const { line, width } of city.paths) {
      const half = Math.max(width / 2, MIN_HALF_WIDTH);
      each(ringBox(line, half), (t) => this.#ribbons[t]!.push({ line, half }));
    }
    // Tanks and silos are as solid as buildings, and as tall.
    for (const { ring, height } of [...city.buildings, ...city.tanks]) {
      const value = Math.min(254, Math.ceil(height)) + 1;
      each(ringBox(ring), (t) => this.#shapes[t]!.push({ ring, value }));
    }
    // Buildings go last within each tile, so they cut through any road drawn under them.
    for (const list of this.#shapes) list.sort((a, b) => a.value - b.value);
  }

  #tileOf(x: number, z: number): [number, number] {
    const c = Math.floor((x - this.#origin[0]) / WALK_CELL / TILE);
    const r = Math.floor((z - this.#origin[1]) / WALK_CELL / TILE);
    const maxC = this.#tilesX - 1;
    const maxR = this.#tiles.length / this.#tilesX - 1;
    return [Math.min(maxC, Math.max(0, c)), Math.min(maxR, Math.max(0, r))];
  }

  /** The cell holding (x, z), or -1 off the grid. */
  cellAt(x: number, z: number): number {
    const col = Math.floor((x - this.#origin[0]) / WALK_CELL);
    const row = Math.floor((z - this.#origin[1]) / WALK_CELL);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return -1;
    return row * this.cols + col;
  }

  /** The centre of a cell, in metres. */
  centre(cell: number): [number, number] {
    const col = cell % this.cols;
    const row = (cell - col) / this.cols;
    return [this.#origin[0] + (col + 0.5) * WALK_CELL, this.#origin[1] + (row + 0.5) * WALK_CELL];
  }

  /** A cell's raw value; cells off the grid are closed. */
  value(cell: number): number {
    if (cell < 0 || cell >= this.cols * this.rows) return CLOSED;
    const col = cell % this.cols;
    const row = (cell - col) / this.cols;
    const t = Math.floor(row / TILE) * this.#tilesX + Math.floor(col / TILE);
    const tile = this.#tiles[t] ?? this.#fill(t);
    return tile[(row % TILE) * TILE + (col % TILE)]!;
  }

  open(cell: number): boolean {
    return this.value(cell) === OPEN;
  }

  /**
   * Whether (x, z) is walkable, with no building within `clearance` metres along either axis.
   * Narrow paths stay walkable: only walls keep a body at a distance, not kerbs or hedges.
   * Given the move (dx, dz) that got there, only the sides it moves toward count, so a body
   * that stands by a wall can still walk along it or away from it.
   */
  walkable(x: number, z: number, clearance = 0, dx = 0, dz = 0): boolean {
    if (!this.open(this.cellAt(x, z))) return false;
    if (clearance <= 0) return true;
    const moving = dx !== 0 || dz !== 0;
    const blocked = (sx: number, sz: number) => this.buildingHeight(x + sx, z + sz) > 0;
    return !(
      ((!moving || dx > 0) && blocked(clearance, 0)) ||
      ((!moving || dx < 0) && blocked(-clearance, 0)) ||
      ((!moving || dz > 0) && blocked(0, clearance)) ||
      ((!moving || dz < 0) && blocked(0, -clearance))
    );
  }

  /** Roof height of the building over (x, z), or 0 where there is none. */
  buildingHeight(x: number, z: number): number {
    const v = this.value(this.cellAt(x, z));
    return v > OPEN ? v - 1 : 0;
  }

  /** The walkable cell centre nearest (x, z) within `radius` metres, or null. */
  nearest(x: number, z: number, radius: number): [number, number] | null {
    if (this.walkable(x, z)) return this.centre(this.cellAt(x, z));
    let best: [number, number] | null = null;
    let bestDistance = radius;
    const steps = Math.ceil(radius / WALK_CELL);
    for (let dz = -steps; dz <= steps; dz++) {
      for (let dx = -steps; dx <= steps; dx++) {
        const cell = this.cellAt(x + dx * WALK_CELL, z + dz * WALK_CELL);
        if (!this.open(cell)) continue;
        const [cx, cz] = this.centre(cell);
        const d = Math.hypot(cx - x, cz - z);
        if (d <= bestDistance) [best, bestDistance] = [[cx, cz], d];
      }
    }
    return best;
  }

  /** Rasterises one tile from everything that touches it. */
  #fill(t: number): Uint8Array {
    const tile = new Uint8Array(TILE * TILE);
    const col0 = (t % this.#tilesX) * TILE;
    const row0 = Math.floor(t / this.#tilesX) * TILE;
    const x0 = this.#origin[0] + col0 * WALK_CELL;
    const z0 = this.#origin[1] + row0 * WALK_CELL;
    const shapes = this.#shapes[t]!;
    // Surfaces are open, then paths, then buildings close what they stand on.
    const surfaces = shapes.filter((s) => s.value === OPEN);
    for (const s of surfaces) this.#fillRing(tile, s, x0, z0);
    for (const ribbon of this.#ribbons[t]!) this.#fillRibbon(tile, ribbon, x0, z0);
    for (const s of shapes) if (s.value !== OPEN) this.#fillRing(tile, s, x0, z0);
    // Paths can spill a little past the map's edge: nothing off the slab is walkable.
    for (let r = 0; r < TILE; r++) {
      const z = z0 + (r + 0.5) * WALK_CELL;
      for (let c = 0; c < TILE; c++) {
        if (tile[r * TILE + c] !== OPEN) continue;
        if (areaIndex(this.#area, x0 + (c + 0.5) * WALK_CELL, z) < 0) tile[r * TILE + c] = CLOSED;
      }
    }
    this.#tiles[t] = tile;
    return tile;
  }

  /** Even-odd scanline fill of the cells whose centres lie inside the ring. */
  #fillRing(tile: Uint8Array, { ring, value }: Shape, x0: number, z0: number): void {
    const n = ring.length / 2;
    if (this.#crossings.length < n) this.#crossings = new Float64Array(n * 2);
    const xs = this.#crossings;
    for (let r = 0; r < TILE; r++) {
      const z = z0 + (r + 0.5) * WALK_CELL;
      let count = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const [xi, zi, xj, zj] = [ring[i * 2]!, ring[i * 2 + 1]!, ring[j * 2]!, ring[j * 2 + 1]!];
        if (zi > z !== zj > z) xs[count++] = xi + ((z - zi) * (xj - xi)) / (zj - zi);
      }
      if (count < 2) continue;
      // Insertion sort: a row crosses a footprint a handful of times.
      for (let k = 1; k < count; k++) {
        const v = xs[k]!;
        let m = k - 1;
        for (; m >= 0 && xs[m]! > v; m--) xs[m + 1] = xs[m]!;
        xs[m + 1] = v;
      }
      for (let k = 0; k + 1 < count; k += 2) {
        const from = Math.max(0, Math.ceil((xs[k]! - x0) / WALK_CELL - 0.5));
        const to = Math.min(TILE - 1, Math.floor((xs[k + 1]! - x0) / WALK_CELL - 0.5));
        tile.fill(value, r * TILE + from, Math.max(r * TILE + from, r * TILE + to + 1));
      }
    }
  }

  /** Opens the cells whose centres lie within half a width of the path's centre line. */
  #fillRibbon(tile: Uint8Array, { line, half }: Ribbon, x0: number, z0: number): void {
    for (let i = 0; i + 3 < line.length; i += 2) {
      const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
      const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - half - x0) / WALK_CELL));
      const c1 = Math.min(TILE - 1, Math.floor((Math.max(ax, bx) + half - x0) / WALK_CELL));
      const r0 = Math.max(0, Math.floor((Math.min(az, bz) - half - z0) / WALK_CELL));
      const r1 = Math.min(TILE - 1, Math.floor((Math.max(az, bz) + half - z0) / WALK_CELL));
      const [dx, dz] = [bx - ax, bz - az];
      const length2 = dx * dx + dz * dz || 1;
      for (let r = r0; r <= r1; r++) {
        const pz = z0 + (r + 0.5) * WALK_CELL;
        for (let c = c0; c <= c1; c++) {
          const px = x0 + (c + 0.5) * WALK_CELL;
          const s = Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / length2));
          if (Math.hypot(px - ax - s * dx, pz - az - s * dz) <= half) tile[r * TILE + c] = OPEN;
        }
      }
    }
  }
}

/** Highest roof the picking ray needs to start above (m). */
const PICK_TOP = 100;
const PICK_STEP = 0.5;

/**
 * Where a click lands, for walking there: follows the view ray from above the rooftops down
 * to the first building it meets or the ground. A click on a building means the street in
 * front of it, on the side the camera sees. Returns the nearest walkable spot within `radius`
 * metres, or null. `origin` is any point on the ray and `dir` points into the scene.
 */
export function pickWalkable(
  grid: WalkGrid,
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  radius: number,
): [number, number] | null {
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = dir;
  if (dy >= 0) return null;
  const flat = Math.hypot(dx, dz);
  // From where the ray is above every roof (or from the eye, for one already below them), in
  // steps of half a metre across the ground.
  const t0 = Math.max(0, (oy - PICK_TOP) / -dy);
  const step = flat > 1e-6 ? PICK_STEP / flat : 1;
  const tGround = oy / -dy;
  let [x, z] = [ox + dx * tGround, oz + dz * tGround];
  for (let t = t0; t < tGround; t += step) {
    const [px, py, pz] = [ox + dx * t, oy + dy * t, oz + dz * t];
    if (grid.buildingHeight(px, pz) < py) continue;
    // Back out toward the camera to the foot of the wall it hit.
    [x, z] = [px, pz];
    const back = flat > 1e-6 ? 400 : 0;
    for (let k = 0; k < back && grid.buildingHeight(x, z) > 0; k++) {
      x -= (dx / flat) * PICK_STEP;
      z -= (dz / flat) * PICK_STEP;
    }
    break;
  }
  return grid.nearest(x, z, radius);
}
