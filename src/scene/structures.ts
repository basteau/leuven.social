import { ShapeUtils, Vector2 } from 'three';

import type { Tank } from '../data/city.ts';
import type { LineBuilder, MeshBuilder, V3 } from './mesh-builder.ts';
import { STRUCTURES } from './palette.ts';

const UP: V3 = [0, 1, 0];
/** Parapets: a low wall a little over waist height, from the deck (road level) up (m). */
const PARAPET_TOP = 1.1;
const PARAPET_HALF = 0.2;
const DECK = 0.15;

/** A tank or silo: its footprint walled up to its height under a flat lid, outlined at the top. */
export function addTank(mesh: MeshBuilder, lines: LineBuilder, { height, ring }: Tank): void {
  const n = ring.length / 2;
  const contour = Array.from({ length: n }, (_, i) => new Vector2(ring[i * 2]!, ring[i * 2 + 1]!));
  for (let i = 0; i < n; i++) {
    const [a, b] = [contour[i]!, contour[(i + 1) % n]!];
    // Counter-clockwise in (x, z): the outside lies to the right of each edge.
    const out: V3 = [b.y - a.y, 0, a.x - b.x];
    mesh.quad(
      [a.x, 0, a.y],
      [b.x, 0, b.y],
      [b.x, height, b.y],
      [a.x, height, a.y],
      STRUCTURES.tank,
      out,
    );
    lines.segment([a.x, height, a.y], [b.x, height, b.y]);
  }
  for (const [i, j, k] of ShapeUtils.triangulateShape(contour, [])) {
    const p = (idx: number): V3 => [contour[idx]!.x, height, contour[idx]!.y];
    mesh.triangle(p(i!), p(j!), p(k!), STRUCTURES.tankTop, UP);
  }
}

/** The capstone along a parapet's top: how far it overhangs each face, and how thick it is (m). */
const COPING_OVER = 0.06;
const COPING = 0.08;

/**
 * A bridge parapet along an open line: a low stone wall under a paler capstone that overhangs
 * it a little, outlined along the capstone's edges.
 */
export function addParapet(mesh: MeshBuilder, lines: LineBuilder, line: ArrayLike<number>): void {
  const last = line.length / 2 - 1;
  for (let i = 0; i < last; i++) {
    const [ax, az, bx, bz] = [line[i * 2]!, line[i * 2 + 1]!, line[i * 2 + 2]!, line[i * 2 + 3]!];
    const length = Math.hypot(bx - ax, bz - az);
    if (length < 1e-6) continue;
    const [ux, uz] = [(bz - az) / length, -(bx - ax) / length];
    const corner = (x: number, z: number, side: 1 | -1, y: number, half = PARAPET_HALF): V3 => [
      x + ux * half * side,
      y,
      z + uz * half * side,
    ];
    const under = PARAPET_TOP - COPING;
    const cap = PARAPET_HALF + COPING_OVER;
    for (const side of [1, -1] as const) {
      const out: V3 = [ux * side, 0, uz * side];
      mesh.quad(
        corner(ax, az, side, DECK),
        corner(bx, bz, side, DECK),
        corner(bx, bz, side, under),
        corner(ax, az, side, under),
        STRUCTURES.parapet,
        out,
      );
      mesh.quad(
        corner(ax, az, side, under, cap),
        corner(bx, bz, side, under, cap),
        corner(bx, bz, side, PARAPET_TOP, cap),
        corner(ax, az, side, PARAPET_TOP, cap),
        STRUCTURES.coping,
        out,
      );
      lines.segment(corner(ax, az, side, PARAPET_TOP, cap), corner(bx, bz, side, PARAPET_TOP, cap));
    }
    mesh.quad(
      corner(ax, az, 1, PARAPET_TOP, cap),
      corner(bx, bz, 1, PARAPET_TOP, cap),
      corner(bx, bz, -1, PARAPET_TOP, cap),
      corner(ax, az, -1, PARAPET_TOP, cap),
      STRUCTURES.coping,
      UP,
    );
    // Its ends, where the wall meets the bank.
    for (const [x, z, sign] of [
      [ax, az, -1],
      [bx, bz, 1],
    ] as const) {
      if ((sign < 0 && i > 0) || (sign > 0 && i < last - 1)) continue;
      mesh.quad(
        corner(x, z, 1, DECK),
        corner(x, z, -1, DECK),
        corner(x, z, -1, PARAPET_TOP, cap),
        corner(x, z, 1, PARAPET_TOP, cap),
        STRUCTURES.parapet,
        [((bx - ax) / length) * sign, 0, ((bz - az) / length) * sign],
      );
    }
  }
}
