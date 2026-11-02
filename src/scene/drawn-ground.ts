import type { Terrain } from '../data/terrain.ts';
import type { Cell } from './cells.ts';
import type { LayerHeights } from './ground.ts';

/**
 * The ground as a cell draws it: the terrain, plus the highest ground layer lying there (a
 * square's setts, a pavement, a path, a lawn; `LAYER_Y` in ground.ts). What stands on the street
 * stands on this, not on the bare terrain under it: a pavement is drawn 0.15 m over the terrain
 * and a square 0.2 m, which would hide the bottom third of a parked bike's wheels.
 */
export interface DrawnGround {
  /** The drawn ground's height at (x, z). */
  height(x: number, z: number): number;
  /**
   * How high the top layer at (x, z) is drawn over the terrain, or 0 on bare ground. A cell's
   * layers are cut at its edges, so a point just past them is looked up just inside.
   */
  layer(x: number, z: number): number;
}

/** A layer's piece: its height, then its ring (flat [x, z, …]) and the ring's bounding box. */
type Piece = [y: number, ring: ArrayLike<number>, box: number[]];

/**
 * A cell's drawn ground, in the furniture chunk, which takes the layer heights from the engine in
 * its kit. Its pieces are gathered the first time it's asked, highest layer first.
 */
export function drawnGround(terrain: Terrain, cell: Cell, heights: LayerHeights): DrawnGround {
  let pieces: Piece[] | undefined;
  const { minX, minZ, maxX, maxZ } = cell.bounds;
  const layer = (x: number, z: number) => {
    x = Math.min(maxX - 1e-3, Math.max(minX + 1e-3, x));
    z = Math.min(maxZ - 1e-3, Math.max(minZ + 1e-3, z));
    pieces ??= gather(cell, heights);
    for (const [y, ring, [x0, z0, x1, z1]] of pieces) {
      if (x >= x0! && x <= x1! && z >= z0! && z <= z1! && inRing(ring, x, z)) return y;
    }
    return 0;
  };
  return { layer, height: (x, z) => terrain.height(x, z) + layer(x, z) };
}

function gather({ ground }: Cell, h: LayerHeights): Piece[] {
  const pieces: Piece[] = [];
  const add = (y: number, ring: ArrayLike<number>) => {
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 1 < ring.length; i += 2) {
      box[0] = Math.min(box[0]!, ring[i]!);
      box[1] = Math.min(box[1]!, ring[i + 1]!);
      box[2] = Math.max(box[2]!, ring[i]!);
      box[3] = Math.max(box[3]!, ring[i + 1]!);
    }
    pieces.push([y, ring, box]);
  };
  for (const ring of ground.railLand) add(h.railLand, ring);
  for (const ring of ground.green) add(h.green, ring);
  for (const ring of ground.woods) add(h.woods, ring);
  for (const { surface, ring } of ground.pitches)
    add(surface === 'tartan' ? h.track : h.pitch, ring);
  for (const ring of ground.parking) add(h.parking, ring);
  for (const ring of ground.water) add(h.water, ring);
  // A path is drawn as a ribbon a segment at a time, each running on by half its width.
  for (const { width, line } of ground.paths) {
    for (let i = 0; i + 3 < line.length; i += 2) {
      const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
      const k = width / 2 / (Math.hypot(bx - ax, bz - az) || Infinity);
      const [ux, uz] = [(bx - ax) * k, (bz - az) * k];
      add(h.paths, [
        ax - ux + uz,
        az - uz - ux,
        bx + ux + uz,
        bz + uz - ux,
        bx + ux - uz,
        bz + uz + ux,
        ax - ux - uz,
        az - uz + ux,
      ]);
    }
  }
  for (const ring of ground.bridges) add(h.bridges, ring);
  for (const ring of ground.roads) add(h.roads, ring);
  for (const { ring } of ground.carriageways) add(h.carriageways, ring);
  for (const ring of ground.plazas) add(h.plazas, ring);
  return pieces.toSorted((a, b) => b[0] - a[0]);
}

/** Whether (x, z) is inside a ring (flat [x, z, …]), by the even-odd rule. */
function inRing(ring: ArrayLike<number>, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i + 1 < ring.length; j = i, i += 2) {
    const [xi, zi, xj, zj] = [ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
