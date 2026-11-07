import { describe, expect, test } from 'bun:test';

import { unpackCity } from '../data/format.ts';
import { Terrain } from '../data/terrain.ts';
import { WalkGrid } from '../data/walkable.ts';
import { MAX_ZOOM, PITCH, spanOf } from './lod.ts';
import { CHEST, DITHER_GLSL, ditherRadius, ditherShare } from './occlusion.ts';
import type { Vec3 } from './occlusion.ts';

/** The view along a quarter yaw, from the camera into the scene. */
const viewAt = (yaw: number): Vec3 => [
  -Math.sin(yaw) * Math.cos(PITCH),
  -Math.sin(PITCH),
  -Math.cos(yaw) * Math.cos(PITCH),
];
const YAWS = [0, 1, 2, 3].map((k) => Math.PI / 4 + (k * Math.PI) / 2);

describe('the dither in front of the avatar', () => {
  const feet: Vec3 = [0, 0, 0];
  const view = viewAt(YAWS[0]!);
  const radius = ditherRadius(spanOf(MAX_ZOOM));
  /** A point `toward` metres from the chest toward the camera, `aside` metres to its right. */
  const at = (toward: number, aside = 0): Vec3 => [
    -view[0] * toward + Math.cos(YAWS[0]!) * aside,
    CHEST - view[1] * toward,
    -view[2] * toward - Math.sin(YAWS[0]!) * aside,
  ];

  test('drops all of a wall on the line of sight, and less toward the rim', () => {
    expect(ditherShare(at(8), feet, view, radius)).toBe(1);
    const half = ditherShare(at(8, radius * 0.8), feet, view, radius);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(1);
    expect(ditherShare(at(8, radius * 1.1), feet, view, radius)).toBe(0);
  });

  test('spares what is behind the avatar, right beside it, and the street underfoot', () => {
    expect(ditherShare(at(-5), feet, view, radius)).toBe(0);
    expect(ditherShare(at(0.2), feet, view, radius)).toBe(0);
    expect(ditherShare([0.5, 0.1, 0.5], feet, view, radius)).toBe(0);
  });

  test('is off with no radius, as far out where the figure isn’t drawn', () => {
    expect(ditherShare(at(8), feet, view, 0)).toBe(0);
  });

  test('opens a little wider as the view widens', () => {
    expect(ditherRadius(100)).toBeGreaterThan(ditherRadius(14));
  });

  test('the shader says the same', () => {
    expect(DITHER_GLSL).toContain(`vec3(0.0, ${CHEST.toFixed(4)}, 0.0)`);
    expect(DITHER_GLSL).toContain('smoothstep(0.6000 * uAvatar.w, uAvatar.w, lateral)');
  });
});

// The streets round Grote Markt at the closest zoom, from each quarter view: wherever the avatar
// stands, every house between it and the camera along the line to its head, chest, knees and
// sides is dithered away completely, so it is never hidden, not for a moment.
test('round Grote Markt the avatar is never hidden by a house, from any quarter', async () => {
  const response = await fetch(new URL('../../public/data/city.bin', import.meta.url));
  const city = await unpackCity(new Uint8Array(await response.arrayBuffer()));
  const terrain = new Terrain(city.terrain);
  const grid = new WalkGrid(city);
  const radius = ditherRadius(spanOf(MAX_ZOOM));
  let checked = 0;
  let hidden = 0;
  const out: [number, number] = [0, 0];
  // Every street cell's centre a body can stand on (clear of walls), every other metre.
  for (let x = -59.5; x <= 60; x += 2) {
    for (let z = -59.5; z <= 60; z += 2) {
      if (Math.hypot(x, z) > 60 || !grid.street(grid.cellAt(x, z))) continue;
      if (grid.wallOverlap(x, z, 0.45, out) > 0) continue;
      const feet: Vec3 = [x, terrain.height(x, z), z];
      for (const yaw of YAWS) {
        const view = viewAt(yaw);
        const [sx, sz] = [Math.cos(yaw) * 0.4, -Math.sin(yaw) * 0.4];
        const body: Vec3[] = [
          [x, feet[1] + 0.6, z],
          [x, feet[1] + CHEST, z],
          [x, feet[1] + 2.3, z],
          [x + sx, feet[1] + CHEST, z + sz],
          [x - sx, feet[1] + CHEST, z - sz],
        ];
        checked++;
        const seen = body.every((q) => {
          // Toward the camera in half-metre steps, until the ray is over every roof.
          for (let t = 0.5; t < 120; t += 0.5) {
            const p: Vec3 = [q[0] - view[0] * t, q[1] - view[1] * t, q[2] - view[2] * t];
            if (p[1] > terrain.highest + 100) return true;
            const top = terrain.height(p[0], p[2]) + grid.buildingHeight(p[0], p[2]);
            if (grid.buildingHeight(p[0], p[2]) > 0 && p[1] < top) {
              if (ditherShare(p, feet, view, radius) < 1) return false;
            }
          }
          return true;
        });
        if (!seen) hidden++;
      }
    }
  }
  expect(checked).toBeGreaterThan(500);
  expect(hidden).toBe(0);
});
