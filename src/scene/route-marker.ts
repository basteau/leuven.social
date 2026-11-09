import { BufferAttribute, BufferGeometry } from 'three';

import { ROUTE } from './palette.ts';

/**
 * The way to a picked spot, drawn on the ground: pale dots ringed in ink, as the HUD is, so it
 * shows on sunlit paving and on a street at night alike, and a target where it ends.
 *
 * Every part has a size in metres and a least size on screen, so from high up the dots run
 * together into one outlined line rather than fading away. All the ink is drawn before all the
 * paper for that: a dot's rim never cuts across its neighbour. One unlit draw call; the sizes and
 * the dots already passed are the vertex shader's (`ROUTE_SHADER`), so neither zooming nor walking
 * touches the geometry.
 */

const SPACING = 1.6;
/** Room left free around the walker at the start and the target at the end (m). */
const LEAD = 1.4;
/** A dot's ink and its paper: radius (m), and the least it comes to on screen (CSS px). */
const DOT_INK = [0.36, 4] as const;
const DOT_PAPER = [0.25, 2.6] as const;
/** The target's discs, painted in this order: radius (m), least radius (px), colour. */
const TARGET = [
  [1, 11, ROUTE.ink],
  [0.84, 9, ROUTE.paper],
  [0.52, 5.5, ROUTE.goal],
] as const;
/** Above the ground, under the walker's feet (m). */
const Y = 0.23;
/** Sides of a dot, and of the target's discs. */
const DOT_SIDES = 8;
const TARGET_SIDES = 20;
/** A dot goes this far (m) before the walker reaches it. */
const PASSED = 0.3;
/** Drawn when however far the walker has gone: the target stays till the end. */
const ALWAYS = 1e9;
/** A disc is a fan of triangles. */
const VERTICES_PER_TRIANGLE = 3;

export interface RouteMarker {
  geometry: BufferGeometry;
  /** Distance along the route of each dot, in drawing order. */
  dots: Float32Array;
}

/** The ground's height at a point. */
type Ground = (x: number, z: number) => number;

/** What the route's vertex shader reads, updated as the view and the walker move. */
export interface RouteUniforms {
  /** How far the walker has gone along the route (m). */
  travelled: { value: number };
  /** How many metres one CSS pixel covers at this zoom. */
  metres: { value: number };
}

export const newRouteUniforms = (): RouteUniforms => ({
  travelled: { value: 0 },
  metres: { value: 0.05 },
});

/**
 * Sets a material's vertex shader to size the parts and drop the dots passed. A part grown past
 * its size in metres rises with it, or a wide disc would sink into a slope.
 */
export function routeShader(vertexShader: string): string {
  return vertexShader
    .replace(
      '#include <common>',
      `#include <common>
      attribute vec2 corner;
      attribute vec3 spot;
      uniform float travelled;
      uniform float metres;`,
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      if (spot.z >= travelled) {
        float radius = max(spot.x, spot.y * metres);
        transformed.xz += corner * radius;
        transformed.y += radius * 0.08;
      }`,
    );
}

/** One disc, flat at (x, y, z), in the parts' arrays. */
interface Disc {
  x: number;
  y: number;
  z: number;
  radius: number;
  least: number;
  along: number;
  colour: number;
  sides: number;
}

const verticesOf = (disc: Disc) => (disc.sides - 2) * VERTICES_PER_TRIANGLE;

function build(discs: readonly Disc[]): BufferGeometry {
  const count = discs.reduce((sum, disc) => sum + verticesOf(disc), 0);
  const positions = new Float32Array(count * 3);
  const corners = new Float32Array(count * 2);
  const spots = new Float32Array(count * 3);
  const colours = new Uint8Array(count * 3);
  let v = 0;
  const put = (disc: Disc, a: number) => {
    positions.set([disc.x, disc.y, disc.z], v * 3);
    corners.set([Math.cos(a), Math.sin(a)], v * 2);
    spots.set([disc.radius, disc.least, disc.along], v * 3);
    colours.set([disc.colour >> 16, (disc.colour >> 8) & 255, disc.colour & 255], v * 3);
    v++;
  };
  for (const disc of discs) {
    const turn = (Math.PI * 2) / disc.sides;
    for (let i = 1; i < disc.sides - 1; i++) {
      // In this order they face up: turning from +x toward +z goes clockwise seen from above.
      put(disc, 0);
      put(disc, (i + 1) * turn);
      put(disc, i * turn);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('corner', new BufferAttribute(corners, 2));
  geometry.setAttribute('spot', new BufferAttribute(spots, 3));
  geometry.setAttribute('color', new BufferAttribute(colours, 3, true));
  return geometry;
}

/**
 * The way along `route`, on the ground `ground` gives (level by default). The target stands at
 * `end`, where the walk really ends when this route is only a leg of it; else at the route's end.
 */
export function routeMarker(
  route: Float32Array,
  ground: Ground = () => 0,
  end: readonly [number, number] = [route.at(-2)!, route.at(-1)!],
): RouteMarker {
  const ink: Disc[] = [];
  const paper: Disc[] = [];
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
      const at = { x, y: Y + ground(x, z), z, along: next - PASSED, sides: DOT_SIDES };
      ink.push({ ...at, radius: DOT_INK[0], least: DOT_INK[1], colour: ROUTE.ink });
      paper.push({ ...at, radius: DOT_PAPER[0], least: DOT_PAPER[1], colour: ROUTE.paper });
      dots.push(next);
    }
    walked += length;
  }
  const [x, z] = end;
  const y = Y + ground(x, z);
  const target = TARGET.map(([radius, least, colour]) => ({
    x,
    y,
    z,
    radius,
    least,
    colour,
    along: ALWAYS,
    sides: TARGET_SIDES,
  }));
  return { geometry: build([...ink, ...paper, ...target]), dots: Float32Array.from(dots) };
}
