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
  clearPitch,
  createBoom,
  easeBoom,
  flight,
  freeLength,
  headLook,
  mapYaw,
  reachGoal,
  recentre,
  recentreWeight,
  settleReach,
  spanAt,
  stretchBoom,
  turnBoom,
  wheelKind,
} from './chase.ts';
import type { Lens, Shot, Vec3 } from './chase.ts';

describe('the boom', () => {
  test('starts behind and a little above, and aims within its pitch limits', () => {
    const boom = createBoom(1);
    expect(boom).toMatchObject({ yaw: 1, aimYaw: 1, pitch: PITCH, distance: DISTANCE });
    turnBoom(boom, 2.5, 5);
    expect(boom.aimYaw).toBeCloseTo(3.5 - Math.PI * 2);
    expect(boom.aimPitch).toBe(PITCH_RANGE[1]);
    expect(boom.yaw).toBe(1);
    turnBoom(boom, 0, -5);
    expect(boom.aimPitch).toBe(PITCH_RANGE[0]);
  });

  test('eases to its aim and length in the same time at any frame rate', () => {
    const ends = [30, 60, 120].map((hz) => {
      const boom = createBoom(0);
      turnBoom(boom, 1, 0.3);
      stretchBoom(boom, 2);
      let moving = true;
      for (let i = 0; i < hz / 10; i++) moving = easeBoom(boom, 0, 1 / hz);
      expect(moving).toBe(true);
      // A tenth of a second in, the turn is nearly done; the length takes longer.
      expect(boom.yaw).toBeGreaterThan(0.8);
      expect(boom.length).toBeLessThan(DISTANCE * 1.5);
      for (let i = 0; i < hz * 3; i++) moving = easeBoom(boom, 0, 1 / hz);
      expect(moving).toBe(false);
      return [boom.yaw, boom.pitch, boom.length];
    });
    for (const end of ends) {
      expect(end[0]).toBeCloseTo(1, 3);
      expect(end[1]).toBeCloseTo(PITCH + 0.3, 3);
      expect(end[2]).toBeCloseTo(DISTANCE * 2, 2);
    }
  });

  test('a run lengthens the boom and widens the lens a little', () => {
    const boom = createBoom(0);
    for (let i = 0; i < 120; i++) easeBoom(boom, 1, 1 / 60);
    expect(boom.length).toBeGreaterThan(DISTANCE * 1.1);
    expect(chaseFov(16 / 9, 1)).toBeGreaterThan(chaseFov(16 / 9) + 4);
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

  test('the free length changes smoothly as the walker nears a house, not a step at a time', () => {
    const lengths: number[] = [];
    for (let z = 0; z <= 0.5; z += 0.05)
      lengths.push(freeLength(house, [0, 2.6, z], [0, 0, 1], 20));
    const jumps = lengths.slice(1).map((l, i) => lengths[i]! - l);
    for (const jump of jumps) expect(jump).toBeLessThan(0.1);
    expect(lengths[0]! - lengths.at(-1)!).toBeCloseTo(0.5, 1);
  });

  test('pulls in quickly, at once from inside a house, and lets out gently', () => {
    const quick = settleReach(8, 3, 1 / 60);
    expect(quick).toBeLessThan(7);
    expect(quick).toBeGreaterThan(3);
    let reach = 8;
    for (let i = 0; i < 20; i++) reach = settleReach(reach, 3, 1 / 60);
    expect(reach).toBeCloseTo(3, 1);
    expect(settleReach(8, 3, 1 / 60, true)).toBe(3);
    const out = settleReach(3, 8, 1 / 60);
    expect(out).toBeGreaterThan(3);
    expect(out).toBeLessThan(3.5);
    for (let i = 0; i < 180; i++) reach = settleReach(reach, 8, 1 / 60);
    expect(reach).toBeCloseTo(8, 1);
  });

  test('a corner reaching a whisker starts the pull in before it cuts the view', () => {
    expect(reachGoal(8, 8, 8)).toBe(8);
    expect(reachGoal(8, 4, 8)).toBe(6);
    expect(reachGoal(3, 4, 8)).toBe(3);
  });
});

describe('following', () => {
  test('recentres behind the walker the short way round, and its pitch to the default', () => {
    const boom = createBoom(Math.PI - 0.4); // walker faces +z, so behind is yaw π
    turnBoom(boom, 0, 0.5);
    recentre(boom, 0, 1, 0.5);
    expect(boom.aimYaw).toBeGreaterThan(Math.PI - 0.4);
    expect(boom.aimYaw).toBeLessThan(Math.PI);
    expect(boom.aimPitch).toBeLessThan(PITCH + 0.5);
    for (let i = 0; i < 40; i++) recentre(boom, 0, 1, 0.5);
    expect(Math.abs(boom.aimYaw)).toBeCloseTo(Math.PI);
    expect(boom.aimPitch).toBeCloseTo(PITCH);
    const across = createBoom(Math.PI - 0.2);
    recentre(across, 0.3, 1, 0.5); // behind is yaw -π + 0.3: on through π
    expect(Math.abs(across.aimYaw)).toBeGreaterThan(Math.PI - 0.2);
  });

  test('recentres walking away from the camera, a little sideways, never toward it', () => {
    expect(recentreWeight(0, Math.PI)).toBe(1);
    expect(recentreWeight(Math.PI / 2, Math.PI)).toBeGreaterThan(0);
    expect(recentreWeight(Math.PI / 2, Math.PI)).toBeLessThan(0.1);
    expect(recentreWeight(Math.PI, Math.PI)).toBe(0);
  });

  test('the head looks where the camera looks, or back at the camera in front of it', () => {
    // Camera behind (yaw π for a walker facing +z): straight ahead.
    expect(headLook(0, Math.PI)).toBeCloseTo(0);
    expect(headLook(0, Math.PI - 0.5)).toBeCloseTo(-0.5);
    // Camera in front, a little to the side: the head turns to it.
    expect(headLook(0, 0.3)).toBeCloseTo(0.3);
  });
});

/** A 20 m block from 10 to 20 m out along +z, the way a yaw of 0 points the boom. */
const block = (_x: number, z: number) => (z > 10 && z < 20 ? 20 : 0);

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

  test('climbs over a roof in the way, and only as high as it must', () => {
    const look: Vec3 = [0, 2.6, 0];
    const low = 0.3;
    const pitch = clearPitch(block, look, 0, 200, low);
    expect(pitch).toBeGreaterThan(low);
    const dir = boomDirection(0, pitch, [0, 0, 0]);
    expect(freeLength(block, look, dir, 200)).toBe(200);
    expect(freeLength(block, look, boomDirection(0, pitch - 0.02, [0, 0, 0]), 200)).toBeLessThan(
      200,
    );
    // Nothing in the way, or the camera still short of the house: no climb at all.
    expect(clearPitch(block, look, Math.PI, 200, low)).toBe(low);
    expect(clearPitch(block, look, 0, 8, low)).toBe(low);
    // Walled in on every side, it goes as high as the boom may.
    expect(clearPitch(() => 1e3, look, 0, 50, low)).toBe(PITCH_RANGE[1]);
    expect(clearPitch(block, look, 0, 50, PITCH_RANGE[1] + 0.1)).toBe(PITCH_RANGE[1] + 0.1);
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

test('a trackpad swipe looks around; a pinch or a mouse wheel zooms', () => {
  const at = { deltaMode: 0, deltaX: 0, deltaY: 0, ctrlKey: false };
  expect(wheelKind({ ...at, deltaY: 3, ctrlKey: true })).toBe('pinch');
  expect(wheelKind({ ...at, deltaMode: 1, deltaY: 3 })).toBe('wheel');
  expect(wheelKind({ ...at, deltaX: -4, deltaY: 1 })).toBe('swipe');
  expect(wheelKind({ ...at, deltaY: 100, wheelDeltaY: -120 })).toBe('wheel');
  expect(wheelKind({ ...at, deltaY: -7, wheelDeltaY: 21 })).toBe('swipe');
  expect(wheelKind({ ...at, deltaY: 5 })).toBe('swipe');
});
