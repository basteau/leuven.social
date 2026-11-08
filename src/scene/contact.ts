import type { Building, Prop } from '../data/city.ts';
import { rackRows, ROW_GAP, STAND_SPACING } from '../data/props.ts';
import type { MeshBuilder, V3 } from './mesh-builder.ts';

/**
 * The dark at the foot of what stands on the ground, so it stands there rather than floats: a band
 * along every wall that faces the open, and a patch under a rack, each from `facade` 1 at the wall
 * to 0 at its edge, drawn in the ordered dither (`createContactMaterial`). Part of the furniture
 * chunk. Walls shared with a neighbour in the cell get none.
 */

/** How far a wall's band reaches out over the ground (m), and how high it lies over the terrain. */
export const CONTACT = { reach: 1.15, lift: 0.225, shortest: 1.2 } as const;

/** How dark the ground under a rack is (of the darkest), and how far it fades in from its edge (m). */
const RACK_DARK = 0.5;
const RACK_RIM = 0.45;

const key = (x: number, z: number) => `${Math.round(x * 10)},${Math.round(z * 10)}`;

export function addContacts(
  mesh: MeshBuilder,
  buildings: readonly Pick<Building, 'ring' | 'tier'>[],
  racks: readonly Prop[],
  ground: (x: number, z: number) => number,
): void {
  const edges = new Set<string>();
  const near = buildings.filter((b) => b.tier !== 'fringe');
  for (const { ring } of near) {
    for (let i = 0; i < ring.length; i += 2) {
      const j = (i + 2) % ring.length;
      edges.add(`${key(ring[i]!, ring[i + 1]!)}>${key(ring[j]!, ring[j + 1]!)}`);
    }
  }
  const lifted = (x: number, z: number): V3 => [x, ground(x, z) + CONTACT.lift, z];
  for (const { ring } of near) {
    for (let i = 0; i < ring.length; i += 2) {
      const j = (i + 2) % ring.length;
      const [ax, az, bx, bz] = [ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!];
      const length = Math.hypot(bx - ax, bz - az);
      if (length < CONTACT.shortest) continue;
      // Its neighbour walks this edge the other way round: a party wall has nothing to darken.
      if (edges.has(`${key(bx, bz)}>${key(ax, az)}`)) continue;
      const [nx, nz] = [
        ((bz - az) / length) * CONTACT.reach,
        (-(bx - ax) / length) * CONTACT.reach,
      ];
      mesh.quad(
        lifted(ax, az),
        lifted(bx, bz),
        lifted(bx + nx, bz + nz),
        lifted(ax + nx, az + nz),
        0,
        [0, 1, 0],
        [1, 1, 0, 0],
      );
    }
  }
  for (const p of racks) {
    const { rows, perRow } = rackRows(p.size);
    const [fx, fz] = [Math.cos(p.angle), Math.sin(p.angle)];
    const halfU = ((perRow - 1) / 2) * STAND_SPACING * 1.3 + 0.4;
    const halfV = ((rows === 2 ? ROW_GAP : 0) + 0.7) * 1.3;
    const corner = (u: number, v: number) => lifted(p.x - fz * u + fx * v, p.z + fx * u + fz * v);
    // Dark in the middle, fading out over its rim, so it is no stamped rectangle.
    const [inU, inV] = [halfU - RACK_RIM, halfV - RACK_RIM];
    const rim = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const;
    const up: V3 = [0, 1, 0];
    const inner = rim.map(([u, v]) => corner(u * inU, v * inV));
    const outer = rim.map(([u, v]) => corner(u * halfU, v * halfV));
    mesh.quad(inner[0]!, inner[1]!, inner[2]!, inner[3]!, 0, up, RACK_DARK);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      mesh.quad(outer[i]!, outer[j]!, inner[j]!, inner[i]!, 0, up, [0, 0, RACK_DARK, RACK_DARK]);
    }
  }
}
