import { describe, expect, test } from 'bun:test';

import {
  CHASE_FOV,
  DISTANCE,
  DISTANCE_RANGE,
  MAP_FOV,
  PITCH,
  PITCH_RANGE,
  boomDirection,
  chaseFov,
  createBoom,
  flight,
  freeLength,
  headLook,
  mapYaw,
  settleReach,
  spanAt,
  stretchBoom,
  swingBehind,
  turnBoom,
} from './chase.ts';
import type { Lens, Shot, Vec3 } from './chase.ts';

describe('the boom', () => {
  test('starts behind and a little above, and turns within its pitch limits', () => {
    const boom = createBoom(1);
    expect(boom).toEqual({ yaw: 1, pitch: PITCH, distance: DISTANCE, reach: DISTANCE });
    turnBoom(boom, 2.5, 5);
    expect(boom.yaw).toBeCloseTo(3.5 - Math.PI * 2);
    expect(boom.pitch).toBe(PITCH_RANGE[1]);
    turnBoom(boom, 0, -5);
    expect(boom.pitch).toBe(PITCH_RANGE[0]);
  });

  test('stretches within its length limits', () => {
    const boom = createBoom(0);
    stretchBoom(boom, 2);
    expect(boom.distance).toBeCloseTo(DISTANCE * 2);
    stretchBoom(boom, 100);
    expect(boom.distance).toBe(DISTANCE_RANGE[1]);
    stretchBoom(boom, 0.001);
    expect(boom.distance).toBe(DISTANCE_RANGE[0]);
  });

  test('points out behind the walker: yaw 0 is toward +z, pitch lifts it', () => {
    const out: Vec3 = [0, 0, 0];
    expect(boomDirection(0, 0, out)).toEqual([0, 0, 1]);
    const [x, y, z] = boomDirection(Math.PI / 2, Math.PI / 6, out);
    expect([x, y, z].map((v) => +v.toFixed(6))).toEqual([
      +Math.cos(Math.PI / 6).toFixed(6),
      0.5,
      0,
    ]);
  });
});

/** A house 10 m tall from z = 5 to 8, open street elsewhere. */
const house = (_x: number, z: number) => (z >= 5 && z <= 8 ? 10 : 0);

describe('walls and the ground', () => {
  test('the boom stops short of a house behind the walker', () => {
    const free = freeLength(house, [0, 2.6, 0], [0, 0, 1], 20);
    expect(free).toBeLessThan(5);
    expect(free).toBeGreaterThan(3.5);
  });

  test('over the roof, or with open street behind, it reaches all the way', () => {
    expect(freeLength(house, [0, 2.6, 0], [0, 0.9, Math.sqrt(0.19)], 20)).toBe(20);
    expect(freeLength(house, [0, 2.6, 0], [0, 0, -1], 20)).toBe(20);
  });

  test('looking up, the boom stops above the ground, and never shrinks to nothing', () => {
    const free = freeLength(() => 0, [0, 2.6, 0], [0, -0.5, Math.sqrt(0.75)], 20);
    expect(free).toBeLessThan(4.2);
    expect(free).toBeGreaterThan(3);
    expect(freeLength(() => 99, [0, 2.6, 0], [0, 0, 1], 20)).toBe(0.5);
  });

  test('a boom rising above every roof stops looking, however long it is', () => {
    let lookups = 0;
    const count = () => {
      lookups++;
      return 0;
    };
    expect(freeLength(count, [0, 2.6, 0], [0, 0.6, 0.8], 4000)).toBe(4000);
    expect(lookups).toBeLessThan(400);
  });

  test('pulls in at once and lets out gently', () => {
    expect(settleReach(8, 3, 1 / 60)).toBe(3);
    const out = settleReach(3, 8, 1 / 60);
    expect(out).toBeGreaterThan(3);
    expect(out).toBeLessThan(3.5);
    let reach = 3;
    for (let i = 0; i < 120; i++) reach = settleReach(reach, 8, 1 / 60);
    expect(reach).toBeCloseTo(8, 1);
  });
});

describe('following', () => {
  test('swings behind the walker at a bounded rate, the short way round', () => {
    const boom = createBoom(0);
    swingBehind(boom, 0, 1, 0.5); // walker faces +z, so behind is yaw π
    expect(Math.abs(boom.yaw)).toBeCloseTo(0.5);
    for (let i = 0; i < 10; i++) swingBehind(boom, 0, 1, 0.5);
    expect(Math.abs(boom.yaw)).toBeCloseTo(Math.PI);
    const left = createBoom(Math.PI - 0.2);
    swingBehind(left, 0, 1, 0.1);
    expect(left.yaw).toBeCloseTo(Math.PI - 0.1);
  });

  test('the head looks where the camera looks, or back at the camera in front of it', () => {
    // Camera behind (yaw π for a walker facing +z): straight ahead.
    expect(headLook(0, Math.PI)).toBeCloseTo(0);
    expect(headLook(0, Math.PI - 0.5)).toBeCloseTo(-0.5);
    // Camera in front, a little to the side: the head turns to it.
    expect(headLook(0, 0.3)).toBeCloseTo(0.3);
  });
});

describe('the flight between map and street', () => {
  const map: Shot = { look: [0, 0, 0], yaw: 0.8, pitch: 0.6, fov: MAP_FOV, span: 400 };
  const street: Shot = { look: [10, 2.6, 4], yaw: 0.8, pitch: 0.3, fov: CHASE_FOV, span: 8 };
  const lens: Lens = { look: [0, 0, 0], yaw: 0, pitch: 0, fov: 0, distance: 0 };

  test('starts on the map and ends behind the walker', () => {
    flight(map, street, 0, lens);
    expect(lens.look).toEqual([0, 0, 0]);
    expect([lens.pitch, lens.fov]).toEqual([0.6, MAP_FOV]);
    expect(spanAt(lens.distance, lens.fov)).toBeCloseTo(400);
    flight(map, street, 1, lens);
    expect(lens.look).toEqual([10, 2.6, 4]);
    expect([lens.pitch, lens.fov]).toEqual([0.3, CHASE_FOV]);
    expect(spanAt(lens.distance, lens.fov)).toBeCloseTo(8);
  });

  test('closes in steadily, without overshooting, and clamps its progress', () => {
    let last = Infinity;
    for (let t = 0; t <= 1; t += 0.05) {
      flight(map, street, t, lens);
      const span = spanAt(lens.distance, lens.fov);
      expect(span).toBeLessThanOrEqual(last + 1e-9);
      last = span;
    }
    flight(map, street, 2, lens);
    expect(lens.fov).toBe(CHASE_FOV);
  });

  test('turns the short way round', () => {
    flight({ ...map, yaw: 3 }, { ...street, yaw: -3 }, 0.5, lens);
    expect(Math.abs(lens.yaw)).toBeCloseTo(Math.PI);
  });

  test('the map turns back to its nearest quarter view', () => {
    expect(mapYaw(Math.PI / 4 + 0.3)).toBeCloseTo(Math.PI / 4);
    expect(mapYaw(Math.PI - 0.1)).toBeCloseTo((3 * Math.PI) / 4);
    expect(mapYaw(-0.1)).toBeCloseTo(-Math.PI / 4);
  });
});

test('tall screens get a wider lens, so a phone still sees the street either side', () => {
  expect(chaseFov(16 / 9)).toBe(CHASE_FOV);
  expect(chaseFov(390 / 844)).toBeGreaterThan(80);
  const side = 2 * Math.atan(Math.tan((chaseFov(390 / 844) * Math.PI) / 360) * (390 / 844));
  expect((side * 180) / Math.PI).toBeCloseTo(44);
});
