import type { Bounds, Building } from '../data/city.ts';
import { pointInRing, signedArea } from '../data/geometry.ts';
import type { MeshBuilder, V3 } from './mesh-builder.ts';

/**
 * The dark at the foot of what stands on the ground, so it stands there rather than floats: a band
 * along every wall that faces the open, from `facade` 1 at the wall to 0 at its edge, drawn in the
 * ordered dither (`createContactMaterial`). Part of the furniture chunk. Walls shared with a
 * neighbour in the cell get none. Each band is mitred into the next one, at a corner or across a
 * neighbour's front, so it runs round a building as one strip; where no wall carries it on, it
 * tapers to nothing over its own reach instead of stopping in a square block.
 */

/** How far a wall's band reaches out over the ground (m), and how high it lies over the terrain. */
export const CONTACT = { reach: 0.55, lift: 0.225, shortest: 0.6, piece: 12, miter: 1.5 } as const;

const key = (x: number, z: number) => `${Math.round(x * 10)},${Math.round(z * 10)}`;

interface Wall {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  length: number;
  /** Out of the building, unit length. */
  nx: number;
  nz: number;
}

/** Where a band's edge meets the next wall's, from their shared corner; short at a sharp fold. */
function miter(a: Wall, b: Wall): readonly [number, number] {
  const [mx, mz] = [a.nx + b.nx, a.nz + b.nz];
  const len = Math.hypot(mx, mz) || 1;
  const out = (Math.min(CONTACT.miter, 2 / len) * CONTACT.reach) / len;
  return [mx * out, mz * out];
}

export function addContacts(
  mesh: MeshBuilder,
  buildings: readonly Pick<Building, 'ring' | 'tier'>[],
  ground: (x: number, z: number) => number,
): void {
  const near = buildings.filter((b) => b.tier !== 'fringe');
  const eachEdge = (visit: (ax: number, az: number, bx: number, bz: number) => void) => {
    for (const { ring } of near) {
      for (let i = 0; i < ring.length; i += 2) {
        const j = (i + 2) % ring.length;
        visit(ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!);
      }
    }
  };
  const edges = new Set<string>();
  eachEdge((ax, az, bx, bz) => edges.add(`${key(ax, az)}>${key(bx, bz)}`));
  const walls: Wall[] = [];
  const startingAt = new Map<string, Wall>();
  const endingAt = new Map<string, Wall>();
  eachEdge((ax, az, bx, bz) => {
    const length = Math.hypot(bx - ax, bz - az);
    // Its neighbour walks this edge the other way round: a party wall has nothing to darken.
    if (length < CONTACT.shortest || edges.has(`${key(bx, bz)}>${key(ax, az)}`)) return;
    const wall = { ax, az, bx, bz, length, nx: (bz - az) / length, nz: -(bx - ax) / length };
    walls.push(wall);
    startingAt.set(key(ax, az), wall);
    endingAt.set(key(bx, bz), wall);
  });
  const lifted = (x: number, z: number): V3 => [x, ground(x, z) + CONTACT.lift, z];
  const up: V3 = [0, 1, 0];
  for (const w of walls) {
    const before = endingAt.get(key(w.ax, w.az));
    const after = startingAt.get(key(w.bx, w.bz));
    const square = [w.nx * CONTACT.reach, w.nz * CONTACT.reach] as const;
    const [startX, startZ] = before ? miter(before, w) : square;
    const [endX, endZ] = after ? miter(w, after) : square;
    const taper = Math.min(CONTACT.reach, w.length / 3);
    const first = before ? 0 : taper;
    const last = w.length - (after ? 0 : taper);
    // The wall's foot at `s` metres along it, and the band's outer edge there.
    const at = (s: number) => {
      const u = Math.min(1, Math.max(0, (s - first) / (last - first)));
      const scale = Math.min(1, before ? 1 : s / taper, after ? 1 : (w.length - s) / taper);
      const x = w.ax + ((w.bx - w.ax) * s) / w.length;
      const z = w.az + ((w.bz - w.az) * s) / w.length;
      return [
        x,
        z,
        x + (startX + (endX - startX) * u) * scale,
        z + (startZ + (endZ - startZ) * u) * scale,
      ] as const;
    };
    // In pieces, so a long wall's band follows the ground rather than cutting under a rise.
    const pieces = Math.max(1, Math.ceil((last - first) / CONTACT.piece));
    const stops = before ? [] : [0];
    for (let k = 0; k <= pieces; k++) stops.push(first + (k / pieces) * (last - first));
    if (!after) stops.push(w.length);
    for (let k = 0; k + 1 < stops.length; k++) {
      const [x0, z0, ox0, oz0] = at(stops[k]!);
      const [x1, z1, ox1, oz1] = at(stops[k + 1]!);
      mesh.quad(
        lifted(x0, z0),
        lifted(x1, z1),
        lifted(ox1, oz1),
        lifted(ox0, oz0),
        0,
        up,
        [1, 1, 0, 0],
      );
    }
  }
}

/** The bank of the water: a stone lip, and how dark the water is along it (m). */
export const SHORE = { lip: 0.4, reach: 0.9, y: 0.112, stone: 0x9a9281 } as const;

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
  const up: V3 = [0, 1, 0];
  for (const [r, ring] of water.entries()) {
    const inward = signedArea(ring) > 0 ? -1 : 1;
    for (let i = 0; i < ring.length; i += 2) {
      const j = (i + 2) % ring.length;
      const [ax, az, bx, bz] = [ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!];
      const length = Math.hypot(bx - ax, bz - az);
      if (length < 0.5 || onCut(ax, az, bx, bz)) continue;
      const [ux, uz] = [((bz - az) / length) * inward, (-(bx - ax) / length) * inward];
      // Water that touches other water has no bank there.
      const [mx, mz] = [(ax + bx) / 2 - ux * 0.3, (az + bz) / 2 - uz * 0.3];
      if (water.some((other, o) => o !== r && pointInRing(other, mx, mz))) continue;
      const pieces = Math.max(1, Math.ceil(length / CONTACT.piece));
      for (let k = 0; k < pieces; k++) {
        const [t0, t1] = [k / pieces, (k + 1) / pieces];
        const [x0, z0, x1, z1] = [
          ax + (bx - ax) * t0,
          az + (bz - az) * t0,
          ax + (bx - ax) * t1,
          az + (bz - az) * t1,
        ];
        stone.quad(
          at(x0, z0),
          at(x1, z1),
          at(x1 + ux * SHORE.lip, z1 + uz * SHORE.lip),
          at(x0 + ux * SHORE.lip, z0 + uz * SHORE.lip),
          SHORE.stone,
          up,
        );
        dark.quad(
          at(x0 + ux * SHORE.lip, z0 + uz * SHORE.lip),
          at(x1 + ux * SHORE.lip, z1 + uz * SHORE.lip),
          at(x1 + ux * SHORE.reach, z1 + uz * SHORE.reach),
          at(x0 + ux * SHORE.reach, z0 + uz * SHORE.reach),
          0,
          up,
          [0.8, 0.8, 0, 0],
        );
      }
    }
  }
}

/** A tree pit: its half width, how wide its stone edge is, and how far it lies over the paving. */
export const PIT = { half: 0.8, edge: 0.13, lift: 0.014, soil: 0x5a4432, stone: 0x9a9a95 } as const;

/**
 * A square of soil with a stone edge round a street tree's foot, wherever the ground under it is
 * paved (a pavement, a square, a road's edge): a tree is planted in something, not stood on the
 * asphalt. `ground` is the ground as drawn, and `layer` how high its top layer lies. Only where
 * all of it lies on that one layer: a square laid across a kerb would hide it.
 */
export function addTreePits(
  mesh: MeshBuilder,
  trees: ArrayLike<number>,
  stride: number,
  hard: number,
  ground: (x: number, z: number) => number,
  layer: (x: number, z: number) => number,
): void {
  const up: V3 = [0, 1, 0];
  for (let i = 0; i < trees.length; i += stride) {
    const [x, z] = [trees[i]!, trees[i + 1]!];
    const under = layer(x, z);
    if (under < hard) continue;
    const r = PIT.half + PIT.edge;
    if (![-r, r].every((dx) => [-r, r].every((dz) => layer(x + dx, z + dz) === under))) continue;
    const y = ground(x, z) + PIT.lift;
    const square = (half: number, color: number, over = 0) =>
      mesh.quad(
        [x - half, y + over, z - half],
        [x + half, y + over, z - half],
        [x + half, y + over, z + half],
        [x - half, y + over, z + half],
        color,
        up,
      );
    square(PIT.half + PIT.edge, PIT.stone);
    square(PIT.half, PIT.soil, 0.004);
  }
}
