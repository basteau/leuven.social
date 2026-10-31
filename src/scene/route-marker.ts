import type { BufferGeometry } from 'three';

import { MeshBuilder } from './mesh-builder.ts';
import { ROUTE } from './palette.ts';

/**
 * The hint for a walk to a picked spot: small inked dots along the way and a target square
 * where it ends, flat on the ground just above the squares. One unlit draw call; dots behind
 * the walker drop off by moving the geometry's draw range, so walking never rebuilds it.
 */

const SPACING = 2.2;
/** Room left free around the walker at the start and the target at the end (m). */
const LEAD = 1.4;
const DOT = 0.5;
const DOT_INK = 0.9;
const Y = 0.23;
const UP = [0, 1, 0] as const;
/** Vertices per dot: an ink square under a pale one, two triangles each. */
export const DOT_VERTICES = 12;

export interface RouteMarker {
  geometry: BufferGeometry;
  /** Distance along the route of each dot, in drawing order. */
  dots: Float32Array;
}

function square(mesh: MeshBuilder, x: number, z: number, size: number, y: number, color: number) {
  const h = size / 2;
  mesh.quad([x - h, y, z - h], [x + h, y, z - h], [x + h, y, z + h], [x - h, y, z + h], color, UP);
}

export function routeMarker(route: Float32Array): RouteMarker {
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
      const [x, z] = [ax + (bx - ax) * t, az + (bz - az) * t];
      square(mesh, x, z, DOT_INK, Y, ROUTE.ink);
      square(mesh, x, z, DOT, Y + 0.01, ROUTE.fill);
      dots.push(next);
    }
    walked += length;
  }
  const [x, z] = [route.at(-2)!, route.at(-1)!];
  square(mesh, x, z, 2.4, Y, ROUTE.ink);
  square(mesh, x, z, 1.8, Y + 0.01, ROUTE.fill);
  square(mesh, x, z, 0.8, Y + 0.02, ROUTE.ink);
  return { geometry: mesh.build(), dots: Float32Array.from(dots) };
}

/** How many leading vertices to skip once the walker has covered `travelled` metres. */
export function passedVertices(marker: RouteMarker, travelled: number): number {
  let passed = 0;
  while (passed < marker.dots.length && marker.dots[passed]! < travelled + 0.3) passed++;
  return passed * DOT_VERTICES;
}
