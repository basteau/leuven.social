import { ShapeUtils, Vector2 } from 'three';

import type { Bounds, Carriageway, Path } from '../data/city.ts';
import { areaOutline, pointInRing } from '../data/geometry.ts';
import type { OutlineEdge } from '../data/geometry.ts';
import type { PitchSurface } from '../data/pitches.ts';
import type { Terrain } from '../data/terrain.ts';
import type { LineBuilder, MeshBuilder, V3 } from './mesh-builder.ts';
import { SURFACE, SURFACE_OF, addPaint } from './paint.ts';
import type { Marking } from './paint.ts';
import { GROUND, PITCH, SURFACE_COLOURS, carriagewayColor } from './palette.ts';

/**
 * How far the diorama slab drops below street level, in metres: below the lowest ground, as its
 * underside is flat.
 */
export const SLAB_DEPTH = 12;
const UP = [0, 1, 0] as const;
/**
 * How high each ground layer is drawn over the terrain (m), stacked a few millimetres apart from
 * the most generic land to the most specific (see `addGround`). Squares are the highest.
 */
export const LAYER_Y = {
  railLand: 0.04,
  green: 0.05,
  woods: 0.06,
  track: 0.062,
  pitch: 0.066,
  parking: 0.08,
  water: 0.1,
  bridges: 0.13,
  roads: 0.15,
  /** Over the plain road surface (a track the GRB surveyed as a road), under the carriageways. */
  paths: 0.153,
  carriageways: 0.156,
  /** The kerbstones along the carriageways, over the pavement, just under the fine paint. */
  kerbs: 0.168,
  plazas: 0.2,
} as const;
export type LayerHeights = typeof LAYER_Y;
/** The slab's ink lip sits on top of the highest ground layer (squares). */
const LIP = LAYER_Y.plazas;

/** The ground's polygon layers, which cells cut along their edges. */
export const GROUND_RINGS = [
  'green',
  'woods',
  'parking',
  'railLand',
  'water',
  'bridges',
  'roads',
  'plazas',
] as const;

/** A piece of a pitch, and what it's made of. */
export interface Pitch {
  surface: PitchSurface;
  ring: Float32Array;
}

/**
 * Pitches lie over woods and under car parks: running tracks lowest, so the pitches mapped on
 * their infields (or a stadium's, drawn whole) lie on them. Their lines go on top (paint.ts).
 */
export const PITCH_Y = { track: LAYER_Y.track, pitch: LAYER_Y.pitch } as const;

export interface GroundLayers {
  green: readonly Float32Array[];
  woods: readonly Float32Array[];
  pitches: readonly Pitch[];
  parking: readonly Float32Array[];
  water: readonly Float32Array[];
  bridges: readonly Float32Array[];
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
  const points = contour.map((p) => [p.x, y, p.y] as const);
  mesh.polygon(points, ShapeUtils.triangulateShape(contour, []), color, UP, -surface);
}

function addRings(mesh: MeshBuilder, rings: readonly Float32Array[], y: number, color: number) {
  for (const ring of rings) addRing(mesh, ring, y, color);
}

/**
 * Paths as flat ribbons along their centre lines. Each segment runs on by half a width at both
 * ends, so bends need no join geometry: the overlaps share a colour and a height.
 */
function addPaths(mesh: MeshBuilder, paths: readonly Path[], y: number) {
  for (const { width, surface, line } of paths) {
    const half = width / 2;
    const color = SURFACE_COLOURS[surface];
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

/** Where the slab's flat underside is, under the lowest ground of `terrain` (or level ground). */
export const slabBottom = (terrain: Terrain | null) => (terrain?.lowest ?? 0) - SLAB_DEPTH;

/**
 * An ink lip along the slab's top and bottom edges and down its corners, inside `within`: it
 * frames the diorama as one object, like the buildings on it. The top line sits on the highest
 * ground layer, draped over the terrain if `lines` is. Points where the outline runs straight on
 * get no corner line.
 */
export function addSlabInk(lines: LineBuilder, area: readonly Bounds[], within: Bounds): void {
  const outline = areaOutline(area);
  const terrain = lines.drape;
  const d = slabBottom(terrain);
  const top = (x: number, z: number) => LIP + (terrain?.height(x, z) ?? 0);
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
    lines.drape = null;
    lines.segment([x0, d, z0], [x1, d, z1]);
    lines.drape = terrain;
  }
  lines.drape = null;
  for (const [key, normals] of facing) {
    const [x, z] = key.split(',').map(Number) as [number, number];
    const inside = x >= within.minX && x <= within.maxX && z >= within.minZ && z <= within.maxZ;
    if (normals.size > 1 && inside) lines.segment([x, d, z], [x, top(x, z), z]);
  }
  lines.drape = terrain;
}

/**
 * One side of the slab, under the outline from (x0, z0) to (x1, z1): from the ground, draped if
 * `mesh` is, down to the flat underside.
 */
function addSide(mesh: MeshBuilder, [x0, z0, x1, z1]: readonly number[], hint: V3): void {
  const terrain = mesh.drape;
  const d = slabBottom(terrain);
  const tops = terrain?.cut([x0!, 0, z0!], [x1!, 0, z1!]) ?? [
    [x0!, 0, z0!],
    [x1!, 0, z1!],
  ];
  const points = tops.flatMap(([x, , z]): V3[] => [
    [x!, d, z!],
    [x!, terrain?.height(x!, z!) ?? 0, z!],
  ]);
  const faces = tops.slice(1).flatMap((_, i) => [
    [i * 2, i * 2 + 2, i * 2 + 3],
    [i * 2, i * 2 + 3, i * 2 + 1],
  ]);
  mesh.drape = null;
  mesh.polygon(points, faces, GROUND.earth, hint);
  mesh.drape = terrain;
}

/**
 * The diorama inside `within` (one cell), draped over the terrain if `mesh` is: the earth slab's
 * top and the sides hanging from the area's outline to its flat underside, then water, paths, the road surface and its paint, and squares on top. Layers come
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
  for (const e of areaOutline(area)) {
    const edge = edgeIn(e, within);
    if (edge) addSide(mesh, edge, [e.nx, 0, e.nz]);
  }
  // Layers stack a few millimetres apart, from the most generic land to the most specific, so
  // what is mapped inside something else shows: railway land is the land a railway owns, with
  // its grass verges and copses on it; a wood in a park, a pitch or car park in either.
  addRings(mesh, layers.railLand, LAYER_Y.railLand, GROUND.railway);
  // Lawns and parks speckled with daisies and buttercups, close in (facade-material.ts).
  for (const ring of layers.green)
    addRing(mesh, ring, LAYER_Y.green, GROUND.green, SURFACE.flowers);
  addRings(mesh, layers.woods, LAYER_Y.woods, GROUND.woods);
  for (const { surface, ring } of layers.pitches) {
    addRing(mesh, ring, surface === 'tartan' ? PITCH_Y.track : PITCH_Y.pitch, PITCH[surface]);
  }
  addRings(mesh, layers.parking, LAYER_Y.parking, GROUND.parking);
  addRings(mesh, layers.water, LAYER_Y.water, GROUND.water);
  // Above the water (footbridges), under the road surfaces that already cover their crossings.
  addPaths(mesh, layers.paths, LAYER_Y.paths);
  // Bridge decks: stone slabs over the water, under any road surface that crosses them.
  for (const ring of layers.bridges)
    addRing(mesh, ring, LAYER_Y.bridges, GROUND.bridge, SURFACE.paving);
  // The road surface is pavement, with the carriageways and cycle tracks laid on it.
  for (const ring of layers.roads)
    addRing(mesh, ring, LAYER_Y.roads, GROUND.pavement, SURFACE.paving);
  for (const { kind, surface, ring } of layers.carriageways) {
    addRing(mesh, ring, LAYER_Y.carriageways, carriagewayColor(kind, surface), SURFACE_OF[surface]);
  }
  addPaint(mesh, layers.markings);
  // Squares are paved in setts, like the old streets round them.
  for (const ring of layers.plazas) addRing(mesh, ring, LAYER_Y.plazas, GROUND.plaza, SURFACE.sett);
}

/** How wide a kerbstone is drawn (m): a little over life, so it stays a line when zoomed in. */
export const KERB = 0.28;

/** A point's key to the centimetre, so faces that share an edge are seen to. */
const cm = (x: number, z: number) => `${Math.round(x * 100)},${Math.round(z * 100)}`;

/**
 * The kerbs: a pale stone along every edge of a carriageway, on the pavement's side of it, where
 * the carriageway meets the pavement and not another carriageway (a junction's face, a cycle
 * track's) or the cut of the cell (`within`), so the kerb runs on unbroken from cell to cell
 * and never across the road. Fine detail, drawn after the paint: the viewer leaves it out when
 * a pixel is wider than a kerb.
 */
export function addKerbs(
  mesh: MeshBuilder,
  carriageways: readonly Carriageway[],
  within: Bounds,
  y: number = LAYER_Y.kerbs,
): void {
  const shared = new Map<string, number>();
  for (const { ring } of carriageways) {
    for (let i = 0; i < ring.length; i += 2) {
      const j = (i + 2) % ring.length;
      const [a, b] = [cm(ring[i]!, ring[i + 1]!), cm(ring[j]!, ring[j + 1]!)];
      const key = a < b ? `${a}>${b}` : `${b}>${a}`;
      shared.set(key, (shared.get(key) ?? 0) + 1);
    }
  }
  const onCut = (x: number, z: number) =>
    x <= within.minX + 1e-3 ||
    x >= within.maxX - 1e-3 ||
    z <= within.minZ + 1e-3 ||
    z >= within.maxZ - 1e-3;
  const straight = Math.sin((4 * Math.PI) / 180);
  for (const { ring } of carriageways) {
    // Which side of its edges the carriageway is on: right of the heading in (x east, z south)
    // is (-dz, dx); the kerb goes the other way, onto the pavement.
    let inward = 0;
    for (let i = 0; i < ring.length && !inward; i += 2) {
      const j = (i + 2) % ring.length;
      const [ax, az, bx, bz] = [ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-3) continue;
      const [mx, mz] = [(ax + bx) / 2, (az + bz) / 2];
      const [nx, nz] = [(-(bz - az) / len) * 0.05, ((bx - ax) / len) * 0.05];
      inward = pointInRing(ring, mx + nx, mz + nz)
        ? 1
        : pointInRing(ring, mx - nx, mz - nz)
          ? -1
          : 0;
    }
    if (!inward) continue;
    // A run of edges that carry on nearly straight (the survey's many near-collinear points)
    // is one kerbstone, from the run's start to its end.
    let run: [x0: number, z0: number, x1: number, z1: number, dx: number, dz: number] | null = null;
    const flush = () => {
      if (!run) return;
      const [ax, az, bx, bz, dx, dz] = run;
      const [ox, oz] = [dz * KERB * inward, -dx * KERB * inward];
      mesh.quad(
        [ax, y, az],
        [bx, y, bz],
        [bx + ox, y, bz + oz],
        [ax + ox, y, az + oz],
        GROUND.kerb,
        UP,
      );
      run = null;
    };
    for (let i = 0; i < ring.length; i += 2) {
      const j = (i + 2) % ring.length;
      const [ax, az, bx, bz] = [ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-3) continue;
      const [a, b] = [cm(ax, az), cm(bx, bz)];
      const kerbed =
        (shared.get(a < b ? `${a}>${b}` : `${b}>${a}`) ?? 0) <= 1 &&
        !(onCut(ax, az) && onCut(bx, bz));
      if (!kerbed) {
        flush();
        continue;
      }
      const [dx, dz] = [(bx - ax) / len, (bz - az) / len];
      if (run && Math.abs(run[4] * dz - run[5] * dx) < straight && run[4] * dx + run[5] * dz > 0) {
        [run[2], run[3]] = [bx, bz];
      } else {
        flush();
        run = [ax, az, bx, bz, dx, dz];
      }
    }
    flush();
  }
}
