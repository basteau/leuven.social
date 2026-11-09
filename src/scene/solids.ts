import type { City } from '../data/city.ts';
import { propFootprint } from '../data/props.ts';
import { DOOR_PLANT, awningRoom, doorPlants } from '../data/awnings.ts';
import { CAFE_TABLE, frontPoint, terraceFootprint } from '../data/shops.ts';
import type { Solids } from '../data/walkable.ts';
import { terraceParasols } from './terraces.ts';
import { trunkFoot } from './trees.ts';

/**
 * What a walker can't walk through but the city file holds no wall for, as the scene draws it
 * (`WalkGrid`'s `Solids`): every trunk at its foot, lamp posts as posts, and the footprints of
 * benches (the seat, not the room for legs in front of it), racks, shelters, statues, fountains
 * and pumps, of the café parasols' weighted feet, and of the shop fronts' terraces.
 */
/** Half a hedge's thickness, as a walker meets it (m). */
const HEDGE = 0.45;

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
  for (const line of city.hedges) {
    for (let i = 0; i + 3 < line.length; i += 2) {
      const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
      const length = Math.hypot(bx - ax, bz - az);
      if (length < 0.1) continue;
      box(ax, az, (bx - ax) / length, (bz - az) / length, [-HEDGE, HEDGE, 0, length]);
    }
  }
  for (const front of city.fronts) {
    const p = frontPoint(city.buildings[front.building]!.ring, front);
    // The bay trees by a café's door (storefronts.ts), met as posts.
    const others = city.fronts
      .filter((o) => o.building === front.building && o.edge === front.edge && o !== front)
      .map((o) => o.along);
    const plants = doorPlants(p, front, awningRoom(front.along, p.length, others));
    for (let i = 0; i < plants.length; i += 2)
      posts.push(plants[i]!, plants[i + 1]!, DOOR_PLANT.radius);
    if (!front.terrace) continue;
    const f = terraceFootprint(p);
    box(f.x, f.z, f.fx, f.fz, [f.u0, f.u1, f.v0, f.v1]);
  }
  // A parasol's table and the chairs round it (storefronts.ts).
  for (const p of terraceParasols(city)) {
    const h = CAFE_TABLE.reach;
    box(p.x, p.z, p.uz, -p.ux, [-h, h, -h, h]);
  }
  return { posts, rings };
}
