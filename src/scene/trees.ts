import { CylinderGeometry, IcosahedronGeometry } from 'three';
import type { BufferGeometry } from 'three';

import type { MeshBuilder, V3 } from './mesh-builder.ts';
import { fromOklab, toOklab } from '../data/colour.ts';
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
 * One low-poly tree at (x, z), written straight into a cell's mesh: no instancing, so trees are
 * culled with their cell and cost no draw call of their own. It grows to its surveyed height
 * (LiDAR), a little narrower than tall; without one, the seed picks a size. Turn and tint vary
 * by seed.
 */
export function addTree(mesh: MeshBuilder, x: number, z: number, seed: number, height = 0): void {
  const scale =
    height > 0
      ? Math.min(Math.max(height / MODEL_HEIGHT, 0.7), 2.8)
      : 0.8 + pick([0, 0.15, 0.3, 0.45], seed);
  // Crowns spread a fifth wider than the model: the LiDAR trees are spaced by crown size, so a
  // canopy closes with as few trees as possible. Some are slimmer, some broader.
  const wide = 1.2 * scale ** 0.8 * pick([0.86, 0.94, 1, 1.06, 1.14], seed * 3);
  const turn = (seed * 2.399) % (Math.PI * 2);
  const [c, s] = [Math.cos(turn), Math.sin(turn)];
  const place = ([px, py, pz]: V3): V3 => [
    x + (px * c + pz * s) * wide,
    py * scale,
    z + (-px * s + pz * c) * wide,
  ];
  for (const [shape, color, centreY] of [
    [TRUNK, TREE.trunk, 1.5],
    [CROWN, crownColor(seed, height || scale * MODEL_HEIGHT), 4.6],
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
