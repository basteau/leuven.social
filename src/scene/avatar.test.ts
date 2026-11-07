import { describe, expect, test } from 'bun:test';

import { BIKE_STRIDE, ON_BIKE, avatarState, createAvatar, paceOf, stepAvatar } from './avatar.ts';
import type { Ground } from './collide.ts';
import { RoomGrid } from '../data/room-grid.ts';
import { HALL } from '../data/rooms.fixture.ts';
import { parseRooms, standing } from '../data/rooms.ts';
import { Router } from '../data/route.ts';
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

  test('on a bike, the same handling, faster', () => {
    const [foot, bike] = [createAvatar(0, 0), createAvatar(0, 0)];
    bike.mode = 'bike';
    expect(paceOf('bike')).toBe(ON_BIKE);
    expect(paceOf('foot')).toBe(ON_FOOT);
    expect([ON_BIKE.up, ON_BIKE.down, ON_BIKE.turn]).toEqual([
      ON_FOOT.up,
      ON_FOOT.down,
      ON_FOOT.turn,
    ]);
    for (let i = 0; i < steps(2); i++) {
      stepAvatar(foot, STEP, 0, 1, open);
      stepAvatar(bike, STEP, 0, 1, open);
    }
    expect(bike.walker.speed).toBeCloseTo(ON_BIKE.walk);
    expect(bike.walker.speed).toBeGreaterThan(RUN_SPEED);
    for (let i = 0; i < steps(2); i++) stepAvatar(bike, STEP, 0, 1, open, true);
    expect(bike.walker.speed).toBeCloseTo(ON_BIKE.run);
    // Let go, it stops as a walker does: within a moment.
    for (let i = 0; i < steps(1); i++) stepAvatar(bike, STEP, 0, 0, open);
    expect(bike.walker.speed).toBe(0);
  });

  test('on a bike, it follows a route as a walker does, only faster', () => {
    const bike = createAvatar(0, 0);
    bike.mode = 'bike';
    bike.walker.route = new Float32Array([0, 0, 0, 40]);
    bike.walker.next = 1;
    let t = 0;
    while (bike.walker.route && t < 10) {
      stepAvatar(bike, STEP, 0, 0, open);
      t += STEP;
    }
    expect(bike.walker.z).toBeCloseTo(40, 1);
    // A walker takes about 40 / 5.4 s; a bike far less.
    expect(t).toBeLessThan(40 / WALK_SPEED);
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
});

describe('in a room', () => {
  test('walks up the stair to the gallery and back down, with no step in its height', () => {
    const grids = [new RoomGrid(HALL, 0), new RoomGrid(HALL, 1)];
    const a = createAvatar(9.5, 2, Math.PI / 2);
    const walk = (steerX: number, seconds: number) => {
      let last = standing(HALL, a.floor, a.walker.x, a.walker.z).y;
      let most = 0;
      for (let i = 0; i < steps(seconds); i++) {
        stepAvatar(a, STEP, steerX, 0, grids[a.floor]!);
        const at = standing(HALL, a.floor, a.walker.x, a.walker.z);
        most = Math.max(most, Math.abs(at.y - last));
        [a.floor, last] = [at.level, at.y];
      }
      return most;
    };
    // Up along +x: off the hall floor, up the ramp, onto the gallery.
    expect(walk(1, 3)).toBeLessThan(0.06);
    expect(a.floor).toBe(1);
    expect(a.walker.x).toBeGreaterThan(17);
    expect(standing(HALL, a.floor, a.walker.x, a.walker.z).y).toBe(4);
    // And back down.
    expect(walk(-1, 3)).toBeLessThan(0.06);
    expect(a.floor).toBe(0);
    expect(a.walker.x).toBeLessThan(11);
  });

  test('the gallery’s balustrade and the hall’s walls keep it in', () => {
    const grid = new RoomGrid(HALL, 0);
    const a = createAvatar(5, 8, 0);
    for (let i = 0; i < steps(3); i++) stepAvatar(a, STEP, 0, 1, grid);
    // The south wall is at 11.5, its doorway further east: it stops short of it.
    expect(a.walker.z).toBeLessThan(11.2);
  });
});

test('in Sint-Pieterskerk, a route leads from the door to the stair, and the stair to the gallery', async () => {
  const rooms = parseRooms(
    await (await fetch(new URL('../../public/data/rooms.json', import.meta.url))).json(),
  );
  const church = rooms.find((r) => r.id === 'sint-pieterskerk')!;
  const stair = church.floors[0]!.stairs[0]!;
  const [ux, uz] = [Math.sin(stair.angle), Math.cos(stair.angle)];
  const foot = [stair.x - ux * (stair.depth / 2 + 0.6), stair.z - uz * (stair.depth / 2 + 0.6)];
  const { door } = church;
  const inside = [door.x + Math.sin(door.facing) * 3, door.z + Math.cos(door.facing) * 3];
  const grids = [new RoomGrid(church, 0), new RoomGrid(church, 1)];
  const route = new Router(grids[0]!).route(inside[0]!, inside[1]!, foot[0]!, foot[1]!);
  expect(route).not.toBeNull();
  const a = createAvatar(foot[0]!, foot[1]!, stair.angle);
  for (let i = 0; i < steps(4); i++) {
    stepAvatar(a, STEP, ux, uz, grids[a.floor]!);
    a.floor = standing(church, a.floor, a.walker.x, a.walker.z).level;
  }
  expect(a.floor).toBe(1);
});
