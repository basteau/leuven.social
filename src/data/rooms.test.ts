import { describe, expect, test } from 'bun:test';

import { RoomGrid } from './room-grid.ts';
import {
  RoomLoadError,
  ceiling,
  floorAt,
  parseRooms,
  propFootprint,
  roomProblems,
  selfIntersects,
  stairAt,
  stairCorners,
  standing,
} from './rooms.ts';
import { HALL } from './rooms.fixture.ts';

const BUILDING = { id: 7, ring: [0, 0, 20, 0, 20, 12, 0, 12], landmark: true };

describe('reading rooms.json', () => {
  test('takes a well-formed list of rooms', () => {
    expect(parseRooms(JSON.parse(JSON.stringify([HALL])))).toEqual([HALL]);
  });

  test('refuses anything malformed, with words for a person', () => {
    for (const bad of [
      {},
      [{ id: 'x' }],
      [{ ...HALL, door: null }],
      [{ ...HALL, floors: [] }],
      [{ ...HALL, floors: [{ ...HALL.floors[0], slab: ['a'] }] }],
    ]) {
      expect(() => parseRooms(bad)).toThrow(RoomLoadError);
    }
    expect(new RoomLoadError().message).toContain('doors stay shut');
  });
});

describe('checking a room against the city', () => {
  test('a room that fits has no problems', () => {
    expect(roomProblems(HALL, BUILDING)).toEqual([]);
  });

  test('says when the building is missing or no landmark', () => {
    expect(roomProblems(HALL, undefined)[0]).toContain('no building 7');
    expect(roomProblems(HALL, { ...BUILDING, landmark: false })[0]).toContain('not a landmark');
  });

  test('says when a ring reaches out of the footprint or crosses itself', () => {
    const out = structuredClone(HALL);
    out.floors[0]!.slab[2] = 25;
    expect(roomProblems(out, BUILDING).join()).toContain('out of the footprint');
    const bow = structuredClone(HALL);
    bow.floors[1]!.slab = [14, 0.5, 19.5, 11.5, 19.5, 0.5, 14, 11.5];
    expect(roomProblems(bow, BUILDING).join()).toContain('crosses itself');
  });

  test('says when the door is in no gap, or a stair leads nowhere', () => {
    const shut = structuredClone(HALL);
    shut.floors[0]!.walls[0]!.gaps = [];
    expect(roomProblems(shut, BUILDING).join()).toContain('door is in no gap');
    const nowhere = structuredClone(HALL);
    nowhere.floors[0]!.stairs[0]!.to = 3;
    expect(roomProblems(nowhere, BUILDING).join()).toContain('leads to no floor');
    const short = structuredClone(HALL);
    short.floors[0]!.stairs[0]!.x = 8;
    expect(roomProblems(short, BUILDING).join()).toContain('arrive on floor 1');
  });

  test('says when a furnishing is unknown or off its floor', () => {
    const odd = structuredClone(HALL);
    odd.floors[0]!.props.push({ kind: 'throne', x: 5, z: 5, angle: 0 });
    odd.floors[1]!.props.push({ kind: 'chair', x: 5, z: 5, angle: 0 });
    const said = roomProblems(odd, BUILDING).join();
    expect(said).toContain('throne');
    expect(said).toContain('chair on floor 1 stands off');
  });

  test('says when floors share a level or there is no ground floor', () => {
    const twins = structuredClone(HALL);
    twins.floors[1]!.level = 0;
    expect(roomProblems(twins, BUILDING).join()).toContain('share a level');
    const up = structuredClone(HALL);
    up.floors[0]!.level = 2;
    expect(roomProblems(up, BUILDING).join()).toContain('no ground floor');
  });

  test('a self-crossing needs edges that really cross', () => {
    expect(selfIntersects([0, 0, 1, 0, 1, 1, 0, 1])).toBe(false);
    expect(selfIntersects([0, 0, 1, 1, 1, 0, 0, 1])).toBe(true);
  });
});

describe('floors and stairs', () => {
  const stair = HALL.floors[0]!.stairs[0]!;

  test('a stair runs from its foot to its top along its angle', () => {
    const c = stairCorners(stair);
    expect(c[0]).toBeCloseTo(11);
    expect(c[4]).toBeCloseTo(17);
    expect(stairAt(stair, 11, 2)).toBeCloseTo(0);
    expect(stairAt(stair, 14, 2)).toBeCloseTo(0.5);
    expect(stairAt(stair, 17, 2)).toBeCloseTo(1);
    expect(stairAt(stair, 14, 5)).toBeNaN();
    expect(stairAt(stair, 14, 2.5)).toBeCloseTo(0.5);
  });

  test('the avatar rises along it and changes floor halfway up, both ways', () => {
    expect(standing(HALL, 0, 5, 5)).toEqual({ level: 0, y: 0 });
    expect(standing(HALL, 0, 12.5, 2)).toEqual({ level: 0, y: 1 });
    expect(standing(HALL, 0, 15.5, 2)).toEqual({ level: 1, y: 3 });
    expect(standing(HALL, 1, 12.5, 2)).toEqual({ level: 0, y: 1 });
    expect(standing(HALL, 1, 18, 8)).toEqual({ level: 1, y: 4 });
    // Smooth all the way: no step bigger than the slope allows.
    let last = 0;
    let level = 0;
    for (let x = 10; x <= 18; x += 0.05) {
      const now = standing(HALL, level, x, 2);
      expect(Math.abs(now.y - last)).toBeLessThan(0.05);
      [last, level] = [now.y, now.level];
    }
    expect(level).toBe(1);
  });

  test('a floor by level, and the walls once the roof is lifted', () => {
    expect(floorAt(HALL, 1)?.name).toBe('Gallery');
    expect(floorAt(HALL, 4)).toBeUndefined();
    expect(ceiling(HALL)).toBe(7);
  });

  test('a furnishing’s footprint turns with it', () => {
    const pew = propFootprint({ kind: 'pew', x: 0, z: 0, angle: 0 });
    // Facing +z: 3.2 across in x, 0.7 deep in z.
    expect(Math.max(...pew.filter((_, i) => i % 2 === 0))).toBeCloseTo(1.6);
    expect(Math.max(...pew.filter((_, i) => i % 2 === 1))).toBeCloseTo(0.35);
    const odd = propFootprint({ kind: 'thing', x: 0, z: 0, angle: 0 });
    expect(Math.max(...odd)).toBeCloseTo(0.5);
  });
});

describe('a room’s walk grid', () => {
  const ground = new RoomGrid(HALL, 0);
  const gallery = new RoomGrid(HALL, 1);
  const out: [number, number] = [0, 0];

  test('opens its slab, its threshold and its stairs; closes furnishings and holes', () => {
    expect(ground.walkable(3, 3)).toBe(true);
    expect(ground.walkable(10, 12.4)).toBe(true); // the threshold, past the slab
    expect(ground.walkable(3, 12.4)).toBe(false);
    expect(ground.walkable(6, 6)).toBe(false); // the pew
    expect(gallery.walkable(15.5, 8)).toBe(true);
    expect(gallery.walkable(15, 2)).toBe(true); // the stair through its hole
    expect(gallery.walkable(10, 6)).toBe(false); // over the hall
    expect(ground.cols).toBeGreaterThan(40);
    expect(ground.rows).toBeGreaterThan(20);
    const [x, z] = ground.centre(ground.cellAt(3.1, 3.1));
    expect(Math.abs(x - 3.1)).toBeLessThanOrEqual(0.25);
    expect(Math.abs(z - 3.1)).toBeLessThanOrEqual(0.25);
  });

  test('its walls are met as drawn, but in their gaps', () => {
    expect(ground.wallOverlap(5, 11.2, 0.45, out)).toBeGreaterThan(0);
    expect(out[1]).toBeLessThan(0);
    expect(ground.wallOverlap(10, 11.5, 0.45, out)).toBe(0);
    expect(ground.wallOverlap(10, 6, 0.45, out)).toBe(0);
  });

  test('a stair is a corridor between rails, shut at its top end below', () => {
    expect(ground.wallOverlap(14, 2.75, 0.45, out)).toBeGreaterThan(0);
    expect(ground.wallOverlap(17.3, 2, 0.45, out)).toBeGreaterThan(0);
    expect(gallery.wallOverlap(17.3, 2, 0.45, out)).toBe(0);
  });

  test('its edge is closed ground, blended', () => {
    expect(ground.closed(3, 3)).toBe(0);
    expect(gallery.closed(10, 6)).toBe(1);
    expect(ground.nearest(6, 6, 2)).not.toBeNull();
    expect(gallery.nearest(5, 6, 2)).toBeNull();
  });

  test('a wall with doorways in it is met only between them', () => {
    const two = structuredClone(HALL);
    two.floors[0]!.walls[0]!.gaps = [
      [8.3, 10.7],
      [2, 3],
    ];
    const grid = new RoomGrid(two, 0);
    expect(grid.wallOverlap(3, 11.4, 0.3, out)).toBe(0);
    expect(grid.wallOverlap(5, 11.4, 0.4, out)).toBeGreaterThan(0);
  });

  test('a floor that isn’t there is a mistake', () => {
    expect(() => new RoomGrid(HALL, 5)).toThrow('no floor 5');
  });
});
