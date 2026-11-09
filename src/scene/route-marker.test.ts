import { expect, test } from 'bun:test';
import type { BufferGeometry } from 'three';

import { ROUTE } from './palette.ts';
import { newRouteUniforms, routeMarker, routeShader } from './route-marker.ts';

/** Vertices a dot's disc takes, and the target's three discs. */
const DOT_VERTICES = 6 * 3;
const TARGET_VERTICES = 3 * 18 * 3;

const byte = (unit: number) => Math.round(unit * 255);

/** What the vertex shader does to a vertex: where it lands, at this zoom and this far along. */
function vertices(geometry: BufferGeometry, metres = 0, travelled = 0) {
  const position = geometry.getAttribute('position');
  const corner = geometry.getAttribute('corner');
  const spot = geometry.getAttribute('spot');
  const colour = geometry.getAttribute('color');
  return Array.from({ length: position.count }, (_, i) => {
    const shown = spot.getZ(i) >= travelled;
    const radius = shown ? Math.max(spot.getX(i), spot.getY(i) * metres) : 0;
    return {
      x: position.getX(i) + corner.getX(i) * radius,
      y: position.getY(i) + radius * 0.08,
      z: position.getZ(i) + corner.getY(i) * radius,
      radius,
      centre: [position.getX(i), position.getZ(i)],
      colour: (byte(colour.getX(i)) << 16) | (byte(colour.getY(i)) << 8) | byte(colour.getZ(i)),
    };
  });
}

test('dots run along every leg, clear of both ends, then the target', () => {
  const marker = routeMarker(Float32Array.of(0, 0, 10, 0, 10, 10));
  const dots = Array.from(marker.dots);
  expect(dots[0]).toBeCloseTo(1.4);
  expect(dots.at(-1)!).toBeLessThanOrEqual(20 - 1.4);
  expect(dots.length).toBe(11);
  const all = vertices(marker.geometry);
  expect(all).toHaveLength(dots.length * 2 * DOT_VERTICES + TARGET_VERTICES);
  // The last dot's paper, on the second leg.
  const last = all[(dots.length * 2 - 1) * DOT_VERTICES]!;
  expect(last.centre[0]).toBeCloseTo(10);
  // The target is the last thing drawn, centred on the end.
  for (const v of all.slice(-TARGET_VERTICES)) expect(v.centre).toEqual([10, 10]);
});

test('every triangle faces up, or the camera would cull it', () => {
  const all = vertices(routeMarker(Float32Array.of(0, 0, 20, 0)).geometry, 0.05);
  for (let i = 0; i < all.length; i += 3) {
    const [a, b, c] = [all[i]!, all[i + 1]!, all[i + 2]!];
    const up = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    expect(up).toBeGreaterThan(0);
  }
});

test('all the ink is painted before all the paper, so a rim never cuts a neighbour', () => {
  const marker = routeMarker(Float32Array.of(0, 0, 20, 0));
  const dots = marker.dots.length * DOT_VERTICES;
  const all = vertices(marker.geometry);
  expect(all.slice(0, dots).every((v) => v.colour === ROUTE.ink)).toBe(true);
  expect(all.slice(dots, dots * 2).every((v) => v.colour === ROUTE.paper)).toBe(true);
});

test('the paper sits inside its ink at every zoom', () => {
  const marker = routeMarker(Float32Array.of(0, 0, 20, 0));
  const dots = marker.dots.length * DOT_VERTICES;
  for (const metres of [0.01, 0.2, 1, 4]) {
    const all = vertices(marker.geometry, metres);
    expect(all[dots]!.radius).toBeLessThan(all[0]!.radius);
  }
});

test('from high up a dot keeps its size on screen, and they join up into a line', () => {
  const marker = routeMarker(Float32Array.of(0, 0, 20, 0));
  const close = vertices(marker.geometry, 0.02)[0]!.radius;
  expect(close).toBeCloseTo(0.36); // its size in metres
  const metres = 0.6;
  const far = vertices(marker.geometry, metres)[0]!.radius;
  expect(far / metres).toBeCloseTo(4);
  expect(far * 2).toBeGreaterThan(marker.dots[1]! - marker.dots[0]!);
});

test('a short walk has a target and no dots', () => {
  const marker = routeMarker(Float32Array.of(0, 0, 2, 0));
  expect(marker.dots).toHaveLength(0);
  expect(vertices(marker.geometry)).toHaveLength(TARGET_VERTICES);
});

test('dots drop off as the walker passes them, and the target stays', () => {
  const marker = routeMarker(Float32Array.of(0, 0, 20, 0));
  const shown = (travelled: number) =>
    vertices(marker.geometry, 0, travelled).filter((v) => v.radius > 0).length;
  expect(shown(0)).toBe(marker.dots.length * 2 * DOT_VERTICES + TARGET_VERTICES);
  expect(shown(1.2)).toBe((marker.dots.length - 1) * 2 * DOT_VERTICES + TARGET_VERTICES);
  expect(shown(100)).toBe(TARGET_VERTICES);
});

const tilted = (x: number, z: number) => 0.2 * x - 0.1 * z;

test('on a slope, every dot and the target lie just over the ground', () => {
  const marker = routeMarker(Float32Array.of(0, 0, 10, 0, 10, 10), tilted);
  for (const v of vertices(marker.geometry)) {
    expect(v.y - tilted(v.centre[0]!, v.centre[1]!)).toBeCloseTo(0.23 + v.radius * 0.08);
  }
});

test('the target can stand further on than the route, where a walk in legs really ends', () => {
  const marker = routeMarker(Float32Array.of(0, 0, 20, 0), undefined, [500, 40]);
  for (const v of vertices(marker.geometry).slice(-TARGET_VERTICES)) {
    expect(v.centre).toEqual([500, 40]);
  }
});

test('the shader grows and drops the parts as the tests above assume', () => {
  const shader = routeShader('#include <common>\n#include <begin_vertex>\n');
  expect(shader).toContain('uniform float travelled');
  expect(shader).toContain('uniform float metres');
  expect(shader).toContain('max(spot.x, spot.y * metres)');
  expect(shader).toContain('spot.z >= travelled');
  expect(shader).toContain('radius * 0.08');
  expect(Object.keys(newRouteUniforms()).toSorted()).toEqual(['metres', 'travelled']);
});
