import { ShapeUtils, Vector2 } from 'three';
import type { BufferGeometry } from 'three';

import type { Building, Tier } from '../data/city.ts';
import { orientedRect, signedArea, simplifyRing } from '../data/geometry.ts';
import type { OrientedRect } from '../data/geometry.ts';
import { straightSkeleton } from '../data/skeleton.ts';
import type { Skeleton } from '../data/skeleton.ts';
import { LANDMARK_MODELS } from './landmark-models.ts';
import { addLandmark } from './landmarks.ts';
import { LineBuilder, MeshBuilder } from './mesh-builder.ts';
import type { V3 } from './mesh-builder.ts';
import { addParasol } from './terraces.ts';
import type { Parasol } from './terraces.ts';
import { WALLS, pick, roofColor } from './palette.ts';

export type RoofPlan =
  | { type: 'flat'; eave: number }
  | { type: 'gable'; eave: number; ridge: number; rect: OrientedRect; stepped: boolean }
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
/** Churches and sheds don't get the window grid: it would read as an office block. */
const WINDOWLESS = new Set(['church', 'shed']);
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
/** Footprint detail finer than this (m) is survey noise to a roof, and below a game pixel. */
const ROOF_TOLERANCE = 0.25;
/** Below this footprint area (m²) a pitched roof is too small to read: bins, kiosks. */
const MIN_PITCHED_AREA = 12;

/**
 * Decides the roof from the footprint, the tags and the LiDAR survey. Heights include the roof,
 * so a pitched roof takes its rise out of the wall height: the surveyed rise (ridge minus eave)
 * where there is one, else a ~42° guess, capped so a steep roof never eats the whole building.
 * Row houses get gables along their long side; every other shape a hipped roof from its
 * straight skeleton, which follows L, T and U wings and courtyards.
 */
export function planRoof(b: Building): RoofPlan {
  const flat = { type: 'flat', eave: b.height } as const;
  if (b.roof === 'flat') return flat;
  const explicit = b.roof !== 'auto';
  if (!explicit && (!PITCHED_KINDS.has(b.kind) || b.height > 24)) return flat;
  if (signedArea(b.ring) < MIN_PITCHED_AREA) return flat;
  const surveyed = b.height - b.eave >= 1.5 ? b.height - b.eave : 0;
  const rect = orientedRect(b.ring);
  const gable =
    b.roof !== 'hipped' &&
    b.holes.length === 0 &&
    rect.fill >= GABLE_FILL &&
    rect.halfWidth >= 1.5 &&
    rect.halfWidth <= 9;
  if (gable) {
    const guess = Math.max(rect.halfWidth * 0.9, 1.5);
    const rise = Math.min(surveyed || guess, surveyed ? rect.halfWidth * 1.5 : 6, b.height * 0.5);
    // Steps need room: on a narrow or flat gable they'd be smaller than a game pixel.
    const stepped = rect.halfWidth >= 2.5 && rise >= 2.5 && pick(STEPPED[b.tier], b.id * 13);
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
  for (const [i, j, k] of ShapeUtils.triangulateShape(contour, [])) {
    mesh.triangle(p(i!), p(j!), p(k!), color, hint);
  }
}

/** A hipped roof over the straight skeleton, flattened off where it reaches its surveyed rise. */
function hipRoof(
  mesh: MeshBuilder,
  lines: LineBuilder,
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
 * reads from the street side and from behind. Replaces the plain gable triangle.
 */
function steppedGable(
  mesh: MeshBuilder,
  lines: LineBuilder,
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
      const sideways: V3 = [
        (at(0, 1, 0)[0] - at(0, 0, 0)[0]) * side,
        0,
        (at(0, 1, 0)[2] - at(0, 0, 0)[2]) * side,
      ];
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
      mesh.quad(
        at(end, q0, top),
        at(end, q1, top),
        at(back, q1, top),
        at(back, q0, top),
        wall,
        [0, 1, 0],
      );
      mesh.quad(
        at(end, q0, below),
        at(back, q0, below),
        at(back, q0, top),
        at(end, q0, top),
        wall,
        sideways,
      );
      lines.segment(at(end, q0, below), at(end, q0, top));
      lines.segment(at(end, q0, top), at(end, q1, top));
      below = top;
    }
  }
}

/** Wall corners sharper than this get a vertical outline; gentler bends in curved walls don't. */
const CREASE = Math.cos((35 * Math.PI) / 180);

/** Walls along one ring: outer rings counter-clockwise, courtyards clockwise, so both face out. */
function addWalls(
  mesh: MeshBuilder,
  lines: LineBuilder,
  ring: ArrayLike<number>,
  top: number,
  wall: number,
  facade: number,
): void {
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = ring[i * 2]!;
    const az = ring[i * 2 + 1]!;
    const bx = ring[((i + 1) % n) * 2]!;
    const bz = ring[((i + 1) % n) * 2 + 1]!;
    // Counter-clockwise ring: the outward normal of edge a→b is (dz, -dx).
    const hint: V3 = [bz - az, 0, -(bx - ax)];
    mesh.quad([ax, 0, az], [bx, 0, bz], [bx, top, bz], [ax, top, az], wall, hint, facade);

    // Outlines straight from the footprint: base, wall top, and the corners that are real creases.
    lines.segment([ax, 0, az], [bx, 0, bz]);
    lines.segment([ax, top, az], [bx, top, bz]);
    const px = ring[((i + n - 1) % n) * 2]!;
    const pz = ring[((i + n - 1) % n) * 2 + 1]!;
    const [d1x, d1z, d2x, d2z] = [ax - px, az - pz, bx - ax, bz - az];
    const cos = (d1x * d2x + d1z * d2z) / (Math.hypot(d1x, d1z) * Math.hypot(d2x, d2z) || 1);
    if (cos <= CREASE) lines.segment([ax, 0, az], [ax, top, az]);
  }
}

const toVectors = (ring: ArrayLike<number>) =>
  Array.from({ length: ring.length / 2 }, (_, i) => new Vector2(ring[i * 2]!, ring[i * 2 + 1]!));

function addBuilding(mesh: MeshBuilder, lines: LineBuilder, b: Building): void {
  // A hero landmark extrudes its footprint to a low base and builds its real shape on top.
  const landmark = LANDMARK_MODELS.get(b.id);
  const plan: RoofPlan = landmark ? { type: 'flat', eave: landmark.base } : planRoof(b);
  const wall = landmark?.wall ?? pick(WALLS[b.kind], b.id);
  // A hipped roof was fitted to the simplified footprint, so its walls follow that one.
  const [ring, holes] = plan.type === 'hip' ? [plan.ring, plan.holes] : [b.ring, b.holes];

  const top = plan.eave;
  const windowless = landmark ? !landmark.windows : WINDOWLESS.has(b.kind);
  const facade = windowless ? 0 : top;
  for (const r of [ring, ...holes]) addWalls(mesh, lines, r, top, wall, facade);

  if (plan.type === 'hip') {
    hipRoof(mesh, lines, plan, b);
    return;
  }
  if (plan.type === 'flat') {
    const contour = toVectors(ring);
    const courtyards = holes.map(toVectors);
    const points = [...contour, ...courtyards.flat()];
    const roof = roofColor(landmark ? null : b.roofColor, true, b.id);
    for (const [i, j, k] of ShapeUtils.triangulateShape(contour, courtyards)) {
      const p = (idx: number): V3 => [points[idx]!.x, plan.eave, points[idx]!.y];
      mesh.triangle(p(i!), p(j!), p(k!), roof, [0, 1, 0]);
    }
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
  for (const side of [W, -W]) lines.segment(at(-L, side, eave), at(L, side, eave));
  lines.segment(at(-L, 0, ridge), at(L, 0, ridge));
  for (const end of [L, -L]) {
    const out: V3 = [Math.sign(end) * ux, 0, Math.sign(end) * uz];
    if (plan.stepped) {
      steppedGable(mesh, lines, at, end, out, plan, wall);
      continue;
    }
    mesh.triangle(at(end, -W, eave), at(end, W, eave), at(end, 0, ridge), wall, out);
    lines.segment(at(end, W, eave), at(end, 0, ridge));
    lines.segment(at(end, -W, eave), at(end, 0, ridge));
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
  for (const b of buildings) addBuilding(mesh, lines, b);
  for (const p of parasols) addParasol(mesh, lines, p);
  return { surfaces: mesh.build({ facade: true }), outlines: lines.build() };
}
