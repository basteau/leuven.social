import { ShapeUtils, Vector2 } from 'three';
import type { BufferGeometry } from 'three';

import type { Building } from '../data/city.ts';
import { orientedRect } from '../data/geometry.ts';
import type { OrientedRect } from '../data/geometry.ts';
import { LineBuilder, MeshBuilder } from './mesh-builder.ts';
import type { V3 } from './mesh-builder.ts';
import { FLAT_ROOFS, PITCHED_ROOFS, WALLS, pick } from './palette.ts';

export type RoofPlan =
  | { type: 'flat'; eave: number }
  | { type: 'gable'; eave: number; ridge: number; rect: OrientedRect };

const PITCHED_KINDS = new Set(['house', 'apartments', 'retail', 'other']);
/** Churches and sheds don't get the window grid: it would read as an office block. */
const WINDOWLESS = new Set(['church', 'shed']);

/**
 * Decides the roof from the footprint and height. LiDAR heights include the roof, so a pitched
 * roof takes its rise out of the wall height. Hipped roofs render as gables for now.
 */
export function planRoof(b: Building): RoofPlan {
  const flat = { type: 'flat', eave: b.height } as const;
  if (b.roof === 'flat') return flat;
  const explicit = b.roof === 'gabled' || b.roof === 'hipped';
  if (!explicit && (!PITCHED_KINDS.has(b.kind) || b.height > 24)) return flat;
  const rect = orientedRect(b.ring);
  if (rect.fill < (explicit ? 0.6 : 0.7) || rect.halfWidth < 1.5 || rect.halfWidth > 9) return flat;
  const rise = Math.min(Math.max(rect.halfWidth * 0.9, 1.5), 6, b.height * 0.45);
  return { type: 'gable', eave: b.height - rise, ridge: b.height, rect };
}

/** Wall corners sharper than this get a vertical outline; gentler bends in curved walls don't. */
const CREASE = Math.cos((35 * Math.PI) / 180);

function addBuilding(mesh: MeshBuilder, lines: LineBuilder, b: Building): void {
  const plan = planRoof(b);
  const wall = pick(WALLS[b.kind], b.id);
  const ring = b.ring;
  const n = ring.length / 2;

  const top = plan.eave;
  const facade = WINDOWLESS.has(b.kind) ? 0 : top;
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

  if (plan.type === 'flat') {
    const contour = Array.from(
      { length: n },
      (_, i) => new Vector2(ring[i * 2]!, ring[i * 2 + 1]!),
    );
    const roof = pick(FLAT_ROOFS, b.id);
    for (const [i, j, k] of ShapeUtils.triangulateShape(contour, [])) {
      const p = (idx: number): V3 => [contour[idx]!.x, plan.eave, contour[idx]!.y];
      mesh.triangle(p(i!), p(j!), p(k!), roof, [0, 1, 0]);
    }
    return;
  }

  const { rect, eave, ridge } = plan;
  const roof = pick(PITCHED_ROOFS, b.id * 7);
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
  mesh.triangle(at(L, -W, eave), at(L, W, eave), at(L, 0, ridge), wall, [ux, 0, uz]);
  mesh.triangle(at(-L, -W, eave), at(-L, W, eave), at(-L, 0, ridge), wall, [-ux, 0, -uz]);

  for (const side of [W, -W]) {
    lines.segment(at(-L, side, eave), at(L, side, eave));
    lines.segment(at(L, side, eave), at(L, 0, ridge));
    lines.segment(at(-L, side, eave), at(-L, 0, ridge));
  }
  lines.segment(at(-L, 0, ridge), at(L, 0, ridge));
}

/** All buildings as one flat-shaded, vertex-coloured geometry plus their ink outlines. */
export function buildingsGeometry(buildings: readonly Building[]): {
  surfaces: BufferGeometry;
  outlines: BufferGeometry;
} {
  const mesh = new MeshBuilder();
  const lines = new LineBuilder();
  for (const b of buildings) addBuilding(mesh, lines, b);
  return { surfaces: mesh.build({ facade: true }), outlines: lines.build() };
}
