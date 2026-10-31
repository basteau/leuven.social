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

/** One low-poly tree, instanced at every OSM tree: a single draw call for all of them. */
export function createTrees(positions: Float32Array, material: Material): InstancedMesh {
  const trunk = painted(new CylinderGeometry(0.3, 0.4, 3, 5).translate(0, 1.5, 0), TREE.trunk);
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
    const scale = 0.8 + pick([0, 0.15, 0.3, 0.45], i);
    p.set(positions[i * 2]!, 0, positions[i * 2 + 1]!);
    q.setFromAxisAngle(up, (i * 2.399) % (Math.PI * 2));
    s.setScalar(scale);
    trees.setMatrixAt(i, m.compose(p, q, s));
    // Instance colours multiply the whole tree, so they stay near white: light variety only.
    trees.setColorAt(i, tint.setHex(pick(TREE.tints, i)));
  }
  trees.castShadow = true;
  trees.receiveShadow = true;
  trees.computeBoundingSphere();
  return trees;
}
