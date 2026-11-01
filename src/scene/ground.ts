import { ShapeUtils, Vector2 } from 'three';

import type { Bounds, Carriageway, Path } from '../data/city.ts';
import { areaOutline } from '../data/geometry.ts';
import type { OutlineEdge } from '../data/geometry.ts';
import type { LineBuilder, MeshBuilder } from './mesh-builder.ts';
import { SURFACE, SURFACE_OF, addPaint } from './paint.ts';
import type { Marking } from './paint.ts';
import { CARRIAGEWAYS, GROUND } from './palette.ts';

/** How far the diorama slab drops below street level, in metres. */
export const SLAB_DEPTH = 12;
const UP = [0, 1, 0] as const;
/** The slab's ink lip sits on top of the highest ground layer (squares, 0.2 m). */
const LIP = 0.2;

/** The ground's polygon layers, which cells cut along their edges. */
export const GROUND_RINGS = [
  'green',
  'woods',
  'pitches',
  'parking',
  'railLand',
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
  carriageways: readonly Carriageway[];
  markings: readonly Marking[];
  plazas: readonly Float32Array[];
  railLand: readonly Float32Array[];
  paths: readonly Path[];
}

/** A flat polygon; `surface` names its texture for the ground shader (paint.ts). */
function addRing(mesh: MeshBuilder, ring: Float32Array, y: number, color: number, surface = 0) {
  const contour = Array.from(
    { length: ring.length / 2 },
    (_, i) => new Vector2(ring[i * 2]!, ring[i * 2 + 1]!),
  );
  for (const [i, j, k] of ShapeUtils.triangulateShape(contour, [])) {
    const p = (idx: number) => [contour[idx]!.x, y, contour[idx]!.y] as const;
    mesh.triangle(p(i!), p(j!), p(k!), color, UP, -surface);
  }
}

function addRings(mesh: MeshBuilder, rings: readonly Float32Array[], y: number, color: number) {
  for (const ring of rings) addRing(mesh, ring, y, color);
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

/** The part of an outline edge that runs through the cell, or nothing. */
function edgeIn(e: OutlineEdge, within: Bounds): [number, number, number, number] | undefined {
  const [x0, x1] = [Math.max(e.x0, within.minX), Math.min(e.x1, within.maxX)];
  const [z0, z1] = [Math.max(e.z0, within.minZ), Math.min(e.z1, within.maxZ)];
  if (x0 > x1 || z0 > z1 || (x0 === x1 && z0 === z1)) return undefined;
  return [x0, z0, x1, z1];
}

/**
 * An ink lip along the slab's top and bottom edges and down its corners, inside `within`: it
 * frames the diorama as one object, like the buildings on it. The top line sits on the highest
 * ground layer. Points where the outline runs straight on get no corner line.
 */
export function addSlabInk(lines: LineBuilder, area: readonly Bounds[], within: Bounds): void {
  const outline = areaOutline(area);
  const d = -SLAB_DEPTH;
  // The outline's corners: points where edges facing different ways meet.
  const facing = new Map<string, Set<string>>();
  for (const e of outline) {
    for (const key of [`${e.x0},${e.z0}`, `${e.x1},${e.z1}`]) {
      facing.set(key, (facing.get(key) ?? new Set()).add(`${e.nx},${e.nz}`));
    }
    const edge = edgeIn(e, within);
    if (!edge) continue;
    const [x0, z0, x1, z1] = edge;
    lines.segment([x0, LIP, z0], [x1, LIP, z1]);
    lines.segment([x0, d, z0], [x1, d, z1]);
  }
  for (const [key, normals] of facing) {
    const [x, z] = key.split(',').map(Number) as [number, number];
    const inside = x >= within.minX && x <= within.maxX && z >= within.minZ && z <= within.maxZ;
    if (normals.size > 1 && inside) lines.segment([x, d, z], [x, LIP, z]);
  }
}

/**
 * The diorama inside `within` (one cell): the earth slab's top and the sides hanging from the
 * area's outline, then water, paths, the road surface and its paint, and squares on top. Layers come
 * already clipped to the cell.
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
    const edge = edgeIn(e, within);
    if (!edge) continue;
    const [x0, z0, x1, z1] = edge;
    const hint = [e.nx, 0, e.nz] as const;
    mesh.quad([x0, d, z0], [x1, d, z1], [x1, 0, z1], [x0, 0, z0], GROUND.earth, hint);
  }
  // Layers stack a few centimetres apart; the orthographic depth buffer resolves that cleanly.
  addRings(mesh, layers.green, 0.05, GROUND.green);
  // Woods, pitches, railway land and car parks lie in or beside parks and streets, each a few
  // millimetres above the last.
  addRings(mesh, layers.woods, 0.06, GROUND.woods);
  addRings(mesh, layers.pitches, 0.065, GROUND.pitch);
  addRings(mesh, layers.railLand, 0.07, GROUND.railway);
  addRings(mesh, layers.parking, 0.08, GROUND.parking);
  addRings(mesh, layers.water, 0.1, GROUND.water);
  // Above the water (footbridges), under the road surfaces that already cover their crossings.
  addPaths(mesh, layers.paths, 0.12);
  // The road surface is pavement, with the carriageways and cycle tracks laid on it.
  for (const ring of layers.roads) addRing(mesh, ring, 0.15, GROUND.pavement, SURFACE.paving);
  for (const { kind, ring } of layers.carriageways) {
    addRing(mesh, ring, 0.155, CARRIAGEWAYS[kind], SURFACE_OF[kind]);
  }
  addPaint(mesh, layers.markings);
  addRings(mesh, layers.plazas, 0.2, GROUND.plaza);
}
