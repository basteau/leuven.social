import { ShapeUtils, Vector2 } from 'three';

import { PROP_SIZES, stairCorners } from '../data/rooms.ts';
import type { Floor, Room, RoomProp, RoomWall } from '../data/rooms.ts';
import { LineBuilder, MeshBuilder } from './mesh-builder.ts';
import type { V3 } from './mesh-builder.ts';
import { GROUND, LANDMARK, PROPS } from './palette.ts';
import { at, box, prism } from './prop-shapes.ts';
import type { Frame } from './prop-shapes.ts';

/**
 * A room's floors, drawn: each floor is a mesh and its ink of its own (two draw calls), so which
 * show is a boolean, and each carries its own bounds. A floor is its slab (no ceiling: the floor
 * above is hidden, so none is ever seen), its walls, its furnishings and the stairs up from it,
 * in the facade palette, a couple of thousand triangles. Walls are solid slabs 30 cm thick, each
 * face turned out from the slab, so from inside a room the camera sees the face that looks into
 * it, and the outer walls' inner faces stand just inside the building's own, which only show
 * their outside. Never double-sided: that doubles the fragment work and breaks the ink.
 */

/** Half a wall's thickness (m), as the room's grid meets it. */
const WALL_HALF = 0.15;
/** A slab's thickness under an upper floor (m), and how far its top sits over its level. */
const SLAB = 0.35;
const TOP = 0.03;
/** A step's rise, about (m). */
const STEP = 0.3;

/** Colours: the facade palette indoors too, one look for the city. */
const STONE = LANDMARK.limestone;
const TRIM = LANDMARK.trim;
const WOOD = PROPS.wood;
const IRON = PROPS.iron;
/** Belgian bluestone underfoot, as on the kerbs outside. */
const FLOOR = GROUND.kerb;
const BOARDS = PROPS.wood;

const UP: V3 = [0, 1, 0];

/** A furnishing's frame: v along the way it faces, u across, at its spot, life size. */
const frameOf = (p: RoomProp): Frame => ({
  x: p.x,
  z: p.z,
  fx: Math.sin(p.angle),
  fz: Math.cos(p.angle),
  scale: 1,
});

/** A ring, flat [x, z, …], as points at height y. */
const points = (ring: readonly number[], y: number) =>
  Array.from({ length: ring.length / 2 }, (_, i): V3 => [ring[i * 2]!, y, ring[i * 2 + 1]!]);
const vectors = (ring: readonly number[]) =>
  Array.from({ length: ring.length / 2 }, (_, i) => new Vector2(ring[i * 2]!, ring[i * 2 + 1]!));

/** The slab's top, with its holes, and on an upper floor its edges down to its underside. */
function addSlab(mesh: MeshBuilder, lines: LineBuilder, floor: Floor): void {
  const colour = floor.level === 0 ? FLOOR : BOARDS;
  const all = [...points(floor.slab, TOP), ...floor.holes.flatMap((h) => points(h, TOP))];
  const faces = ShapeUtils.triangulateShape(vectors(floor.slab), floor.holes.map(vectors));
  mesh.polygon(all, faces, colour, UP);
  if (floor.level === 0) return;
  // Edges: out of the slab round its outline, into each hole round a hole.
  for (const [ring, sign] of [
    [floor.slab, 1],
    ...floor.holes.map((h) => [h, -1] as const),
  ] as const) {
    const n = ring.length / 2;
    const ccw = signedArea(ring) > 0 ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [ax, az, bx, bz] = [ring[i * 2]!, ring[i * 2 + 1]!, ring[j * 2]!, ring[j * 2 + 1]!];
      const out: V3 = [(bz - az) * ccw * sign, 0, -(bx - ax) * ccw * sign];
      mesh.quad([ax, -SLAB, az], [bx, -SLAB, bz], [bx, TOP, bz], [ax, TOP, az], TRIM, out);
      lines.segment([ax, TOP, az], [bx, TOP, bz]);
    }
  }
}

/** Twice the signed area of a ring in (x, z): positive counter-clockwise. */
function signedArea(ring: readonly number[]): number {
  let sum = 0;
  for (let i = 0, n = ring.length / 2, j = n - 1; i < n; j = i++) {
    sum += ring[j * 2]! * ring[i * 2 + 1]! - ring[i * 2]! * ring[j * 2 + 1]!;
  }
  return sum;
}

/** A wall between its gaps, each piece a slab 30 cm thick with its faces turned out of it. */
export function addWall(mesh: MeshBuilder, lines: LineBuilder, w: RoomWall, height: number): void {
  const length = Math.hypot(w.x1 - w.x0, w.z1 - w.z0);
  if (length < 1e-6) return;
  const [ux, uz] = [(w.x1 - w.x0) / length, (w.z1 - w.z0) / length];
  const [nx, nz] = [uz * WALL_HALF, -ux * WALL_HALF];
  const tall = w.height ?? height;
  const piece = (a: number, b: number) => {
    const [ax, az, bx, bz] = [w.x0 + ux * a, w.z0 + uz * a, w.x0 + ux * b, w.z0 + uz * b];
    const c = [
      [ax + nx, az + nz],
      [bx + nx, bz + nz],
      [bx - nx, bz - nz],
      [ax - nx, az - nz],
    ] as const;
    for (let i = 0; i < 4; i++) {
      const [p, q] = [c[i]!, c[(i + 1) % 4]!];
      const mid = [(p[0] + q[0]) / 2 - (ax + bx) / 2, (p[1] + q[1]) / 2 - (az + bz) / 2];
      mesh.quad([p[0], 0, p[1]], [q[0], 0, q[1]], [q[0], tall, q[1]], [p[0], tall, p[1]], STONE, [
        mid[0]!,
        0,
        mid[1]!,
      ]);
    }
    mesh.polygon(
      c.map(([x, z]): V3 => [x, tall, z]),
      [
        [0, 1, 2],
        [0, 2, 3],
      ],
      TRIM,
      UP,
    );
    for (let i = 0; i < 4; i++) {
      const [p, q] = [c[i]!, c[(i + 1) % 4]!];
      lines.segment([p[0], tall, p[1]], [q[0], tall, q[1]]);
    }
    for (const [x, z] of [c[0], c[3], c[1], c[2]]) lines.segment([x, 0, z], [x, tall, z]);
  };
  let from = 0;
  for (const [a, b] of [...w.gaps].toSorted((p, q) => p[0] - q[0]).concat([[length, length]])) {
    if (a > from) piece(from, Math.min(a, length));
    from = Math.max(from, b);
  }
}

/** A furnishing, at the size the grid gives it (`PROP_SIZES`). */
export function addProp(mesh: MeshBuilder, lines: LineBuilder, p: RoomProp, height: number): void {
  const [across, deep, tall0] = PROP_SIZES[p.kind] ?? [1, 1, 1];
  const tall = tall0 || height;
  const f = frameOf(p);
  const [hu, hv] = [across / 2, deep / 2];
  const outline = (u: number, v: number, y: number) => {
    const c = [at(f, -u, -v, y), at(f, u, -v, y), at(f, u, v, y), at(f, -u, v, y)];
    for (let i = 0; i < 4; i++) lines.segment(c[i]!, c[(i + 1) % 4]!);
  };
  switch (p.kind) {
    case 'pew':
      // A seat, and its back behind whoever sits facing forward.
      box(mesh, f, [-hu, hu], [-hv, hv * 0.4], [0, 0.45], WOOD);
      box(mesh, f, [-hu, hu], [-hv, -hv + 0.12], [0, tall], WOOD);
      outline(hu, hv, 0.45);
      break;
    case 'altar':
      box(mesh, f, [-hu, hu], [-hv, hv], [0, tall - 0.08], STONE);
      box(mesh, f, [-hu - 0.05, hu + 0.05], [-hv - 0.05, hv + 0.05], [tall - 0.08, tall], TRIM);
      outline(hu + 0.05, hv + 0.05, tall);
      break;
    case 'pulpit':
      prism(mesh, f, [0, 0], [hu * 0.4, hv * 0.4], [0, tall - 1.1], STONE, 1, 8);
      prism(mesh, f, [0, 0], [hu, hv], [tall - 1.1, tall], WOOD, 1, 8);
      outline(hu * 0.7, hv * 0.7, tall);
      break;
    case 'pillar':
      prism(mesh, f, [0, 0], [hu, hv], [0, tall], STONE, 1, 8, false);
      prism(mesh, f, [0, 0], [hu * 1.2, hv * 1.2], [tall - 0.3, tall], TRIM, 1, 8);
      break;
    case 'organ':
      box(mesh, f, [-hu, hu], [-hv, hv], [0, 1.4], WOOD);
      // Its pipes, tallest in the middle.
      for (let i = 0; i < 9; i++) {
        const u = -hu + 0.4 + (i * (across - 0.8)) / 8;
        const h = 1.4 + (tall - 1.4) * (1 - Math.abs(i - 4) / 6);
        prism(mesh, f, [u, -hv + 0.3], [0.16, 0.16], [1.4, h], TRIM, 1, 6);
      }
      outline(hu, hv, 1.4);
      break;
    case 'candles':
      prism(mesh, f, [0, 0], [0.06, 0.06], [0, tall], IRON);
      prism(mesh, f, [0, 0], [hu, hv], [tall, tall + 0.08], PROPS.lantern, 1, 6);
      break;
    default:
      box(mesh, f, [-hu, hu], [-hv, hv], [0, tall], p.kind === 'font' ? STONE : WOOD);
      outline(hu, hv, tall);
  }
}

const lerp = (p: number, q: number, t: number) => p + (q - p) * t;

/** A flight of steps from its floor's level up `rise` metres. */
export function addStair(
  mesh: MeshBuilder,
  lines: LineBuilder,
  corners: number[],
  rise: number,
): void {
  const steps = Math.max(2, Math.round(rise / STEP));
  const [ax, az, bx, bz, cx, cz, dx, dz] = corners as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  for (let k = 0; k < steps; k++) {
    const [t0, t1] = [k / steps, (k + 1) / steps];
    // Foot left and right, top right and left, of this step's tread.
    const ring = [
      lerp(ax, dx, t0),
      lerp(az, dz, t0),
      lerp(bx, cx, t0),
      lerp(bz, cz, t0),
      lerp(bx, cx, t1),
      lerp(bz, cz, t1),
      lerp(ax, dx, t1),
      lerp(az, dz, t1),
    ];
    const y = (rise * (k + 1)) / steps;
    const pts = points(ring, y);
    mesh.polygon(
      pts,
      [
        [0, 1, 2],
        [0, 2, 3],
      ],
      BOARDS,
      UP,
    );
    const [p, q] = [pts[0]!, pts[1]!];
    const front: V3 = [ax - dx, 0, az - dz];
    mesh.quad([p[0], y - rise / steps, p[2]], [q[0], y - rise / steps, q[2]], q, p, WOOD, front);
    lines.segment(p, q);
    // Its sides, down to the floor.
    for (const [i, j] of [
      [0, 3],
      [1, 2],
    ] as const) {
      const [u, v] = [pts[i]!, pts[j]!];
      const side: V3 = i === 0 ? [ax - bx, 0, az - bz] : [bx - ax, 0, bz - az];
      mesh.quad([u[0], 0, u[2]], [v[0], 0, v[2]], v, u, TRIM, side);
    }
  }
  lines.segment([ax, rise / steps, az], [dx, rise, dz]);
  lines.segment([bx, rise / steps, bz], [cx, rise, cz]);
}

/**
 * One floor of a room, at `foot` (the building's floor in the street's frame, m): its mesh and
 * its ink, lifted to the floor's height, written after whatever the builders hold already (the
 * ground floor takes the building's walls, cut down, in the same draw call).
 */
export function buildFloor(
  room: Room,
  floor: Floor,
  foot: number,
  mesh = new MeshBuilder(),
  lines = new LineBuilder(),
): {
  mesh: MeshBuilder;
  lines: LineBuilder;
} {
  mesh.lift = lines.lift = foot + floor.y;
  addSlab(mesh, lines, floor);
  for (const w of floor.walls) addWall(mesh, lines, w, floor.height);
  for (const p of floor.props) addProp(mesh, lines, p, floor.height);
  for (const s of floor.stairs) {
    const to = room.floors.find((f) => f.level === s.to);
    if (to) addStair(mesh, lines, stairCorners(s), to.y - floor.y);
  }
  return { mesh, lines };
}

/**
 * The building's whole footprint as a floor at `foot`, a hair under the room's slab: with the
 * roof lifted, no corner of the building between its buttresses and chapels shows the ground.
 * Nobody walks there (the room's grid is its slab), but nothing looks unfinished.
 */
export function addUnderfloor(mesh: MeshBuilder, ring: ArrayLike<number>, foot: number): void {
  const flat = Array.from(ring);
  mesh.lift = foot;
  mesh.polygon(points(flat, 0), ShapeUtils.triangulateShape(vectors(flat), []), FLOOR, UP);
}

/** The door from the street: a dark arch on the outside of its wall, 2.4 m wide, 3.4 tall. */
export function buildDoor(room: Room, foot: number): MeshBuilder {
  const mesh = new MeshBuilder();
  mesh.lift = foot;
  const { x, z, facing } = room.door;
  const [fx, fz] = [Math.sin(facing), Math.cos(facing)];
  const [rx, rz] = [fz, -fx];
  // A hair outside the wall, facing the street.
  const [ox, oz] = [x - fx * 0.12, z - fz * 0.12];
  const p = (a: number, y: number): V3 => [ox + rx * a, y, oz + rz * a];
  const out: V3 = [-fx, 0, -fz];
  mesh.quad(p(-1.2, 0), p(1.2, 0), p(1.2, 2.4), p(-1.2, 2.4), PROPS.wheel, out);
  // The pointed arch over it, and its stone surround.
  mesh.triangle(p(-1.2, 2.4), p(1.2, 2.4), p(0, 3.4), PROPS.wheel, out);
  const q = (a: number, y: number): V3 => [ox - fx * 0.02 + rx * a, y, oz - fz * 0.02 + rz * a];
  mesh.quad(q(-1.45, 0), q(-1.2, 0), q(-1.2, 2.4), q(-1.45, 2.5), TRIM, out);
  mesh.quad(q(1.2, 0), q(1.45, 0), q(1.45, 2.5), q(1.2, 2.4), TRIM, out);
  return mesh;
}
