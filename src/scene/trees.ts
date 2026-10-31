import {
  BufferAttribute,
  Color,
  CylinderGeometry,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three';
import type { BufferGeometry, Material } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { TREE, pick } from './palette.ts';

function painted(geometry: BufferGeometry, hex: number): BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  if (flat !== geometry) geometry.dispose();
  flat.deleteAttribute('uv');
  const c = new Color(hex);
  const colors = new Float32Array(flat.attributes.position!.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  flat.setAttribute('color', new BufferAttribute(colors, 3));
  flat.computeVertexNormals();
  return flat;
}

/** Height of the model at scale 1, from the ground to the top of the crown (m). */
const MODEL_HEIGHT = 7.2;

/**
 * One low-poly tree, instanced at every tree (OSM and the LiDAR canopy) and scaled to its
 * surveyed height: a single draw call for all of them. The trunk is open-ended, since its
 * caps are hidden under the crown and in the ground anyway.
 */
export function createTrees(
  positions: Float32Array,
  heights: Float32Array,
  material: Material,
): InstancedMesh {
  const trunk = painted(
    new CylinderGeometry(0.3, 0.4, 3, 5, 1, true).translate(0, 1.5, 0),
    TREE.trunk,
  );
  const crown = painted(new IcosahedronGeometry(2.6, 0).translate(0, 4.6, 0), TREE.crown);
  const geometry = mergeGeometries([trunk, crown]);
  trunk.dispose();
  crown.dispose();

  const count = positions.length / 2;
  const trees = new InstancedMesh(geometry, material, count);
  const m = new Matrix4();
  const q = new Quaternion();
  const s = new Vector3();
  const p = new Vector3();
  const up = new Vector3(0, 1, 0);
  const tint = new Color();
  for (let i = 0; i < count; i++) {
    // Tall trees spread less than they grow, so very tall ones get a little narrower.
    const scale = Math.min(Math.max((heights[i] ?? MODEL_HEIGHT) / MODEL_HEIGHT, 0.7), 2.8);
    p.set(positions[i * 2]!, 0, positions[i * 2 + 1]!);
    q.setFromAxisAngle(up, (i * 2.399) % (Math.PI * 2));
    s.set(scale ** 0.8, scale, scale ** 0.8);
    trees.setMatrixAt(i, m.compose(p, q, s));
    // Instance colours multiply the whole tree, so they stay near white: light variety only.
    trees.setColorAt(i, tint.setHex(pick(TREE.tints, i)));
  }
  trees.castShadow = true;
  trees.receiveShadow = true;
  trees.computeBoundingSphere();
  return trees;
}
