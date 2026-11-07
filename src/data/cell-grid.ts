/**
 * A raster of square cells over a rectangle, one byte a cell, filled in tiles the first time
 * anything asks about them: the street's walk grid (walkable.ts) and a room's (room-grid.ts)
 * are both one. The grid knows cells, their centres and tiles, and how to fill a ring or a
 * ribbon; what a byte means is its owner's.
 */

import type { Bounds } from './city.ts';

/** Cells a tile is wide and tall. */
export const TILE = 64;

/** Fills a fresh tile whose first cell's corner is at (x0, z0), for tile number `t`. */
export type TileFill = (tile: Uint8Array, x0: number, z0: number, t: number) => void;

export class CellGrid {
  readonly cols: number;
  readonly rows: number;
  /** Cell size (m). */
  readonly size: number;
  readonly origin: readonly [number, number];
  readonly tilesX: number;
  readonly tileCount: number;
  readonly #tiles: (Uint8Array | undefined)[];
  readonly #fill: TileFill;
  #crossings = new Float64Array(64);

  constructor(bounds: Bounds, fill: TileFill, size = 1) {
    this.size = size;
    this.origin = [bounds.minX, bounds.minZ];
    this.cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / size));
    this.rows = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / size));
    this.tilesX = Math.ceil(this.cols / TILE);
    this.tileCount = this.tilesX * Math.ceil(this.rows / TILE);
    this.#tiles = Array.from({ length: this.tileCount });
    this.#fill = fill;
  }

  /** The tile (column and row) holding (x, z), clamped to the grid. */
  tileOf(x: number, z: number): [number, number] {
    const c = Math.floor((x - this.origin[0]) / this.size / TILE);
    const r = Math.floor((z - this.origin[1]) / this.size / TILE);
    const maxR = this.tileCount / this.tilesX - 1;
    return [Math.min(this.tilesX - 1, Math.max(0, c)), Math.min(maxR, Math.max(0, r))];
  }

  /** Calls `visit` with each tile number a box touches. */
  eachTile(box: Bounds, visit: (tile: number) => void): void {
    const [c0, r0] = this.tileOf(box.minX, box.minZ);
    const [c1, r1] = this.tileOf(box.maxX, box.maxZ);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) visit(r * this.tilesX + c);
  }

  /** The cell holding (x, z), or -1 off the grid. */
  cellAt(x: number, z: number): number {
    const col = Math.floor((x - this.origin[0]) / this.size);
    const row = Math.floor((z - this.origin[1]) / this.size);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return -1;
    return row * this.cols + col;
  }

  /** The centre of a cell, in metres. */
  centre(cell: number): [number, number] {
    const col = cell % this.cols;
    const row = (cell - col) / this.cols;
    return [this.origin[0] + (col + 0.5) * this.size, this.origin[1] + (row + 0.5) * this.size];
  }

  /** A cell's byte, its tile filled first if need be; `outside` for cells off the grid. */
  value(cell: number, outside = 0): number {
    if (cell < 0 || cell >= this.cols * this.rows) return outside;
    const col = cell % this.cols;
    const row = (cell - col) / this.cols;
    const t = Math.floor(row / TILE) * this.tilesX + Math.floor(col / TILE);
    const tile = this.#tiles[t] ?? this.#filled(t);
    return tile[(row % TILE) * TILE + (col % TILE)]!;
  }

  /** Forgets the tiles a box touches, so they are filled again the next time they are asked. */
  refill(box: Bounds): void {
    this.eachTile(box, (t) => (this.#tiles[t] = undefined));
  }

  #filled(t: number): Uint8Array {
    const tile = new Uint8Array(TILE * TILE);
    const x0 = this.origin[0] + (t % this.tilesX) * TILE * this.size;
    const z0 = this.origin[1] + Math.floor(t / this.tilesX) * TILE * this.size;
    this.#fill(tile, x0, z0, t);
    this.#tiles[t] = tile;
    return tile;
  }

  /** Even-odd scanline fill of the cells of a tile whose centres lie inside the ring. */
  fillRing(tile: Uint8Array, ring: ArrayLike<number>, value: number, x0: number, z0: number): void {
    const n = ring.length / 2;
    const size = this.size;
    if (this.#crossings.length < n) this.#crossings = new Float64Array(n * 2);
    const xs = this.#crossings;
    for (let r = 0; r < TILE; r++) {
      const z = z0 + (r + 0.5) * size;
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
        const from = Math.max(0, Math.ceil((xs[k]! - x0) / size - 0.5));
        const to = Math.min(TILE - 1, Math.floor((xs[k + 1]! - x0) / size - 0.5));
        tile.fill(value, r * TILE + from, Math.max(r * TILE + from, r * TILE + to + 1));
      }
    }
  }

  /**
   * Sets the cells of a tile whose centres lie within `half` of a line to `value`, where `keep`
   * (given the cell's old value) allows.
   */
  fillRibbon(
    tile: Uint8Array,
    line: ArrayLike<number>,
    half: number,
    value: number,
    x0: number,
    z0: number,
    keep: (old: number) => boolean = () => false,
  ): void {
    const size = this.size;
    for (let i = 0; i + 3 < line.length; i += 2) {
      const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
      const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - half - x0) / size));
      const c1 = Math.min(TILE - 1, Math.floor((Math.max(ax, bx) + half - x0) / size));
      const r0 = Math.max(0, Math.floor((Math.min(az, bz) - half - z0) / size));
      const r1 = Math.min(TILE - 1, Math.floor((Math.max(az, bz) + half - z0) / size));
      const [dx, dz] = [bx - ax, bz - az];
      const length2 = dx * dx + dz * dz || 1;
      for (let r = r0; r <= r1; r++) {
        const pz = z0 + (r + 0.5) * size;
        for (let c = c0; c <= c1; c++) {
          const px = x0 + (c + 0.5) * size;
          const s = Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / length2));
          if (Math.hypot(px - ax - s * dx, pz - az - s * dz) > half) continue;
          if (!keep(tile[r * TILE + c]!)) tile[r * TILE + c] = value;
        }
      }
    }
  }

  /**
   * How closed the ground is at (x, z), from 0 to 1: whether the cells round it are closed (by
   * `isClosed` on their bytes, off the grid always), blended bilinearly between their centres,
   * so the edge runs as a nearly straight line even along a staircase of cells.
   */
  blend(x: number, z: number, isClosed: (value: number) => boolean): number {
    const u = (x - this.origin[0]) / this.size - 0.5;
    const v = (z - this.origin[1]) / this.size - 0.5;
    const [col, row] = [Math.floor(u), Math.floor(v)];
    const [fu, fv] = [u - col, v - row];
    const at = (c: number, r: number) => {
      const inside = c >= 0 && r >= 0 && c < this.cols && r < this.rows;
      return !inside || isClosed(this.value(r * this.cols + c)) ? 1 : 0;
    };
    const top = at(col, row) * (1 - fu) + at(col + 1, row) * fu;
    const bottom = at(col, row + 1) * (1 - fu) + at(col + 1, row + 1) * fu;
    return top * (1 - fv) + bottom * fv;
  }

  /**
   * The centre of the cell nearest (x, z) within `radius` metres that `ok` takes, or null.
   */
  nearest(
    x: number,
    z: number,
    radius: number,
    ok: (cell: number) => boolean,
  ): [number, number] | null {
    if (ok(this.cellAt(x, z))) return this.centre(this.cellAt(x, z));
    let best: [number, number] | null = null;
    let bestDistance = radius;
    const steps = Math.ceil(radius / this.size);
    for (let dz = -steps; dz <= steps; dz++) {
      for (let dx = -steps; dx <= steps; dx++) {
        const cell = this.cellAt(x + dx * this.size, z + dz * this.size);
        if (cell < 0 || !ok(cell)) continue;
        const [cx, cz] = this.centre(cell);
        const d = Math.hypot(cx - x, cz - z);
        if (d <= bestDistance) [best, bestDistance] = [[cx, cz], d];
      }
    }
    return best;
  }
}

/** Whether (x, z) is inside a ring, by even-odd crossings. */
export function inRing(ring: ArrayLike<number>, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, n = ring.length / 2, j = n - 1; i < n; j = i++) {
    const [xi, zi, xj, zj] = [ring[i * 2]!, ring[i * 2 + 1]!, ring[j * 2]!, ring[j * 2 + 1]!];
    if (zi > z !== zj > z && x < xi + ((z - zi) * (xj - xi)) / (zj - zi)) inside = !inside;
  }
  return inside;
}

/** How far (x, z) is from a ring's outline (m), inside or out. */
export function ringDistance(ring: ArrayLike<number>, x: number, z: number): number {
  let nearest = Infinity;
  for (let i = 0, n = ring.length / 2, j = n - 1; i < n; j = i++) {
    const [ax, az] = [ring[j * 2]!, ring[j * 2 + 1]!];
    const [dx, dz] = [ring[i * 2]! - ax, ring[i * 2 + 1]! - az];
    const s = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    nearest = Math.min(nearest, Math.hypot(x - ax - s * dx, z - az - s * dz));
  }
  return nearest;
}

/** The box round a ring or line, grown by `pad`. */
export function ringBox(ring: ArrayLike<number>, pad = 0): Bounds {
  let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < ring.length; i += 2) {
    [minX, maxX] = [Math.min(minX, ring[i]!), Math.max(maxX, ring[i]!)];
    [minZ, maxZ] = [Math.min(minZ, ring[i + 1]!), Math.max(maxZ, ring[i + 1]!)];
  }
  return { minX: minX - pad, minZ: minZ - pad, maxX: maxX + pad, maxZ: maxZ + pad };
}

/** A wall as drawn, for bodies to keep clear of: a closed ring's outline, or a line. */
export interface Wall {
  line: ArrayLike<number>;
  /** Whether `line` is a closed ring (a footprint) rather than an open line. */
  ring: boolean;
  /** Half its thickness: none for a footprint's face. */
  half: number;
  box: Bounds;
  /** The last query that met it, so one in two tiles counts once. */
  seen: number;
}

/**
 * How far a circle of `radius` at (x, z) reaches into `walls` (m), 0 where it's clear, with the
 * way out summed into `out[0..1]` scaled by depth (the caller normalises), and the deepest reach
 * returned. A centre inside a ring is pushed out through its nearest face. `query` marks walls
 * met already.
 */
export function wallPush(
  walls: readonly Wall[],
  x: number,
  z: number,
  radius: number,
  query: number,
  sum: [number, number, number],
): void {
  for (const wall of walls) {
    const { line, half, box } = wall;
    if (wall.seen === query || x + radius < box.minX || x - radius > box.maxX) continue;
    if (z + radius < box.minZ || z - radius > box.maxZ) continue;
    wall.seen = query;
    const inside = wall.ring && inRing(line, x, z);
    const n = line.length / 2;
    let [nearest, nx, nz] = [Infinity, 0, 0];
    for (let i = wall.ring ? 0 : 1, j = wall.ring ? n - 1 : 0; i < n; j = i++) {
      const [ax, az] = [line[j * 2]!, line[j * 2 + 1]!];
      const [dx, dz] = [line[i * 2]! - ax, line[i * 2 + 1]! - az];
      const s = Math.min(
        1,
        Math.max(0, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)),
      );
      const [px, pz] = [x - ax - s * dx, z - az - s * dz];
      const d = Math.hypot(px, pz);
      if (d < 1e-9) continue;
      if (inside) {
        if (d < nearest) [nearest, nx, nz] = [d, -px / d, -pz / d];
        continue;
      }
      const into = radius + half - d;
      if (into <= 0) continue;
      sum[0] += (px / d) * into;
      sum[1] += (pz / d) * into;
      sum[2] = Math.max(sum[2], into);
    }
    if (inside && nearest < Infinity) {
      const into = radius + nearest;
      sum[0] += nx * into;
      sum[1] += nz * into;
      sum[2] = Math.max(sum[2], into);
    }
  }
}
