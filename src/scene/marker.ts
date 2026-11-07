import type { BufferGeometry } from 'three';

import { MeshBuilder } from './mesh-builder.ts';
import { OUTLINE, PLATE, WALKER } from './palette.ts';

/**
 * Feedback on the ground where the avatar is sent: a marker drops onto the spot, ringed in ink
 * like the HUD, and puffs dust when the avatar arrives there by a jump (a tap too far to walk, a
 * place from the menu); a spot nobody can reach gets the same marker greyed. Far out, where the
 * figure would be a speck, the avatar itself is a small marker (`avatarDot`). The timings and
 * shapes are here, pure; avatar-layer.ts plays them.
 */

/** The marker drops in over this long (s), from this many times its size. */
export const MARK = 0.22;
export const MARK_FROM = 2.4;
/** The marker's radius: this share of the view's height, and never under MARK_MIN (m). */
const MARK_SHARE = 0.032;
export const MARK_MIN = 0.55;
/** The puff of dust spreads to this many times the marker's last size over PUFF (s). */
export const PUFF = 0.42;
export const PUFF_TO = 2.6;

/** Eases out past the end and back, as a thing dropped onto a spot does. */
const backOut = (t: number) => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2;

/** The marker's size, as a share of its resting size, `t` seconds after the tap. */
export const markerDrop = (t: number) =>
  t <= 0 ? MARK_FROM : t >= MARK ? 1 : backOut(t / MARK) * (1 - MARK_FROM) + MARK_FROM;

/** The marker's radius (m) for a view this tall at the spot (m): the same size on screen. */
export const markerRadius = (span: number) => Math.max(MARK_MIN, span * MARK_SHARE);

/**
 * The puff of dust, `since` seconds after the arrival: how far it has spread (a share of the
 * marker's size) and how much of it is left (1 to 0), or null once it's gone.
 */
export function puff(since: number): [spread: number, left: number] | null {
  if (!(since >= 0 && since < PUFF)) return null;
  const t = since / PUFF;
  return [1 + (PUFF_TO - 1) * (1 - (1 - t) ** 3), 1 - t * t];
}

const UP = [0, 1, 0] as const;
const SIDES = 20;
/** The marker's bands, outside in: an ink rim, a coral ring, an ink rim, and a coral dot. */
const BANDS = [
  [1, 0.84, OUTLINE],
  [0.84, 0.62, WALKER.shirt],
  [0.62, 0.52, OUTLINE],
] as const;
const DOT = 0.2;
/** Puffs of dust round the ring, each a small hexagon of paper. */
const PUFFS = 7;
const PUFF_SIZE = 0.2;

/** Indices the marker takes at the start of `spawnMarker`'s geometry; the puffs follow. */
export const MARKER_INDICES = BANDS.length * SIDES * 6 + (SIDES - 2) * 3 + SIDES * 6;

const at = (r: number, a: number, y = 0) => [Math.cos(a) * r, y, Math.sin(a) * r] as const;

/** Polygon fan of `sides` round (x, z), flat. */
function disc(mesh: MeshBuilder, x: number, z: number, r: number, sides: number, color: number) {
  const corner = (i: number) => {
    const a = (i * Math.PI * 2) / sides;
    return [x + Math.cos(a) * r, 0, z + Math.sin(a) * r] as const;
  };
  for (let i = 1; i < sides - 1; i++) mesh.triangle(corner(0), corner(i), corner(i + 1), color, UP);
}

function band(mesh: MeshBuilder, outer: number, inner: number, color: number) {
  for (let i = 0; i < SIDES; i++) {
    const [a, b] = [(i * Math.PI * 2) / SIDES, ((i + 1) * Math.PI * 2) / SIDES];
    mesh.quad(at(outer, a), at(outer, b), at(inner, b), at(inner, a), color, UP);
  }
}

/**
 * The marker, a target of radius 1 flat at the origin, ringed in ink like the HUD and in the
 * avatar's coral, and after it (from MARKER_INDICES on) the puffs of dust an arrival kicks up, at
 * radius 1. One unlit draw call; avatar-layer.ts scales it and picks the part with a draw range.
 */
export function markerGeometry(): BufferGeometry {
  const mesh = new MeshBuilder();
  for (const [outer, inner, color] of BANDS) band(mesh, outer, inner, color);
  disc(mesh, 0, 0, DOT, SIDES, WALKER.shirt);
  band(mesh, DOT + 0.08, DOT, OUTLINE);
  for (let i = 0; i < PUFFS; i++) {
    const a = ((i + 0.5) * Math.PI * 2) / PUFFS;
    disc(mesh, Math.cos(a), Math.sin(a), PUFF_SIZE * (i % 2 ? 0.75 : 1), 6, PLATE.paper);
  }
  return mesh.build({ keep: true });
}

/**
 * The avatar from far out: a diamond of radius 1, flat at the origin, in its coral, two
 * triangles. Drawn over the city at one size on screen, where the figure would be a speck.
 */
export function avatarDot(): BufferGeometry {
  const mesh = new MeshBuilder();
  mesh.quad([1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1], WALKER.shirt, UP);
  return mesh.build({ keep: true });
}
