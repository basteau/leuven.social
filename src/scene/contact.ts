import type { Bounds, Building, Prop } from '../data/city.ts';
import { signedArea } from '../data/geometry.ts';
import { rackRows, ROW_GAP, STAND_SPACING } from '../data/props.ts';
import type { MeshBuilder, V3 } from './mesh-builder.ts';

/**
 * The dark at the foot of what stands on the ground, so it stands there rather than floats: a band
 * along every wall that faces the open, and a patch under a rack, each from `facade` 1 at the wall
 * to 0 at its edge, drawn in the ordered dither (`createContactMaterial`). Part of the furniture
 * chunk. Walls shared with a neighbour in the cell get none.
 */

/** How far a wall's band reaches out over the ground (m), and how high it lies over the terrain. */
export const CONTACT = { reach: 1.15, lift: 0.225, shortest: 1.2, piece: 12 } as const;

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
      // In pieces, so a long wall's band follows the ground rather than cutting under a rise.
      const pieces = Math.max(1, Math.ceil(length / CONTACT.piece));
      for (let k = 0; k < pieces; k++) {
        const [t0, t1] = [k / pieces, (k + 1) / pieces];
        const [x0, z0, x1, z1] = [
          ax + (bx - ax) * t0,
          az + (bz - az) * t0,
          ax + (bx - ax) * t1,
          az + (bz - az) * t1,
        ];
        mesh.quad(
          lifted(x0, z0),
          lifted(x1, z1),
          lifted(x1 + nx, z1 + nz),
          lifted(x0 + nx, z0 + nz),
          0,
          [0, 1, 0],
          [1, 1, 0, 0],
        );
      }
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

/** The bank of the water: a stone lip, and how dark the water is along it (m). */
export const SHORE = { lip: 0.4, reach: 2, y: 0.112, stone: 0x9a9281 } as const;

/**
 * Along every bank of the water in a cell: a lip of stone in `stone`, and in `dark` the shade the
 * bank throws on the water, in the ordered dither. Cells cut the water along their edges, which is
 * no bank, so those get none. Under the decks of the bridges, which lie higher.
 */
export function addShores(
  dark: MeshBuilder,
  stone: MeshBuilder,
  water: readonly Float32Array[],
  within: Bounds,
  ground: (x: number, z: number) => number,
): void {
  // A cut runs along one edge of the cell; a bank can reach from one edge to another.
  const onCut = (ax: number, az: number, bx: number, bz: number) =>
    (Math.abs(ax - bx) < 1e-3 &&
      (Math.abs(ax - within.minX) < 1e-3 || Math.abs(ax - within.maxX) < 1e-3)) ||
    (Math.abs(az - bz) < 1e-3 &&
      (Math.abs(az - within.minZ) < 1e-3 || Math.abs(az - within.maxZ) < 1e-3));
  const at = (x: number, z: number): V3 => [x, ground(x, z) + SHORE.y, z];
  for (const ring of water) {
    const inward = signedArea(ring) > 0 ? -1 : 1;
    for (let i = 0; i < ring.length; i += 2) {
      const j = (i + 2) % ring.length;
      const [ax, az, bx, bz] = [ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!];
      const length = Math.hypot(bx - ax, bz - az);
      if (length < 0.5 || onCut(ax, az, bx, bz)) continue;
      const [ux, uz] = [((bz - az) / length) * inward, (-(bx - ax) / length) * inward];
      const up: V3 = [0, 1, 0];
      stone.quad(
        at(ax, az),
        at(bx, bz),
        at(bx + ux * SHORE.lip, bz + uz * SHORE.lip),
        at(ax + ux * SHORE.lip, az + uz * SHORE.lip),
        SHORE.stone,
        up,
      );
      dark.quad(
        at(ax + ux * SHORE.lip, az + uz * SHORE.lip),
        at(bx + ux * SHORE.lip, bz + uz * SHORE.lip),
        at(bx + ux * SHORE.reach, bz + uz * SHORE.reach),
        at(ax + ux * SHORE.reach, az + uz * SHORE.reach),
        0,
        up,
        [0.8, 0.8, 0, 0],
      );
    }
  }
}
