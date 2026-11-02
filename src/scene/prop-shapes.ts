import type { MeshBuilder, V3 } from './mesh-builder.ts';

/**
 * The few shapes street furniture and monuments are made of, each drawn in a prop's own frame:
 * v along its facing (see `placeProps`), u across it, y up, all times its scale.
 */
export interface Frame {
  x: number;
  z: number;
  /** Facing (v) and side (u) directions in (x, z). */
  fx: number;
  fz: number;
  scale: number;
  /**
   * The ground it stands on, if not level at the mesh's lift: a plane `y` over the lift at
   * (x, z), rising `dx` and `dz` a metre along x and z. A bike stands on it sheared, its wheels
   * upright, so both touch a slope or the kerb between a pavement and a square.
   */
  slope?: Slope;
}

export interface Slope {
  x: number;
  z: number;
  y: number;
  dx: number;
  dz: number;
}

export const at = (f: Frame, u: number, v: number, y: number): V3 => {
  const x = f.x + (-f.fz * u + f.fx * v) * f.scale;
  const z = f.z + (f.fx * u + f.fz * v) * f.scale;
  const s = f.slope;
  return [x, y * f.scale + (s ? s.y + s.dx * (x - s.x) + s.dz * (z - s.z) : 0), z];
};

/**
 * The plane through the ground at a and b (x, z), as a `Slope` over `lift`: level across the
 * line from a to b, so a bike standing along it touches the ground under both wheels.
 */
export function slopeThrough(
  ground: (x: number, z: number) => number,
  lift: number,
  [ax, az]: readonly [number, number],
  [bx, bz]: readonly [number, number],
): Slope {
  const [ya, yb] = [ground(ax, az), ground(bx, bz)];
  const [dx, dz] = [bx - ax, bz - az];
  const k = (yb - ya) / (dx * dx + dz * dz || 1);
  return { x: ax, z: az, y: ya - lift, dx: dx * k, dz: dz * k };
}
export const away = (f: Frame, u: number, v: number, y = 0): V3 => [
  -f.fz * u + f.fx * v,
  y,
  f.fx * u + f.fz * v,
];

/** A convex polygon's triangles, fanned out from its first corner, by its number of corners. */
const FANS: number[][][] = [];
export const fan = (n: number) =>
  (FANS[n] ??= Array.from({ length: n - 2 }, (_, i) => [0, i + 1, i + 2]));

/**
 * An upright prism round (u, v): a ring of corners at y0, the same ring times `taper` at y1, and
 * its end there unless it tapers to a point or `cap` is false (the bottom is never seen). Four
 * sides make a box of half sizes ru by rv; more, a ring of those radii. A y1 below y0 hangs it
 * the other way up: a cone pointing down; a y1 equal to y0 is a flat disc.
 */
export function prism(
  mesh: MeshBuilder,
  f: Frame,
  [u, v]: readonly [number, number],
  [ru, rv]: readonly [number, number],
  [y0, y1]: readonly [number, number],
  color: number,
  taper = 1,
  sides = 4,
  cap = true,
): void {
  const k = sides === 4 ? Math.SQRT2 : 1;
  const ring = (y: number, s: number) =>
    Array.from({ length: sides }, (_, i) => {
      const t = ((i + 0.5) / sides) * Math.PI * 2;
      return at(f, u + Math.cos(t) * ru * k * s, v + Math.sin(t) * rv * k * s, y);
    });
  const [bottom, top] = [ring(y0, 1), ring(y1, taper)];
  // As flat as a sheet of water, it's only its end.
  for (let i = 0; i < (y1 === y0 ? 0 : sides); i++) {
    const j = (i + 1) % sides;
    const t = (j / sides) * Math.PI * 2;
    const out = away(f, Math.cos(t), Math.sin(t));
    if (taper) mesh.quad(bottom[i]!, bottom[j]!, top[j]!, top[i]!, color, out);
    else mesh.triangle(bottom[i]!, bottom[j]!, top[0]!, color, out);
  }
  if (taper && cap) mesh.polygon(top, fan(sides), color, [0, y1 < y0 ? -1 : 1, 0]);
}

/** An upright box: its top (unless `top` is false) and four sides. */
export function box(
  mesh: MeshBuilder,
  f: Frame,
  [u0, u1]: readonly [number, number],
  [v0, v1]: readonly [number, number],
  y: readonly [number, number],
  color: number,
  top = true,
): void {
  prism(
    mesh,
    f,
    [(u0 + u1) / 2, (v0 + v1) / 2],
    [(u1 - u0) / 2, (v1 - v0) / 2],
    y,
    color,
    1,
    4,
    top,
  );
}

/** A thin panel seen from both sides: glass, a bench leg, a wheel, a frame. */
export function panel(mesh: MeshBuilder, corners: readonly V3[], color: number): void {
  const [a, b, c] = corners as [V3, V3, V3];
  const n: V3 = [
    (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
    (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
  ];
  for (const hint of [n, [-n[0], -n[1], -n[2]] as V3]) {
    mesh.polygon(corners, fan(corners.length), color, hint);
  }
}
