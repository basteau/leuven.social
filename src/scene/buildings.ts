import { ShapeUtils, Vector2 } from 'three';
import type { BufferGeometry } from 'three';

import type { Building, Tier } from '../data/city.ts';
import { orientedRect, signedArea, simplifyRing } from '../data/geometry.ts';
import type { OrientedRect } from '../data/geometry.ts';
import { straightSkeleton } from '../data/skeleton.ts';
import type { Skeleton } from '../data/skeleton.ts';
import { LANDMARK_MODELS } from './landmark-models.ts';
import { LANCETS, addLandmark, addTower } from './landmarks.ts';
import type { Terrain } from '../data/terrain.ts';
import { LIFT_UNIT, LineBuilder, MeshBuilder } from './mesh-builder.ts';
import type { V3 } from './mesh-builder.ts';
import { addParasol } from './terraces.ts';
import type { Parasol } from './terraces.ts';
import { LANDMARK, pick, roofColor, wallColor } from './palette.ts';

export type RoofPlan =
  | { type: 'flat'; eave: number }
  | {
      type: 'gable';
      eave: number;
      ridge: number;
      /** The ridge runs along `rect`'s u axis, from -halfLength to halfLength, at v = 0. */
      rect: OrientedRect;
      stepped: boolean;
    }
  | {
      type: 'hip';
      eave: number;
      ridge: number;
      /** Rise per metre inward: the slope of every face. */
      pitch: number;
      /** The simplified footprint the skeleton was built on; the walls follow it too. */
      ring: number[];
      holes: number[][];
      skeleton: Skeleton;
    };

const PITCHED_KINDS = new Set(['house', 'apartments', 'retail', 'other']);
/**
 * Added to a wall's `facade` value (its top height, at most 90 m) when its ground floor is a
 * shop front: shops, cafés, offices and hotels (`retail`). The facade shader reads it back.
 */
export const SHOP_FRONT = 200;
/**
 * Share of gables that are stepped (trapgevels), the most Flemish silhouette there is. Hero
 * squares like Oude Markt get the most, ordinary streets some, the fringe none.
 */
const STEPPED: Record<Tier, readonly boolean[]> = {
  hero: [true, true, false],
  core: [true, false, false, false, false],
  fringe: [false],
};

/**
 * A gable covers the footprint's bounding rectangle, so it needs a footprint that nearly fills
 * it, or the roof would hang over thin air. Anything less rectangular gets a hipped roof.
 */
const GABLE_FILL = 0.85;
/** Half the widest span (m) a gable covers; wider rectangles get a hipped roof. */
const MAX_GABLE_SPAN = 9;
/** Footprint detail finer than this (m) is survey noise to a roof, and below a game pixel. */
const ROOF_TOLERANCE = 0.25;
/** Below this footprint area (m²) a pitched roof is too small to read: bins, kiosks. */
const MIN_PITCHED_AREA = 12;

/**
 * Decides the roof from the footprint, the tags and the LiDAR survey. Heights include the roof,
 * so a pitched roof takes its rise out of the wall height: the surveyed rise (ridge minus eave)
 * where there is one, else a ~42° guess, capped so a steep roof never eats the whole building.
 * Near-rectangles get gables, their ridge along the long side unless the LiDAR saw it run across
 * (roof 'across': a terraced house's ridge parallel to the street); every other shape a hipped
 * roof from its straight skeleton, which follows L, T and U wings and courtyards.
 */
export function planRoof(b: Building): RoofPlan {
  const flat = { type: 'flat', eave: b.height } as const;
  if (b.roof === 'flat') return flat;
  const explicit = b.roof !== 'auto';
  if (!explicit && (!PITCHED_KINDS.has(b.kind) || b.height > 24)) return flat;
  if (signedArea(b.ring) < MIN_PITCHED_AREA) return flat;
  const surveyed = b.height - b.eave >= 1.5 ? b.height - b.eave : 0;
  const long = orientedRect(b.ring);
  // Turned, the ridge runs along v: the same rectangle with its axes swapped. A span too wide to
  // turn keeps the ridge along.
  const turned: OrientedRect = {
    ...long,
    ux: -long.uz,
    uz: long.ux,
    halfLength: long.halfWidth,
    halfWidth: long.halfLength,
  };
  const across = b.roof === 'across' && turned.halfWidth <= MAX_GABLE_SPAN;
  const rect = across ? turned : long;
  const gable =
    b.roof !== 'hipped' &&
    b.holes.length === 0 &&
    rect.fill >= GABLE_FILL &&
    rect.halfWidth >= 1.5 &&
    rect.halfWidth <= MAX_GABLE_SPAN;
  if (gable) {
    const guess = Math.max(rect.halfWidth * 0.9, 1.5);
    const rise = Math.min(surveyed || guess, surveyed ? rect.halfWidth * 1.5 : 6, b.height * 0.5);
    // Steps need room: on a narrow or flat gable they'd be smaller than a game pixel. A turned
    // ridge puts its gables on the party walls, where nobody sees steps: they stand on the
    // street end of a ridge that runs back from it.
    const stepped =
      !across && rect.halfWidth >= 2.5 && rise >= 2.5 && pick(STEPPED[b.tier], b.id * 13);
    return { type: 'gable', eave: b.height - rise, ridge: b.height, rect, stepped };
  }
  const ring = simplifyRing(b.ring, ROOF_TOLERANCE);
  const holes = b.holes.map((h) => simplifyRing(h, ROOF_TOLERANCE)).filter((h) => h.length >= 6);
  const skeleton = straightSkeleton(ring, holes);
  if (!skeleton || skeleton.height < 0.75) return flat;
  const guess = Math.max(skeleton.height * 0.9, 1.5);
  const rise = Math.min(
    surveyed || guess,
    skeleton.height * 1.5,
    surveyed ? 10 : 6,
    b.height * 0.5,
  );
  // A wide block keeps the slope of a roof you could build; it flattens off on top instead.
  const pitch = Math.max(rise / skeleton.height, 0.6);
  return { type: 'hip', eave: b.height - rise, ridge: b.height, pitch, ring, holes, skeleton };
}

/**
 * Cuts a face polygon (flat [x, z, t, …]) at t = cap. Returns the part below, the part above,
 * and the cut line(s) between them as [x0, z0, x1, z1] for outlining.
 */
export function cutAt(
  points: readonly number[],
  cap: number,
): { below: number[]; above: number[]; cuts: number[][] } {
  const below: number[] = [];
  const above: number[] = [];
  const crossings: number[] = [];
  const n = points.length / 3;
  for (let i = 0; i < n; i++) {
    const [ax, az, at] = [points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!];
    const j = (i + 1) % n;
    const [bx, bz, bt] = [points[j * 3]!, points[j * 3 + 1]!, points[j * 3 + 2]!];
    if (at <= cap) below.push(ax, az, at);
    if (at >= cap) above.push(ax, az, at);
    if ((at < cap && bt > cap) || (at > cap && bt < cap)) {
      const k = (cap - at) / (bt - at);
      const x = ax + (bx - ax) * k;
      const z = az + (bz - az) * k;
      below.push(x, z, cap);
      above.push(x, z, cap);
      crossings.push(x, z);
    }
  }
  const cuts: number[][] = [];
  for (let i = 0; i + 3 < crossings.length; i += 4) cuts.push(crossings.slice(i, i + 4));
  return { below: below.length >= 9 ? below : [], above: above.length >= 9 ? above : [], cuts };
}

/** Triangulates a flat [x, z, t, …] polygon in plan and lifts each corner with `y`. */
function addPolygon(
  mesh: MeshBuilder,
  points: readonly number[],
  y: (t: number) => number,
  color: number,
  hint: V3,
): void {
  const contour = Array.from(
    { length: points.length / 3 },
    (_, i) => new Vector2(points[i * 3]!, points[i * 3 + 1]!),
  );
  const p = (i: number): V3 => [points[i * 3]!, y(points[i * 3 + 2]!), points[i * 3 + 1]!];
  const corners = contour.map((_, i) => p(i));
  mesh.polygon(corners, ShapeUtils.triangulateShape(contour, []), color, hint);
}

/** A hipped roof over the straight skeleton, flattened off where it reaches its surveyed rise. */
function hipRoof(
  mesh: MeshBuilder,
  lines: Ink,
  plan: Extract<RoofPlan, { type: 'hip' }>,
  b: Building,
): void {
  const { eave, ridge, pitch, skeleton } = plan;
  const cap = (ridge - eave) / pitch;
  const y = (t: number) => eave + Math.min(t, cap) * pitch;
  const slopeColor = roofColor(b.roofColor, false, b.id);
  const topColor = roofColor(b.roofColor, true, b.id);
  for (const face of skeleton.faces) {
    const [ax, az, , bx, bz] = face.points;
    const len = Math.hypot(bx! - ax!, bz! - az!) || 1;
    // Up and out over its own wall: the outward normal of a counter-clockwise edge is (dz, -dx).
    const hint: V3 = [(bz! - az!) / len, 1, -(bx! - ax!) / len];
    const { below, above, cuts } = cutAt(face.points, cap);
    if (below.length) addPolygon(mesh, below, y, slopeColor, hint);
    if (above.length) addPolygon(mesh, above, y, topColor, [0, 1, 0]);
    for (const [x0, z0, x1, z1] of cuts) lines.segment([x0!, ridge, z0!], [x1!, ridge, z1!]);
  }
  for (const [x0, z0, t0, x1, z1, t1] of skeleton.arcs) {
    if (Math.min(t0, t1) >= cap) continue;
    const k = Math.max(t0, t1) > cap ? (cap - t0) / (t1 - t0) : 1;
    const end: V3 = [x0 + (x1 - x0) * k, y(t0 + (t1 - t0) * k), z0 + (z1 - z0) * k];
    lines.segment([x0, y(t0), z0], end);
  }
}

type At = (u: number, v: number, y: number) => V3;

/**
 * A stepped gable at u = `end`: a thin wall whose steps climb above the roof slopes, so it
 * reads from the street side and from behind. Replaces the plain gable triangle. Only its two
 * faces: treads and risers are a third of a metre, less than a game pixel.
 */
function steppedGable(
  mesh: MeshBuilder,
  lines: Ink,
  at: At,
  end: number,
  out: V3,
  plan: { eave: number; ridge: number; rect: OrientedRect },
  wall: number,
): void {
  const { eave, ridge } = plan;
  const W = plan.rect.halfWidth;
  const steps = Math.min(4, Math.max(2, Math.round(W / 1.3)));
  const rise = (ridge - eave) / steps;
  const back = end - Math.sign(end) * 0.35;
  const inward: V3 = [-out[0], 0, -out[2]];
  for (const side of [1, -1]) {
    let below = eave;
    for (let i = 0; i < steps; i++) {
      const q0 = side * W * (1 - i / steps);
      const q1 = side * W * (1 - (i + 1) / steps);
      // Each step stands a little proud of the roof line at its inner edge.
      const top = eave + rise * (i + 1.35);
      mesh.quad(
        at(end, q0, eave),
        at(end, q1, eave),
        at(end, q1, top),
        at(end, q0, top),
        wall,
        out,
      );
      mesh.quad(
        at(back, q0, eave),
        at(back, q1, eave),
        at(back, q1, top),
        at(back, q0, top),
        wall,
        inward,
      );
      lines.segment(at(end, q0, below), at(end, q0, top));
      lines.segment(at(end, q0, top), at(end, q1, top));
      below = top;
    }
  }
}

/**
 * Where outlines go. Ink is for the shapes people read: a segment shorter than `MIN_INK` is a
 * footprint jog or survey noise, a few pixels of dark speckle at most, so it is left out.
 */
type Ink = Pick<LineBuilder, 'segment'>;
const MIN_INK = 0.75;
/** Sheds and kiosks smaller than this (m²) get no ink at all: it would draw a black blot. */
const MIN_INKED_AREA = 20;
const NO_INK: Ink = { segment() {} };

function inkOf(lines: LineBuilder): Ink {
  return {
    segment(a, b) {
      if (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) >= MIN_INK) lines.segment(a, b);
    },
  };
}

/**
 * A party wall within this of the wall top (m) reads as one continuous facade with its
 * neighbour: no line along the top, none up the shared corner.
 */
const PARTY_SLACK = 1.5;

/** Wall corners sharper than this get a vertical outline; gentler bends in curved walls don't. */
const CREASE = Math.cos((35 * Math.PI) / 180);

const plans = new WeakMap<Building, RoofPlan>();
/** The roof a building gets; a landmark's footprint is a flat base under its parts. */
function planOf(b: Building): RoofPlan {
  let plan = plans.get(b);
  if (!plan) {
    const landmark = LANDMARK_MODELS.get(b.id);
    plan = landmark ? { type: 'flat', eave: landmark.base } : planRoof(b);
    plans.set(b, plan);
  }
  return plan;
}

/** The rings a building's walls stand on: a hipped roof was fitted to a simplified footprint. */
function wallRings(b: Building, plan: RoofPlan): readonly ArrayLike<number>[] {
  return plan.type === 'hip' ? [plan.ring, ...plan.holes] : [b.ring, ...b.holes];
}

/**
 * A footprint corner as one number: its coordinates in decimetres, the precision the city file
 * keeps, each offset to be positive and given 21 bits (±100 km).
 */
const pointKey = (x: number, z: number) =>
  (Math.round(x * 10) + 2 ** 20) * 2 ** 21 + (Math.round(z * 10) + 2 ** 20);

/**
 * Where a house stands: the lowest ground under its corners, down to a whole LIFT_UNIT, so the
 * shader's windows start at its foot (mesh-builder.ts). Its walls run on into the ground uphill.
 */
export const footing = (terrain: Terrain, ring: ArrayLike<number>) =>
  Math.floor(terrain.base(ring) / LIFT_UNIT) * LIFT_UNIT;

/**
 * Party walls: for every footprint edge, the wall-top height of the building on its other side,
 * above the ground at Grote Markt (its `base`, where it stands, plus its eaves).
 * Row houses share most of their walls, and a wall between two houses is never seen below the
 * lower of the two, so `addBuilding` only draws what rises above its neighbour. Edges are keyed
 * by numbers rather than strings, which keeps the lookups out of the startup profile: each corner
 * gets an id, and an edge is its two ids.
 */
export interface PartyWalls {
  corners: ReadonlyMap<number, number>;
  edges: ReadonlyMap<number, number>;
}

/** Room for 2^22 corners: an edge key is two corner ids, under 2^44. */
const edgeKey = (a: number, b: number) => a * 2 ** 22 + b;

/** Corner ids of a ring, `undefined` where no footprint has that corner. */
function cornerIds(ring: ArrayLike<number>, corners: ReadonlyMap<number, number>) {
  return Array.from({ length: ring.length / 2 }, (_, i) =>
    corners.get(pointKey(ring[i * 2]!, ring[i * 2 + 1]!)),
  );
}

export function partyWalls(
  buildings: readonly Building[],
  base: (b: Building) => number = () => 0,
): PartyWalls {
  const corners = new Map<number, number>();
  const edges = new Map<number, number>();
  for (const b of buildings) {
    const plan = planOf(b);
    for (const ring of wallRings(b, plan)) {
      const n = ring.length / 2;
      const ids: number[] = [];
      for (let i = 0; i < n; i++) {
        const key = pointKey(ring[i * 2]!, ring[i * 2 + 1]!);
        let id = corners.get(key);
        if (id === undefined) corners.set(key, (id = corners.size));
        ids.push(id);
      }
      const top = base(b) + plan.eave;
      for (let i = 0; i < n; i++) edges.set(edgeKey(ids[i]!, ids[(i + 1) % n]!), top);
    }
  }
  return { corners, edges };
}

const NO_WALLS: PartyWalls = { corners: new Map(), edges: new Map() };

/**
 * Walls along one ring: outer rings counter-clockwise, courtyards clockwise, so both face out.
 * `base` is where the building stands, so its neighbours' wall tops can be read in its own frame.
 */
function addWalls(
  mesh: MeshBuilder,
  lines: Ink,
  ring: ArrayLike<number>,
  top: number,
  wall: number,
  facade: number,
  walls: PartyWalls,
  base: number,
): void {
  const n = ring.length / 2;
  const ids = cornerIds(ring, walls.corners);
  const against = (a: number | undefined, b: number | undefined) => {
    const height = a === undefined || b === undefined ? undefined : walls.edges.get(edgeKey(a, b));
    return height === undefined ? undefined : height - base;
  };
  for (let i = 0; i < n; i++) {
    const ax = ring[i * 2]!;
    const az = ring[i * 2 + 1]!;
    const bx = ring[((i + 1) % n) * 2]!;
    const bz = ring[((i + 1) % n) * 2 + 1]!;
    // Counter-clockwise ring: the outward normal of edge a→b is (dz, -dx).
    const hint: V3 = [bz - az, 0, -(bx - ax)];
    // The neighbour across this edge walks it the other way round.
    const [a, b] = [ids[i], ids[(i + 1) % n]];
    const neighbour = against(b, a);
    const bottom = Math.max(0, Math.min(neighbour ?? 0, top));
    if (bottom < top) {
      mesh.quad(
        [ax, bottom, az],
        [bx, bottom, bz],
        [bx, top, bz],
        [ax, top, az],
        wall,
        hint,
        facade,
      );
    }

    // Outlines straight from the footprint: the wall top, unless a neighbour of about the same
    // height carries on from it, and the corners that are real creases. The base is left out:
    // the road and square surfaces cover it almost everywhere.
    const party = neighbour !== undefined && neighbour > top - PARTY_SLACK;
    if (!party) lines.segment([ax, top, az], [bx, top, bz]);
    const px = ring[((i + n - 1) % n) * 2]!;
    const pz = ring[((i + n - 1) % n) * 2 + 1]!;
    const [d1x, d1z, d2x, d2z] = [ax - px, az - pz, bx - ax, bz - az];
    const cos = (d1x * d2x + d1z * d2z) / (Math.hypot(d1x, d1z) * Math.hypot(d2x, d2z) || 1);
    if (cos > CREASE) continue;
    // A corner against a neighbour is a crease only where the wall rises above it.
    const before = against(a, ids[(i + n - 1) % n]);
    const below = Math.max(neighbour ?? 0, before ?? 0);
    if (below < top - PARTY_SLACK) lines.segment([ax, below, az], [ax, top, az]);
  }
}

const toVectors = (ring: ArrayLike<number>) =>
  Array.from({ length: ring.length / 2 }, (_, i) => new Vector2(ring[i * 2]!, ring[i * 2 + 1]!));

export function addBuilding(
  mesh: MeshBuilder,
  lines: LineBuilder,
  b: Building,
  walls: PartyWalls = NO_WALLS,
  base = 0,
): void {
  // A hero landmark extrudes its footprint to a low base and builds its real shape on top.
  const landmark = LANDMARK_MODELS.get(b.id);
  const plan = planOf(b);
  const ink = landmark || signedArea(b.ring) >= MIN_INKED_AREA ? inkOf(lines) : NO_INK;
  const wall = landmark?.wall ?? wallColor(b.kind, b.id);
  const [ring, ...holes] = wallRings(b, plan) as [ArrayLike<number>, ...ArrayLike<number>[]];

  const top = plan.eave;
  // Sheds get no windows, churches lancets: the window grid would make an office block of them.
  const windows = landmark?.windows ?? (b.kind === 'church' ? 'lancet' : b.kind !== 'shed');
  const front = windows === 'lancet' ? LANCETS : b.kind === 'retail' ? SHOP_FRONT : 0;
  const facade = windows ? top + front : 0;
  for (const r of [ring, ...holes]) addWalls(mesh, ink, r, top, wall, facade, walls, base);
  if (b.tower && !landmark) addTower(mesh, ink, ring, b.tower, wall, LANDMARK.spire);

  if (plan.type === 'hip') {
    hipRoof(mesh, ink, plan, b);
    return;
  }
  if (plan.type === 'flat') {
    const contour = toVectors(ring);
    const courtyards = holes.map(toVectors);
    const points = [...contour, ...courtyards.flat()];
    const roof = roofColor(landmark ? null : b.roofColor, true, b.id);
    const corners = points.map((p): V3 => [p.x, plan.eave, p.y]);
    mesh.polygon(corners, ShapeUtils.triangulateShape(contour, courtyards), roof, [0, 1, 0]);
    if (landmark) addLandmark(mesh, lines, ring, landmark);
    return;
  }

  const { rect, eave, ridge } = plan;
  const roof = roofColor(b.roofColor, false, b.id);
  const [ux, uz, vx, vz] = [rect.ux, rect.uz, -rect.uz, rect.ux];
  const at = (u: number, v: number, y: number): V3 => [
    rect.cx + ux * u + vx * v,
    y,
    rect.cz + uz * u + vz * v,
  ];
  const { halfLength: L, halfWidth: W } = rect;
  // Two roof slopes meet at a ridge along the long axis; gable triangles close the ends.
  const left: V3 = [vx, 1, vz];
  const right: V3 = [-vx, 1, -vz];
  mesh.quad(at(-L, W, eave), at(L, W, eave), at(L, 0, ridge), at(-L, 0, ridge), roof, left);
  mesh.quad(at(-L, -W, eave), at(L, -W, eave), at(L, 0, ridge), at(-L, 0, ridge), roof, right);
  for (const side of [W, -W]) ink.segment(at(-L, side, eave), at(L, side, eave));
  ink.segment(at(-L, 0, ridge), at(L, 0, ridge));
  for (const end of [L, -L]) {
    const out: V3 = [Math.sign(end) * ux, 0, Math.sign(end) * uz];
    if (plan.stepped) {
      steppedGable(mesh, ink, at, end, out, plan, wall);
      continue;
    }
    mesh.triangle(at(end, -W, eave), at(end, W, eave), at(end, 0, ridge), wall, out);
    ink.segment(at(end, W, eave), at(end, 0, ridge));
    ink.segment(at(end, -W, eave), at(end, 0, ridge));
  }
}

/**
 * All buildings as one flat-shaded, vertex-coloured geometry plus their ink outlines. Small
 * street props (café parasols) ride along in the same draw call and cast shadows too.
 */
export function buildingsGeometry(
  buildings: readonly Building[],
  parasols: readonly Parasol[] = [],
): {
  surfaces: BufferGeometry;
  outlines: BufferGeometry;
} {
  const mesh = new MeshBuilder();
  const lines = new LineBuilder();
  const walls = partyWalls(buildings);
  for (const b of buildings) addBuilding(mesh, lines, b, walls);
  for (const p of parasols) addParasol(mesh, lines, p);
  return { surfaces: mesh.build({ facade: true }), outlines: lines.build() };
}
