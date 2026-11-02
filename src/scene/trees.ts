import { CylinderGeometry, IcosahedronGeometry } from 'three';
import type { BufferGeometry } from 'three';

import type { MeshBuilder, V3 } from './mesh-builder.ts';
import { fromOklab, toOklab } from '../data/colour.ts';
import { treeScale } from '../data/trees.ts';
import { TREE, pick } from './palette.ts';

/** Flat triangle soup of a three.js shape, so trees can join the cell meshes. */
function triangles(geometry: BufferGeometry): V3[] {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  const p = flat.getAttribute('position');
  const out = Array.from({ length: p.count }, (_, i): V3 => [p.getX(i), p.getY(i), p.getZ(i)]);
  geometry.dispose();
  flat.dispose();
  return out;
}

// A four-sided open trunk is all a pixel can show: its caps hide in the crown and the ground.
const TRUNK_BASE = 0.4;
const CROWN_RADIUS = 2.6;
const CROWN_Y = 4.6;
/** Between the crown's inner radius (0.79) and its edges' midpoints (0.85): what a passing camera meets. */
const CROWN_INNER = CROWN_RADIUS * 0.82;
const TRUNK = triangles(new CylinderGeometry(0.3, TRUNK_BASE, 3, 4, 1, true).translate(0, 1.5, 0));
const CROWN = triangles(new IcosahedronGeometry(CROWN_RADIUS, 0).translate(0, CROWN_Y, 0));
/** Height of the model at scale 1, from the ground to the crown's top vertex (m). */
export const MODEL_HEIGHT = 6.8;
/** Triangles per tree, for budgets and tests. */
export const TREE_TRIANGLES = (TRUNK.length + CROWN.length) / 3;

const CROWN_LAB = toOklab(TREE.crown);

/** A tree's own green: lightness and hue strayed by its seed, darker the older (taller) it is. */
export function crownColor(seed: number, height: number): number {
  const unit = (salt: number) => (pick(UNITS, seed * 7 + salt) / (UNITS.length - 1)) * 2 - 1;
  const [l, a, b] = CROWN_LAB;
  const turn = unit(1) * TREE.jitter.hue;
  const [c, s] = [Math.cos(turn), Math.sin(turn)];
  const old = Math.min(Math.max((height - 7) / 18, 0), 1) * TREE.age;
  return fromOklab([l + unit(2) * TREE.jitter.l - old, a * c - b * s, a * s + b * c]);
}
const UNITS = Array.from({ length: 64 }, (_, i) => i);

/**
 * How much a tree is scaled up and spread out from its model: to its surveyed height (LiDAR), a
 * little narrower than tall; without one, the seed picks a size. Crowns spread a fifth wider
 * than the model: the LiDAR trees are spaced by crown size, so a canopy closes with as few trees
 * as possible. Some are slimmer, some broader.
 */
export function treeSize(seed: number, height = 0): { scale: number; wide: number } {
  const scale = height > 0 ? treeScale(height) : 0.8 + pick([0, 0.15, 0.3, 0.45], seed);
  return { scale, wide: 1.2 * scale ** 0.8 * pick([0.86, 0.94, 1, 1.06, 1.14], seed * 3) };
}

/**
 * A tree as solid shapes, in metres: its trunk's radius at the ground, and the middle height,
 * horizontal and vertical radii of its crown (the model's 20-face crown, a little inside its
 * corners). For anything that has to keep out of a tree, like the walking camera.
 */
export function treeSolid(
  seed: number,
  height = 0,
): { trunk: number; crownY: number; crownWide: number; crownTall: number } {
  const { scale, wide } = treeSize(seed, height);
  return {
    trunk: TRUNK_BASE * wide,
    crownY: CROWN_Y * scale,
    crownWide: CROWN_INNER * wide,
    crownTall: CROWN_INNER * scale,
  };
}

export type TreePart = 'trunk' | 'crown';

/** A side of the trunk as the cylinder writes it: triangles a, b, d and b, c, d. */
const SIDE = [
  [0, 1, 3],
  [1, 2, 3],
];

/**
 * One low-poly tree at (x, z), written straight into a cell's mesh: no instancing, so trees are
 * culled with their cell and cost no draw call of their own. It grows to its surveyed height
 * (LiDAR), a little narrower than tall; without one, the seed picks a size. Turn and tint vary
 * by seed. `parts` lets a cell write all its trunks apart from the crowns (see `buildCell`).
 */
export function addTree(
  mesh: MeshBuilder,
  x: number,
  z: number,
  seed: number,
  height = 0,
  parts: readonly TreePart[] = ['trunk', 'crown'],
): void {
  const { scale, wide } = treeSize(seed, height);
  const turn = (seed * 2.399) % (Math.PI * 2);
  const [c, s] = [Math.cos(turn), Math.sin(turn)];
  const place = ([px, py, pz]: V3): V3 => [
    x + (px * c + pz * s) * wide,
    py * scale,
    z + (-px * s + pz * c) * wide,
  ];
  for (const [part, shape, color, centreY] of [
    ['trunk', TRUNK, TREE.trunk, 1.5],
    ['crown', CROWN, crownColor(seed, height || scale * MODEL_HEIGHT), CROWN_Y],
  ] as const) {
    if (!parts.includes(part)) continue;
    // Each side of the trunk is a flat quad, (a, b, d) then (b, c, d): one vertex per corner.
    const step = part === 'trunk' ? 6 : 3;
    for (let i = 0; i < shape.length; i += step) {
      const [a, b, d] = [place(shape[i]!), place(shape[i + 1]!), place(shape[i + 2]!)];
      // Outward from the shape's axis, so the builder can orient every face.
      const hint: V3 = [
        (a[0] + b[0] + d[0]) / 3 - x,
        (a[1] + b[1] + d[1]) / 3 - centreY * scale,
        (a[2] + b[2] + d[2]) / 3 - z,
      ];
      if (step === 3) mesh.triangle(a, b, d, color, hint);
      else mesh.polygon([a, b, place(shape[i + 4]!), d], SIDE, color, hint);
    }
  }
}
