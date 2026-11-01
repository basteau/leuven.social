import { CylinderGeometry, IcosahedronGeometry } from 'three';
import type { BufferGeometry } from 'three';

import type { MeshBuilder, V3 } from './mesh-builder.ts';
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
const TRUNK = triangles(new CylinderGeometry(0.3, 0.4, 3, 4, 1, true).translate(0, 1.5, 0));
const CROWN = triangles(new IcosahedronGeometry(2.6, 0).translate(0, 4.6, 0));
/** Height of the model at scale 1, from the ground to the crown's top vertex (m). */
export const MODEL_HEIGHT = 6.8;
/** Triangles per tree, for budgets and tests. */
export const TREE_TRIANGLES = (TRUNK.length + CROWN.length) / 3;

const crownColors = TREE.tints.map((tint) => {
  // The tint multiplies the crown colour per channel: light variety only.
  const channel = (shift: number) =>
    Math.round((((TREE.crown >> shift) & 255) * ((tint >> shift) & 255)) / 255);
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
});

export type TreePart = 'trunk' | 'crown';

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
  const scale =
    height > 0
      ? Math.min(Math.max(height / MODEL_HEIGHT, 0.7), 2.8)
      : 0.8 + pick([0, 0.15, 0.3, 0.45], seed);
  // Crowns spread a fifth wider than the model: the LiDAR trees are spaced by crown size, so a
  // canopy closes with as few trees as possible.
  const wide = 1.2 * scale ** 0.8;
  const turn = (seed * 2.399) % (Math.PI * 2);
  const [c, s] = [Math.cos(turn), Math.sin(turn)];
  const place = ([px, py, pz]: V3): V3 => [
    x + (px * c + pz * s) * wide,
    py * scale,
    z + (-px * s + pz * c) * wide,
  ];
  for (const [part, shape, color, centreY] of [
    ['trunk', TRUNK, TREE.trunk, 1.5],
    ['crown', CROWN, pick(crownColors, seed), 4.6],
  ] as const) {
    if (!parts.includes(part)) continue;
    for (let i = 0; i < shape.length; i += 3) {
      const [a, b, d] = [place(shape[i]!), place(shape[i + 1]!), place(shape[i + 2]!)];
      // Outward from the shape's axis, so the builder can orient every face.
      const hint: V3 = [
        (a[0] + b[0] + d[0]) / 3 - x,
        (a[1] + b[1] + d[1]) / 3 - centreY * scale,
        (a[2] + b[2] + d[2]) / 3 - z,
      ];
      mesh.triangle(a, b, d, color, hint);
    }
  }
}
