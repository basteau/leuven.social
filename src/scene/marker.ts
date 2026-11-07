import type { BufferGeometry } from 'three';

import { MeshBuilder } from './mesh-builder.ts';
import { OUTLINE, WALKER } from './palette.ts';

/**
 * A spot the avatar can't go to (no ground to stand on, or too far): a target drops onto it,
 * ringed in ink like the HUD and greyed, and shakes its head. The timings and the shape are
 * here, pure; avatar-layer.ts plays them.
 */

/** The marker drops in over this long (s), from this many times its size. */
export const MARK = 0.22;
export const MARK_FROM = 2.4;
/** The marker's radius: this share of the view's height, and never under MARK_MIN (m). */
const MARK_SHARE = 0.032;
export const MARK_MIN = 0.55;

/** Eases out past the end and back, as a thing dropped onto a spot does. */
const backOut = (t: number) => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2;

/** The marker's size, as a share of its resting size, `t` seconds after the tap. */
export const markerDrop = (t: number) =>
  t <= 0 ? MARK_FROM : t >= MARK ? 1 : backOut(t / MARK) * (1 - MARK_FROM) + MARK_FROM;

/** The marker's radius (m) for a view this tall at the spot (m): the same size on screen. */
export const markerRadius = (span: number) => Math.max(MARK_MIN, span * MARK_SHARE);

const UP = [0, 1, 0] as const;
const SIDES = 20;
/** The marker's bands, outside in: an ink rim, a coral ring, an ink rim, and a coral dot. */
const BANDS = [
  [1, 0.84, OUTLINE],
  [0.84, 0.62, WALKER.shirt],
  [0.62, 0.52, OUTLINE],
] as const;
const DOT = 0.2;

const at = (r: number, a: number, y = 0) => [Math.cos(a) * r, y, Math.sin(a) * r] as const;

function band(mesh: MeshBuilder, outer: number, inner: number, color: number) {
  for (let i = 0; i < SIDES; i++) {
    const [a, b] = [(i * Math.PI * 2) / SIDES, ((i + 1) * Math.PI * 2) / SIDES];
    mesh.quad(at(outer, a), at(outer, b), at(inner, b), at(inner, a), color, UP);
  }
}

/**
 * The marker, a target of radius 1 flat at the origin, ringed in ink like the HUD and in the
 * avatar's coral (greyed by its material when refusing). One unlit draw call; avatar-layer.ts
 * scales it.
 */
export function markerGeometry(): BufferGeometry {
  const mesh = new MeshBuilder();
  for (const [outer, inner, color] of BANDS) band(mesh, outer, inner, color);
  for (let i = 1; i < SIDES - 1; i++) {
    mesh.triangle(
      at(DOT, 0),
      at(DOT, (i * Math.PI * 2) / SIDES),
      at(DOT, ((i + 1) * Math.PI * 2) / SIDES),
      WALKER.shirt,
      UP,
    );
  }
  band(mesh, DOT + 0.08, DOT, OUTLINE);
  return mesh.build({ keep: true });
}
