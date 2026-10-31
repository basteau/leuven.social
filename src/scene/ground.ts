import { ShapeUtils, Vector2 } from 'three';
import type { BufferGeometry } from 'three';

import type { City } from '../data/city.ts';
import { MeshBuilder } from './mesh-builder.ts';
import { GROUND } from './palette.ts';

/** How far the diorama slab drops below street level, in metres. */
export const SLAB_DEPTH = 12;
const UP = [0, 1, 0] as const;

function addRings(mesh: MeshBuilder, rings: readonly Float32Array[], y: number, color: number) {
  for (const ring of rings) {
    const contour = Array.from(
      { length: ring.length / 2 },
      (_, i) => new Vector2(ring[i * 2]!, ring[i * 2 + 1]!),
    );
    for (const [i, j, k] of ShapeUtils.triangulateShape(contour, [])) {
      const p = (idx: number) => [contour[idx]!.x, y, contour[idx]!.y] as const;
      mesh.triangle(p(i!), p(j!), p(k!), color, UP);
    }
  }
}

/** The diorama: an earth slab with garden ground, then water, roads and squares on top. */
export function groundGeometry(city: City): BufferGeometry {
  const mesh = new MeshBuilder();
  const { minX, minZ, maxX, maxZ } = city.bounds;
  const d = -SLAB_DEPTH;
  mesh.quad([minX, 0, minZ], [maxX, 0, minZ], [maxX, 0, maxZ], [minX, 0, maxZ], GROUND.base, UP);
  // Earth sides, each with its outward direction: [x0, z0, x1, z1, hint].
  const sides = [
    [minX, maxZ, maxX, maxZ, [0, 0, 1]],
    [minX, minZ, maxX, minZ, [0, 0, -1]],
    [maxX, minZ, maxX, maxZ, [1, 0, 0]],
    [minX, minZ, minX, maxZ, [-1, 0, 0]],
  ] as const;
  for (const [x0, z0, x1, z1, hint] of sides) {
    mesh.quad([x0, d, z0], [x1, d, z1], [x1, 0, z1], [x0, 0, z0], GROUND.earth, hint);
  }
  // Layers stack a few centimetres apart; the orthographic depth buffer resolves that cleanly.
  addRings(mesh, city.green, 0.05, GROUND.green);
  addRings(mesh, city.water, 0.1, GROUND.water);
  addRings(mesh, city.roads, 0.15, GROUND.road);
  addRings(mesh, city.plazas, 0.2, GROUND.plaza);
  return mesh.build();
}
