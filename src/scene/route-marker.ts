import type { BufferGeometry } from 'three';

import { MeshBuilder } from './mesh-builder.ts';
import { ROUTE } from './palette.ts';

/**
 * The hint for a walk to a picked spot: a quiet trail of small round dots along the way,
 * shrinking toward the end, and a thin ring where it ends, flat on the ground just above the
 * squares. One unlit, half see-through draw call; dots behind the walker drop off by moving
 * the geometry's draw range, so walking never rebuilds it.
 */

const SPACING = 1.8;
/** Room left free around the walker at the start and the target at the end (m). */
const LEAD = 1.4;
/** Dot radius at the start of the trail, and at its end (m). */
const DOT_START = 0.17;
const DOT_END = 0.09;
/** The ring around the target: outer and inner radius, and its centre dot (m). */
const RING = [0.75, 0.62] as const;
const CENTRE = 0.13;
const Y = 0.23;
const UP = [0, 1, 0] as const;
/** Sides of a dot, and of the ring. */
const DOT_SIDES = 6;
const RING_SIDES = 16;
/** Indices per dot, the unit of its draw range: a hexagon, four triangles. */
export const DOT_VERTICES = (DOT_SIDES - 2) * 3;

export interface RouteMarker {
  geometry: BufferGeometry;
  /** Distance along the route of each dot, in drawing order. */
  dots: Float32Array;
}

/** The ground's height at a point. */
type Ground = (x: number, z: number) => number;

/**
 * A corner on the ground, each lifted by the ground under it: a dot is far smaller than the
 * terrain's triangles, so it lies on them without being cut, and keeps its count of vertices.
 */
const corner = (ground: Ground, x: number, z: number, r: number, i: number, sides: number) => {
  const [cx, cz] = [
    x + Math.cos((i * Math.PI * 2) / sides) * r,
    z + Math.sin((i * Math.PI * 2) / sides) * r,
  ];
  return [cx, Y + ground(cx, cz), cz] as const;
};

function disc(mesh: MeshBuilder, ground: Ground, x: number, z: number, r: number, sides: number) {
  for (let i = 1; i < sides - 1; i++) {
    const [a, b, c] = [
      corner(ground, x, z, r, 0, sides),
      corner(ground, x, z, r, i, sides),
      corner(ground, x, z, r, i + 1, sides),
    ];
    mesh.triangle(a, b, c, ROUTE, UP);
  }
}

function ring(mesh: MeshBuilder, ground: Ground, x: number, z: number): void {
  const [outer, inner] = RING;
  for (let i = 0; i < RING_SIDES; i++) {
    const [a, b] = [
      corner(ground, x, z, outer, i, RING_SIDES),
      corner(ground, x, z, outer, i + 1, RING_SIDES),
    ];
    const [c, d] = [
      corner(ground, x, z, inner, i + 1, RING_SIDES),
      corner(ground, x, z, inner, i, RING_SIDES),
    ];
    mesh.quad(a, b, c, d, ROUTE, UP);
  }
}

/** The hint along `route`, on the ground `ground` gives (level by default). */
export function routeMarker(route: Float32Array, ground: Ground = () => 0): RouteMarker {
  const mesh = new MeshBuilder();
  const dots: number[] = [];
  let total = 0;
  for (let i = 0; i + 3 < route.length; i += 2) {
    total += Math.hypot(route[i + 2]! - route[i]!, route[i + 3]! - route[i + 1]!);
  }
  let walked = 0;
  let next = LEAD;
  for (let i = 0; i + 3 < route.length; i += 2) {
    const [ax, az, bx, bz] = [route[i]!, route[i + 1]!, route[i + 2]!, route[i + 3]!];
    const length = Math.hypot(bx - ax, bz - az);
    for (; next <= walked + length && next <= total - LEAD; next += SPACING) {
      const t = (next - walked) / length;
      const r = DOT_START + (DOT_END - DOT_START) * (next / total);
      disc(mesh, ground, ax + (bx - ax) * t, az + (bz - az) * t, r, DOT_SIDES);
      dots.push(next);
    }
    walked += length;
  }
  const [x, z] = [route.at(-2)!, route.at(-1)!];
  ring(mesh, ground, x, z);
  disc(mesh, ground, x, z, CENTRE, DOT_SIDES);
  return { geometry: mesh.build({ keep: true }), dots: Float32Array.from(dots) };
}

/** How many leading indices to skip once the walker has covered `travelled` metres. */
export function passedVertices(marker: RouteMarker, travelled: number): number {
  let passed = 0;
  while (passed < marker.dots.length && marker.dots[passed]! < travelled + 0.3) passed++;
  return passed * DOT_VERTICES;
}
