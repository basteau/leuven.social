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
/** Triangles per tree, for budgets and tests. */
export const TREE_TRIANGLES = (TRUNK.length + CROWN.length) / 3;

const crownColors = TREE.tints.map((tint) => {
  // The tint multiplies the crown colour per channel: light variety only.
  const channel = (shift: number) =>
    Math.round((((TREE.crown >> shift) & 255) * ((tint >> shift) & 255)) / 255);
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
});

/**
 * One low-poly tree at (x, z), written straight into a cell's mesh: no instancing, so trees are
 * culled with their cell and cost no draw call of their own. Size, turn and tint vary by seed.
 */
export function addTree(mesh: MeshBuilder, x: number, z: number, seed: number): void {
  const scale = 0.8 + pick([0, 0.15, 0.3, 0.45], seed);
  const turn = (seed * 2.399) % (Math.PI * 2);
  const [c, s] = [Math.cos(turn), Math.sin(turn)];
  const place = ([px, py, pz]: V3): V3 => [
    x + (px * c + pz * s) * scale,
    py * scale,
    z + (-px * s + pz * c) * scale,
  ];
  for (const [shape, color, centreY] of [
    [TRUNK, TREE.trunk, 1.5],
    [CROWN, pick(crownColors, seed), 4.6],
  ] as const) {
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
