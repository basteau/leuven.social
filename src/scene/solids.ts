import type { City } from '../data/city.ts';
import { propFootprint } from '../data/props.ts';
import type { Solids } from '../data/walkable.ts';
import { terraceParasols, PARASOL_FOOT } from './terraces.ts';
import { trunkFoot } from './trees.ts';

/**
 * What a walker can't walk through but the city file holds no wall for, as the scene draws it
 * (`WalkGrid`'s `Solids`): every trunk at its foot, lamp posts as posts, and the footprints of
 * benches (the seat, not the room for legs in front of it), racks, shelters, statues, fountains
 * and pumps, and of the café parasols' weighted feet.
 */
export function walkSolids(city: City): Solids {
  const posts: number[] = [];
  for (let i = 0; i < city.trees.length / 2; i++) {
    const [x, z] = [city.trees[i * 2]!, city.trees[i * 2 + 1]!];
    posts.push(x, z, trunkFoot(i, city.treeHeights[i] ?? 0));
  }
  const rings: Float32Array[] = [];
  const box = (x: number, z: number, fx: number, fz: number, uv: readonly number[]) => {
    const [u0, u1, v0, v1] = uv as [number, number, number, number];
    rings.push(
      Float32Array.from(
        [
          [u0, v0],
          [u1, v0],
          [u1, v1],
          [u0, v1],
        ].flatMap(([u, v]) => [x - fz * u! + fx * v!, z + fx * u! + fz * v!]),
      ),
    );
  };
  for (const p of city.props) {
    const f = propFootprint(p);
    if (p.kind === 'lamp') posts.push(f.x, f.z, f.u1);
    else box(f.x, f.z, f.fx, f.fz, [f.u0, f.u1, f.v0, p.kind === 'bench' ? -f.v0 : f.v1]);
  }
  for (const p of terraceParasols(city)) {
    const h = PARASOL_FOOT;
    box(p.x, p.z, p.uz, -p.ux, [-h, h, -h, h]);
  }
  return { posts, rings };
}
