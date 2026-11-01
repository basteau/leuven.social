import { ShapeUtils, Vector2 } from 'three';

import type { Bounds, Path } from '../data/city.ts';
import { areaOutline } from '../data/geometry.ts';
import type { MeshBuilder } from './mesh-builder.ts';
import { GROUND } from './palette.ts';

/** How far the diorama slab drops below street level, in metres. */
export const SLAB_DEPTH = 12;
const UP = [0, 1, 0] as const;

/** The ground's polygon layers, which cells cut along their edges. */
export const GROUND_RINGS = [
  'green',
  'woods',
  'pitches',
  'parking',
  'water',
  'roads',
  'plazas',
] as const;

export interface GroundLayers {
  green: readonly Float32Array[];
  woods: readonly Float32Array[];
  pitches: readonly Float32Array[];
  parking: readonly Float32Array[];
  water: readonly Float32Array[];
  roads: readonly Float32Array[];
  plazas: readonly Float32Array[];
  paths: readonly Path[];
}

function addRings(mesh: MeshBuilder, rings: readonly Float32Array[], y: number, color: number) {
  for (const ring of rings) {
    const contour = Array.from(
      { length: ring.length / 2 },
      (_, i) => new Vector2(ring[i * 2]!, ring[i * 2 + 1]!),
    );
    for (const [i, j, k] of ShapeUtils.triangulateShape(contour, [])) {
      const p = (idx: number) => [contour[idx]!.x, y, contour[idx]!.y] as const;
      mesh.triangle(p(i!), p(j!), p(k!), color, UP);
    }
  }
}

/**
 * Paths as flat ribbons along their centre lines. Each segment runs on by half a width at both
 * ends, so bends need no join geometry: the overlaps share a colour and a height.
 */
function addPaths(mesh: MeshBuilder, paths: readonly Path[], y: number) {
  for (const { width, paved, line } of paths) {
    const half = width / 2;
    const color = paved ? GROUND.path : GROUND.trail;
    for (let i = 0; i + 3 < line.length; i += 2) {
      const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-6) continue;
      const [ux, uz] = [((bx - ax) / len) * half, ((bz - az) / len) * half];
      mesh.quad(
        [ax - ux + uz, y, az - uz - ux],
        [bx + ux + uz, y, bz + uz - ux],
        [bx + ux - uz, y, bz + uz + ux],
        [ax - ux - uz, y, az - uz + ux],
        color,
        UP,
      );
    }
  }
}

/**
 * The diorama inside `within` (one cell): the earth slab's top and the sides hanging from the
 * area's outline, then water, paths, roads and squares on top. Layers come already clipped to the cell.
 */
export function addGround(
  mesh: MeshBuilder,
  area: readonly Bounds[],
  within: Bounds,
  layers: GroundLayers,
): void {
  for (const b of area) {
    const [x0, z0] = [Math.max(b.minX, within.minX), Math.max(b.minZ, within.minZ)];
    const [x1, z1] = [Math.min(b.maxX, within.maxX), Math.min(b.maxZ, within.maxZ)];
    if (x0 < x1 && z0 < z1)
      mesh.quad([x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1], GROUND.base, UP);
  }
  const d = -SLAB_DEPTH;
  for (const e of areaOutline(area)) {
    // The part of this outline edge that runs through the cell.
    const [x0, x1] = [Math.max(e.x0, within.minX), Math.min(e.x1, within.maxX)];
    const [z0, z1] = [Math.max(e.z0, within.minZ), Math.min(e.z1, within.maxZ)];
    if (x0 > x1 || z0 > z1 || (x0 === x1 && z0 === z1)) continue;
    const hint = [e.nx, 0, e.nz] as const;
    mesh.quad([x0, d, z0], [x1, d, z1], [x1, 0, z1], [x0, 0, z0], GROUND.earth, hint);
  }
  // Layers stack a few centimetres apart; the orthographic depth buffer resolves that cleanly.
  addRings(mesh, layers.green, 0.05, GROUND.green);
  // Woods, pitches and car parks lie in or beside parks, each a centimetre above the last.
  addRings(mesh, layers.woods, 0.06, GROUND.woods);
  addRings(mesh, layers.pitches, 0.07, GROUND.pitch);
  addRings(mesh, layers.parking, 0.08, GROUND.parking);
  addRings(mesh, layers.water, 0.1, GROUND.water);
  // Above the water (footbridges), under the road surfaces that already cover their crossings.
  addPaths(mesh, layers.paths, 0.12);
  addRings(mesh, layers.roads, 0.15, GROUND.road);
  addRings(mesh, layers.plazas, 0.2, GROUND.plaza);
}
