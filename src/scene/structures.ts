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
  const top = contour.map((p): V3 => [p.x, height, p.y]);
  mesh.polygon(top, ShapeUtils.triangulateShape(contour, []), STRUCTURES.tankTop, UP);
}

/** A bridge parapet along an open line: a low stone wall, outlined along its top. */
export function addParapet(mesh: MeshBuilder, lines: LineBuilder, line: ArrayLike<number>): void {
  const last = line.length / 2 - 1;
  for (let i = 0; i < last; i++) {
    const [ax, az, bx, bz] = [line[i * 2]!, line[i * 2 + 1]!, line[i * 2 + 2]!, line[i * 2 + 3]!];
    const length = Math.hypot(bx - ax, bz - az);
    if (length < 1e-6) continue;
    const [nx, nz] = [((bz - az) / length) * PARAPET_HALF, (-(bx - ax) / length) * PARAPET_HALF];
    const corner = (x: number, z: number, side: 1 | -1, y: number): V3 => [
      x + nx * side,
      y,
      z + nz * side,
    ];
    for (const side of [1, -1] as const) {
      mesh.quad(
        corner(ax, az, side, DECK),
        corner(bx, bz, side, DECK),
        corner(bx, bz, side, PARAPET_TOP),
        corner(ax, az, side, PARAPET_TOP),
        STRUCTURES.parapet,
        [nx * side, 0, nz * side],
      );
      lines.segment(corner(ax, az, side, PARAPET_TOP), corner(bx, bz, side, PARAPET_TOP));
    }
    mesh.quad(
      corner(ax, az, 1, PARAPET_TOP),
      corner(bx, bz, 1, PARAPET_TOP),
      corner(bx, bz, -1, PARAPET_TOP),
      corner(ax, az, -1, PARAPET_TOP),
      STRUCTURES.parapet,
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
        corner(x, z, -1, PARAPET_TOP),
        corner(x, z, 1, PARAPET_TOP),
        STRUCTURES.parapet,
        [((bx - ax) / length) * sign, 0, ((bz - az) / length) * sign],
      );
    }
  }
}
