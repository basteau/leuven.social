import { ShapeUtils, Vector2 } from 'three';

import type { Bounds, Rail } from '../data/city.ts';
import { orientedRect } from '../data/geometry.ts';
import type { LineBuilder, MeshBuilder, V3 } from './mesh-builder.ts';
import { RAIL } from './palette.ts';

/** Standard gauge: the distance between the two rails of every track in Belgium (m). */
export const GAUGE = 1.435;
/** Width of the ballast bed under one track; beds of neighbouring tracks run together. */
const BALLAST = 4.4;
/** Sleeper length, which is the band the sleeper pattern is drawn on. */
const SLEEPERS = 2.6;
/**
 * Heights over the slab: above roads and squares (which tracks cross on bridges and level
 * crossings), with the rails just over the sleepers so the outlines don't sink into them.
 */
const Y = { ballast: 0.25, sleepers: 0.3, rails: 0.38 } as const;
/** Train-floor height of a Belgian platform. */
export const PLATFORM_HEIGHT = 0.76;
/** Catenary masts: how far apart along a line, how far beside the track, and how tall. */
const MAST_SPACING = 60;
const MAST_OFFSET = 3.4;
const MAST_HEIGHT = 7.2;
const ARM_HEIGHT = 6.6;
/** A mast this close to another one is the same mast, seen from the next way along. */
const MAST_MERGE = 8;
/** Bridge parapets stand just outside the ballast. */
const PARAPET_OFFSET = 2.4;
const PARAPET_HEIGHT = 1.5;
const PARAPET_THICKNESS = 0.4;
/** Nothing stands beside a track if another track runs within this distance of the spot. */
const CLEARANCE = 3;
const UP: V3 = [0, 1, 0];
/**
 * Platform roofs: vaults across the tracks, one per bay along them. Leuven's wave roof has four
 * bays of about 51 m, from 9.5 m at the valleys to 16 m at the crowns (DHMV II DSM − DTM, p10
 * and p97 over GRB annex 672696).
 */
const BAY_LENGTH = 51;
const CANOPY_EAVE = 9.5;
const CANOPY_CROWN = 16;
/** Points across a bay's vault, from valley to valley: -1 … 1 along the tracks. */
const VAULT = [-1, -0.5, 0, 0.5, 1] as const;

/** A catenary mast and the arm that holds the wire over its track. */
export interface Mast {
  x: number;
  z: number;
  /** The point over the track centre that the arm reaches. */
  tx: number;
  tz: number;
}

/** One stretch of a bridge parapet: from a to b, with (nx, nz) pointing away from the track. */
export interface Parapet {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  nx: number;
  nz: number;
}

/** Masts and parapets for the whole railway: both depend on the neighbouring tracks. */
export interface Railway {
  masts: Mast[];
  parapets: Parapet[];
}

const BUCKET = 16;
const key = (i: number, j: number) => `${i},${j}`;

/** Nearest distance from a point to any track but one, via a grid of track segments. */
function trackDistance(rails: readonly Rail[]) {
  const grid = new Map<string, number[]>();
  for (const [r, { line }] of rails.entries()) {
    for (let k = 0; k + 3 < line.length; k += 2) {
      const [ax, az, bx, bz] = [line[k]!, line[k + 1]!, line[k + 2]!, line[k + 3]!];
      const [i0, i1] = [
        Math.floor(Math.min(ax, bx) / BUCKET),
        Math.floor(Math.max(ax, bx) / BUCKET),
      ];
      const [j0, j1] = [
        Math.floor(Math.min(az, bz) / BUCKET),
        Math.floor(Math.max(az, bz) / BUCKET),
      ];
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const cell = grid.get(key(i, j)) ?? [];
          cell.push(r, ax, az, bx, bz);
          grid.set(key(i, j), cell);
        }
      }
    }
  }
  /** Within `reach` (at most one bucket), else Infinity. `skip` is the track asking. */
  return (x: number, z: number, skip: number, reach: number): number => {
    let best = Infinity;
    const [ci, cj] = [Math.floor(x / BUCKET), Math.floor(z / BUCKET)];
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        const cell = grid.get(key(i, j)) ?? [];
        for (let s = 0; s < cell.length; s += 5) {
          if (cell[s] === skip) continue;
          const [ax, az, bx, bz] = [cell[s + 1]!, cell[s + 2]!, cell[s + 3]!, cell[s + 4]!];
          const [dx, dz] = [bx - ax, bz - az];
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
          best = Math.min(best, Math.hypot(ax + t * dx - x, az + t * dz - z));
        }
      }
    }
    return best <= reach ? best : Infinity;
  };
}

/** Unit direction and a unit normal of a segment, or null for a zero-length one. */
function frame(ax: number, az: number, bx: number, bz: number) {
  const length = Math.hypot(bx - ax, bz - az);
  if (length < 1e-6) return null;
  const [ux, uz] = [(bx - ax) / length, (bz - az) / length];
  return { length, ux, uz, nx: uz, nz: -ux };
}

/**
 * Where masts and parapets go. A mast stands every 60 m along an electrified running line, on
 * whichever side of its track is clear of the others: in a yard, only the outer tracks get
 * them. Parapets line the sides of a bridge that no other bridge track runs beside.
 */
export function planRailway(rails: readonly Rail[]): Railway {
  const distance = trackDistance(rails);
  const masts: Mast[] = [];
  const parapets: Parapet[] = [];
  for (const [r, { line, kind, bridge, electrified }] of rails.entries()) {
    let travelled = 0;
    let next = MAST_SPACING / 2;
    for (let k = 0; k + 3 < line.length; k += 2) {
      const [ax, az, bx, bz] = [line[k]!, line[k + 1]!, line[k + 2]!, line[k + 3]!];
      const f = frame(ax, az, bx, bz);
      if (!f) continue;
      if (bridge) {
        for (const side of [1, -1]) {
          const [nx, nz] = [f.nx * side, f.nz * side];
          const [mx, mz] = [
            (ax + bx) / 2 + nx * PARAPET_OFFSET,
            (az + bz) / 2 + nz * PARAPET_OFFSET,
          ];
          if (distance(mx, mz, r, CLEARANCE) < Infinity) continue;
          const [ox, oz] = [nx * PARAPET_OFFSET, nz * PARAPET_OFFSET];
          parapets.push({ ax: ax + ox, az: az + oz, bx: bx + ox, bz: bz + oz, nx, nz });
        }
      }
      // Running lines only: in a yard, the masts of the lines around it do.
      if (!electrified || kind !== 'main') next = Infinity;
      for (; next <= travelled + f.length; next += MAST_SPACING) {
        const [tx, tz] = [ax + f.ux * (next - travelled), az + f.uz * (next - travelled)];
        // The side with more room, if either has enough.
        const [left, right] = [1, -1].map((side) =>
          distance(tx + f.nx * side * MAST_OFFSET, tz + f.nz * side * MAST_OFFSET, r, BUCKET),
        ) as [number, number];
        if (Math.max(left, right) < CLEARANCE) continue;
        const side = left >= right ? 1 : -1;
        const [x, z] = [tx + f.nx * side * MAST_OFFSET, tz + f.nz * side * MAST_OFFSET];
        if (masts.some((m) => Math.hypot(m.x - x, m.z - z) < MAST_MERGE)) continue;
        masts.push({ x, z, tx, tz });
      }
      travelled += f.length;
    }
  }
  return { masts, parapets };
}

/**
 * Tracks on the ground: a ballast bed under a band of sleepers, both flat ribbons in the cell's
 * mesh. The sleepers are no geometry: the band's `facade` attribute holds minus the distance
 * along the track, and the facade shader draws them from it. Ballast runs on by half its width
 * at both ends, so bends need no join geometry; the sleeper band doesn't, so its pattern never
 * overlaps itself.
 */
export function addTracks(mesh: MeshBuilder, rails: readonly Rail[]): void {
  for (const { line, kind } of rails) {
    const colors = RAIL[kind];
    let travelled = 0;
    for (let k = 0; k + 3 < line.length; k += 2) {
      const [ax, az, bx, bz] = [line[k]!, line[k + 1]!, line[k + 2]!, line[k + 3]!];
      const f = frame(ax, az, bx, bz);
      if (!f) continue;
      const ribbon = (half: number, run: number, y: number): [V3, V3, V3, V3] => {
        const [ux, uz, nx, nz] = [f.ux * run, f.uz * run, f.nx * half, f.nz * half];
        return [
          [ax - ux + nx, y, az - uz + nz],
          [bx + ux + nx, y, bz + uz + nz],
          [bx + ux - nx, y, bz + uz - nz],
          [ax - ux - nx, y, az - uz - nz],
        ];
      };
      mesh.quad(...ribbon(BALLAST / 2, BALLAST / 2, Y.ballast), colors.ballast, UP);
      // Never zero: zero means "no pattern" to the shader.
      const [u0, u1] = [-1 - travelled, -1 - travelled - f.length];
      mesh.quad(...ribbon(SLEEPERS / 2, 0, Y.sleepers), colors.sleepers, UP, [u0, u1, u1, u0]);
      travelled += f.length;
    }
  }
}

/**
 * Both rails of every track as 1-pixel ink lines in the cell's outlines: crisp at every zoom,
 * and no triangles at all.
 */
export function addRailLines(lines: LineBuilder, rails: readonly Rail[]): void {
  for (const { line } of rails) {
    for (let k = 0; k + 3 < line.length; k += 2) {
      const [ax, az, bx, bz] = [line[k]!, line[k + 1]!, line[k + 2]!, line[k + 3]!];
      const f = frame(ax, az, bx, bz);
      if (!f) continue;
      for (const side of [GAUGE / 2, -GAUGE / 2]) {
        const [ox, oz] = [f.nx * side, f.nz * side];
        lines.segment([ax + ox, Y.rails, az + oz], [bx + ox, Y.rails, bz + oz]);
      }
    }
  }
}

/** Catenary masts and their arms, as ink lines like the rails. */
export function addMasts(lines: LineBuilder, masts: readonly Mast[]): void {
  for (const { x, z, tx, tz } of masts) {
    lines.segment([x, 0, z], [x, MAST_HEIGHT, z]);
    lines.segment([x, ARM_HEIGHT, z], [tx, ARM_HEIGHT, tz]);
  }
}

/** A low wall along a bridge deck, outlined along its top. */
export function addParapet(mesh: MeshBuilder, lines: LineBuilder, p: Parapet): void {
  const { ax, az, bx, bz, nx, nz } = p;
  const [tx, tz] = [nx * PARAPET_THICKNESS, nz * PARAPET_THICKNESS];
  const [h, y0] = [PARAPET_HEIGHT, Y.ballast];
  const out: [V3, V3, V3, V3] = [
    [ax + tx, y0, az + tz],
    [bx + tx, y0, bz + tz],
    [bx + tx, h, bz + tz],
    [ax + tx, h, az + tz],
  ];
  const inner: [V3, V3, V3, V3] = [
    [ax, y0, az],
    [bx, y0, bz],
    [bx, h, bz],
    [ax, h, az],
  ];
  mesh.quad(...out, RAIL.parapet, [nx, 0, nz]);
  mesh.quad(...inner, RAIL.parapet, [-nx, 0, -nz]);
  mesh.quad(inner[3], inner[2], out[2], out[3], RAIL.parapet, UP);
  lines.segment(out[3], out[2]);
  lines.segment(inner[3], inner[2]);
}

const top = (v: Vector2): V3 => [v.x, PLATFORM_HEIGHT, v.y];

const SEAM = 1e-3;
/** Whether a→b runs along an edge of `cut`, where a platform was cut at a cell border. */
const onSeam = (a: Vector2, b: Vector2, cut: Bounds) =>
  [cut.minX, cut.maxX].some((x) => Math.abs(a.x - x) < SEAM && Math.abs(b.x - x) < SEAM) ||
  [cut.minZ, cut.maxZ].some((z) => Math.abs(a.y - z) < SEAM && Math.abs(b.y - z) < SEAM);

/**
 * A platform: its outline raised to train-floor height, with an ink edge along the top. Edges
 * along the cell's border are where the platform was cut, so they get no wall or ink.
 */
export function addPlatform(
  mesh: MeshBuilder,
  lines: LineBuilder,
  ring: Float32Array,
  cell: Bounds,
): void {
  const contour = Array.from(
    { length: ring.length / 2 },
    (_, i) => new Vector2(ring[i * 2]!, ring[i * 2 + 1]!),
  );
  for (const [i, j, k] of ShapeUtils.triangulateShape(contour, [])) {
    mesh.triangle(top(contour[i!]!), top(contour[j!]!), top(contour[k!]!), RAIL.platform, UP);
  }
  for (const [i, a] of contour.entries()) {
    const b = contour[(i + 1) % contour.length]!;
    if (onSeam(a, b, cell)) continue;
    // Counter-clockwise ring: the outward normal of edge a→b is (dz, -dx).
    const hint: V3 = [b.y - a.y, 0, a.x - b.x];
    mesh.quad([a.x, 0, a.y], [b.x, 0, b.y], top(b), top(a), RAIL.platformSide, hint);
    lines.segment(top(a), top(b));
  }
}

/** One vaulted bay of a platform roof: centre, unit vector along the tracks, half sizes. */
export interface CanopyBay {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  halfLength: number;
  halfWidth: number;
}

/** Cuts a platform roof's outline into its bays along the tracks (its long side). */
export function canopyBays(ring: Float32Array): CanopyBay[] {
  const { cx, cz, ux, uz, halfLength, halfWidth } = orientedRect(ring);
  const count = Math.max(1, Math.round((2 * halfLength) / BAY_LENGTH));
  const half = halfLength / count;
  return Array.from({ length: count }, (_, i) => {
    const along = -halfLength + half * (2 * i + 1);
    return { cx: cx + ux * along, cz: cz + uz * along, ux, uz, halfLength: half, halfWidth };
  });
}

/**
 * A bay: a vault rising across the tracks from valley to crown and back, its open ends filled
 * down to the valleys, outlined in ink, on a post at each corner. Side by side, the bays make
 * the wave.
 */
export function addCanopyBay(mesh: MeshBuilder, lines: LineBuilder, bay: CanopyBay): void {
  const { cx, cz, ux, uz, halfLength, halfWidth } = bay;
  const [nx, nz] = [uz, -ux];
  const at = (
    t: number,
    side: number,
    y = CANOPY_EAVE + (CANOPY_CROWN - CANOPY_EAVE) * (1 - t * t),
  ): V3 => [
    cx + ux * halfLength * t + nx * halfWidth * side,
    y,
    cz + uz * halfLength * t + nz * halfWidth * side,
  ];
  for (let i = 0; i + 1 < VAULT.length; i++) {
    const [t0, t1] = [VAULT[i]!, VAULT[i + 1]!];
    mesh.quad(at(t0, -1), at(t1, -1), at(t1, 1), at(t0, 1), RAIL.canopy, UP);
    for (const side of [-1, 1]) {
      const hint: V3 = [nx * side, 0, nz * side];
      mesh.triangle(at(0, side, CANOPY_EAVE), at(t0, side), at(t1, side), RAIL.canopyEnd, hint);
      lines.segment(at(t0, side), at(t1, side));
    }
  }
  for (const t of [-1, 1]) {
    lines.segment(at(t, -1), at(t, 1));
    for (const side of [-1, 1]) lines.segment(at(t, side, 0), at(t, side));
  }
}
