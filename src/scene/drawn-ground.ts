import type { Path } from '../data/city.ts';
import type { Terrain } from '../data/terrain.ts';
import type { Cell } from './cells.ts';
import type { LayerHeights } from './ground.ts';

/**
 * The ground as a cell draws it: the terrain, plus the highest ground layer lying there (a
 * square's setts, a pavement, a path, a lawn; `LAYER_Y` in ground.ts). What stands on the street
 * stands on this, not on the bare terrain under it: a pavement is drawn 0.15 m over the terrain
 * and a square 0.2 m, which would hide the bottom third of a parked bike's wheels.
 *
 * Lives in the furniture chunk, which takes the layer heights from the engine in its kit.
 */
export class DrawnGround {
  readonly #terrain: Terrain;
  readonly #cell: Cell;
  readonly #heights: LayerHeights;
  /** Each layer's pieces, highest layer first: its height, bounding box and shape. */
  #pieces: Piece[] | undefined;

  constructor(terrain: Terrain, cell: Cell, heights: LayerHeights) {
    [this.#terrain, this.#cell, this.#heights] = [terrain, cell, heights];
  }

  /** The drawn ground's height at (x, z). */
  height(x: number, z: number): number {
    return this.#terrain.height(x, z) + this.layer(x, z);
  }

  /**
   * How high the top layer at (x, z) is drawn over the terrain, or 0 on bare ground. A cell's
   * layers are cut at its edges, so a point just past them is looked up just inside.
   */
  layer(x: number, z: number): number {
    const { minX, minZ, maxX, maxZ } = this.#cell.bounds;
    const [px, pz] = [
      Math.min(maxX - 1e-3, Math.max(minX + 1e-3, x)),
      Math.min(maxZ - 1e-3, Math.max(minZ + 1e-3, z)),
    ];
    if (!this.#pieces) this.#pieces = this.#index();
    for (const p of this.#pieces) {
      if (px < p.minX || px > p.maxX || pz < p.minZ || pz > p.maxZ) continue;
      if (p.path ? onPath(p.path, px, pz) : inRing(p.ring!, px, pz)) return p.y;
    }
    return 0;
  }

  #index(): Piece[] {
    const { ground } = this.#cell;
    const h = this.#heights;
    const pieces: Piece[] = [];
    const rings = (list: readonly ArrayLike<number>[], y: number) => {
      for (const ring of list) pieces.push({ y, ring, ...bounds(ring, 0) });
    };
    rings(ground.railLand, h.railLand);
    rings(ground.green, h.green);
    rings(ground.woods, h.woods);
    for (const { surface, ring } of ground.pitches)
      pieces.push({ y: surface === 'tartan' ? h.track : h.pitch, ring, ...bounds(ring, 0) });
    rings(ground.parking, h.parking);
    rings(ground.water, h.water);
    for (const path of ground.paths)
      pieces.push({ y: h.paths, path, ...bounds(path.line, path.width / 2) });
    rings(ground.bridges, h.bridges);
    rings(ground.roads, h.roads);
    rings(
      ground.carriageways.map((c) => c.ring),
      h.carriageways,
    );
    rings(ground.plazas, h.plazas);
    return pieces.toSorted((a, b) => b.y - a.y);
  }
}

interface Piece {
  y: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  ring?: ArrayLike<number>;
  path?: Path;
}

/** The bounding box of flat [x, z, …] points, grown by `by`. */
function bounds(points: ArrayLike<number>, by: number) {
  let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 1 < points.length; i += 2) {
    [minX, maxX] = [Math.min(minX, points[i]!), Math.max(maxX, points[i]!)];
    [minZ, maxZ] = [Math.min(minZ, points[i + 1]!), Math.max(maxZ, points[i + 1]!)];
  }
  return { minX: minX - by, minZ: minZ - by, maxX: maxX + by, maxZ: maxZ + by };
}

/** Whether (x, z) is inside a ring (flat [x, z, …]), by the even-odd rule. */
export function inRing(ring: ArrayLike<number>, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i + 1 < ring.length; j = i, i += 2) {
    const [xi, zi, xj, zj] = [ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Whether (x, z) is on a path's ribbon as ground.ts draws it: each segment its width across and
 * running on by half of it at both ends.
 */
function onPath({ width, line }: Path, x: number, z: number): boolean {
  const half = width / 2;
  for (let i = 0; i + 3 < line.length; i += 2) {
    const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
    const length = Math.hypot(bx - ax, bz - az);
    if (length < 1e-6) continue;
    const along = ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / length;
    const across = ((x - ax) * (bz - az) - (z - az) * (bx - ax)) / length;
    if (along >= -half && along <= length + half && Math.abs(across) <= half) return true;
  }
  return false;
}
