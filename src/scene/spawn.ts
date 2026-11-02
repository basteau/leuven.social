import type { BufferGeometry } from 'three';

import { MeshBuilder } from './mesh-builder.ts';
import { OUTLINE, PLATE, WALKER } from './palette.ts';

/**
 * Starting a walk where someone clicked, the way GTA drops the camera onto a character, in the
 * diorama's own register: a marker drops onto the spot, the camera dives at it from the map and
 * swings in behind (`flight` in chase.ts, with a dive), and the walker drops in, lands with a
 * squash and a puff of dust, and settles. Leaving, the walker turns to the camera and waves as
 * it rises. The timings and shapes are here, pure; walk.ts plays them.
 */

/** The marker lands before the camera sets off (s): GTA's beat high above the city. */
export const SPAWN_HOLD = 0.12;
/** The dive from the map to behind the walker, and the climb back (s). */
export const SPAWN_FLIGHT = 1.25;
/** How far the dive tips the view down over the middle of the flight (radians). */
export const DIVE = 0.7;
/** The walker falls for this long before the camera lands (s), from this high (m). */
export const FALL = 0.3;
export const DROP = 3.5;
/** The marker drops in over this long (s), from this many times its size. */
export const MARK = 0.22;
export const MARK_FROM = 2.4;
/** The marker's radius: this share of the view's height, and never under MARK_MIN (m). */
const MARK_SHARE = 0.032;
export const MARK_MIN = 0.55;
/** The puff of dust spreads to this many times the marker's last size over PUFF (s). */
export const PUFF = 0.42;
export const PUFF_TO = 2.6;
/** Leaving: how long the walker waves (s) while the camera starts to rise. */
export const WAVE = 0.9;
/** Landed, the walker has settled after this long (s), its squash and its dust both gone. */
export const SETTLE = 0.5;

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** Eases out past the end and back, as a thing dropped onto a spot does. */
const backOut = (t: number) => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2;

/** The marker's size, as a share of its resting size, `t` seconds after the click. */
export const markerDrop = (t: number) =>
  t <= 0 ? MARK_FROM : t >= MARK ? 1 : backOut(t / MARK) * (1 - MARK_FROM) + MARK_FROM;

/** The marker's radius (m) for a view this tall at the spot (m): the same size on screen. */
export const markerRadius = (span: number) => Math.max(MARK_MIN, span * MARK_SHARE);

/**
 * How high over the ground the walker is (m), `left` seconds before it lands: falling faster
 * and faster, and out of sight (Infinity) before its fall begins.
 */
export function fallHeight(left: number): number {
  if (left <= 0) return 0;
  if (left > FALL) return Infinity;
  return DROP * (left / FALL) ** 2;
}

/**
 * The walker's height as a share of its own, `since` seconds after it lands (negative while
 * it falls): stretched by the fall, squashed by the landing, then springing back and settling.
 * Its width is the inverse square root, so it keeps its volume.
 */
export function bodyStretch(since: number): number {
  if (since < 0) return 1 + 0.16 * clamp01(1 + since / FALL);
  const settle = Math.exp(-10 * since);
  return since >= SETTLE ? 1 : 1 - 0.3 * settle * Math.cos(21 * since);
}

/**
 * How far the walker has yet to settle from its landing, `since` seconds after it (1 just
 * landed, 0 settled): for a crouch in the pose once the figure has one.
 */
export const settling = (since: number) =>
  since >= 0 && since < SETTLE ? Math.exp(-since / 0.12) : 0;

/**
 * The puff of dust, `since` seconds after the landing: how far it has spread (a share of the
 * marker's size) and how much of it is left (1 to 0), or null once it's gone.
 */
export function puff(since: number): [spread: number, left: number] | null {
  if (!(since >= 0 && since < PUFF)) return null;
  const t = since / PUFF;
  return [1 + (PUFF_TO - 1) * (1 - (1 - t) ** 3), 1 - t * t];
}

/**
 * Leaving, the walker's right arm `t` seconds after: raised in front, the forearm waving, and
 * lowered again (swing and elbow, as in `Pose`), or null when it isn't waving.
 */
export function wave(t: number): [arm: number, elbow: number] | null {
  if (!(t >= 0 && t < WAVE)) return null;
  const up = clamp01(t / 0.15) * clamp01((WAVE - t) / 0.2);
  const lift = up * up * (3 - 2 * up);
  return [-2.7 * lift, (-0.3 - 0.35 * Math.sin(t * Math.PI * 5)) * lift];
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
 * The spawn marker, a target of radius 1 flat at the origin, ringed in ink like the HUD and in
 * the walker's coral, and after it (from MARKER_INDICES on) the puffs of dust its landing kicks
 * up, at radius 1. One unlit draw call; walk.ts scales it and picks the part with a draw range.
 */
export function spawnMarker(): BufferGeometry {
  const mesh = new MeshBuilder();
  for (const [outer, inner, color] of BANDS) band(mesh, outer, inner, color);
  disc(mesh, 0, 0, DOT, SIDES, WALKER.shirt);
  band(mesh, DOT + 0.08, DOT, OUTLINE);
  for (let i = 0; i < PUFFS; i++) {
    const a = ((i + 0.5) * Math.PI * 2) / PUFFS;
    disc(mesh, Math.cos(a), Math.sin(a), PUFF_SIZE * (i % 2 ? 0.75 : 1), 6, PLATE.paper);
  }
  return mesh.build();
}
