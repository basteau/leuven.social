import { describe, expect, test } from 'bun:test';

import {
  BIKE_STRIDE,
  ON_BIKE,
  avatarState,
  createAvatar,
  jump,
  paceOf,
  stepAvatar,
} from './avatar.ts';
import type { Ground } from './collide.ts';
import { STRIDE } from './traffic.ts';
import { ON_FOOT, RUN_SPEED, STEP, WALK_SPEED } from './walker.ts';

const open: Ground = { wallOverlap: () => 0, closed: () => 0 };

const steps = (seconds: number) => Math.round(seconds / STEP);

describe('the avatar', () => {
  test('stands idle where it starts, so nothing animates on load', () => {
    const a = createAvatar(3, -2, 1);
    expect(stepAvatar(a, STEP, 0, 0, open)).toBe(false);
    expect(avatarState(a)).toEqual({
      x: 3,
      z: -2,
      facing: 1,
      speed: 0,
      mode: 'foot',
      place: null,
      floor: 0,
    });
  });

  test('its state is plain data, the same after a trip through JSON', () => {
    const a = createAvatar(0, 0);
    for (let i = 0; i < steps(1); i++) stepAvatar(a, STEP, 1, 0, open);
    const state = avatarState(a);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  test('walks and runs at the walker’s paces', () => {
    const a = createAvatar(0, 0);
    for (let i = 0; i < steps(2); i++) stepAvatar(a, STEP, 0, 1, open);
    expect(a.walker.speed).toBeCloseTo(WALK_SPEED);
    for (let i = 0; i < steps(2); i++) stepAvatar(a, STEP, 0, 1, open, true);
    expect(a.walker.speed).toBeCloseTo(RUN_SPEED);
  });

  test('on a bike, faster, and with momentum both ways', () => {
    const [foot, bike] = [createAvatar(0, 0), createAvatar(0, 0)];
    bike.mode = 'bike';
    expect(paceOf('bike')).toBe(ON_BIKE);
    expect(paceOf('foot')).toBe(ON_FOOT);
    for (let i = 0; i < steps(0.5); i++) {
      stepAvatar(foot, STEP, 0, 1, open);
      stepAvatar(bike, STEP, 0, 1, open);
    }
    // Slower off the mark than on foot...
    expect(bike.walker.speed).toBeLessThan(WALK_SPEED);
    for (let i = 0; i < steps(5); i++) stepAvatar(bike, STEP, 0, 1, open);
    // ...but cruising well past a run, and sprinting faster still.
    expect(bike.walker.speed).toBeGreaterThan(RUN_SPEED);
    for (let i = 0; i < steps(6); i++) stepAvatar(bike, STEP, 0, 1, open, true);
    expect(bike.walker.speed).toBeGreaterThan(ON_BIKE.walk + 4);
    // Let go, it coasts on rather than stopping in a stride.
    for (let i = 0; i < steps(0.3); i++) stepAvatar(bike, STEP, 0, 0, open);
    expect(bike.walker.speed).toBeGreaterThan(5);
  });

  test('pedals at the traffic’s cyclists’ stride', () => {
    expect(BIKE_STRIDE).toBe(STRIDE.bike);
    const bike = createAvatar(0, 0);
    bike.mode = 'bike';
    let travelled = 0;
    let turned = 0;
    let last = bike.walker.phase;
    for (let i = 0; i < steps(3); i++) {
      const [x, z] = [bike.walker.x, bike.walker.z];
      stepAvatar(bike, STEP, 0, 1, open);
      travelled += Math.hypot(bike.walker.x - x, bike.walker.z - z);
      turned += (bike.walker.phase - last + Math.PI * 2) % (Math.PI * 2);
      last = bike.walker.phase;
    }
    expect((turned / (Math.PI * 2)) * BIKE_STRIDE).toBeCloseTo(travelled, 1);
  });

  test('jumps somewhere else standing, its route let go', () => {
    const a = createAvatar(0, 0);
    for (let i = 0; i < steps(1); i++) stepAvatar(a, STEP, 1, 0, open);
    a.walker.route = new Float32Array([0, 0, 10, 0]);
    jump(a, 40, 50);
    expect(avatarState(a)).toMatchObject({ x: 40, z: 50, speed: 0 });
    expect(a.walker.route).toBeNull();
  });
});
