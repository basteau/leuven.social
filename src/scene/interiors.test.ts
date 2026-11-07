import { afterEach, describe, expect, test } from 'bun:test';
import { LineBasicMaterial, MeshBasicMaterial, Scene } from 'three';

import { HALL } from '../data/rooms.fixture.ts';
import { RoomLoadError } from '../data/rooms.ts';
import type { Room } from '../data/rooms.ts';
import { createInteriors, loadInteriors } from './interiors.ts';
import type { InteriorsKit } from './interiors.ts';

/** The hall's building, and the ground: level, but a metre higher at its east end. */
const kit = (scene = new Scene()): InteriorsKit & { walls: number; shadows: number } => {
  const k = {
    scene,
    material: new MeshBasicMaterial(),
    ink: new LineBasicMaterial(),
    city: { buildings: [{ id: 7, ring: Float32Array.of(0, 0, 20, 0, 20, 12, 0, 12) }] },
    groundAt: (x: number) => (x > 15 ? 1 : 0),
    openWalls: () => {
      k.walls++;
      return true;
    },
    shadowsChanged: () => k.shadows++,
    walls: 0,
    shadows: 0,
  };
  return k as unknown as InteriorsKit & { walls: number; shadows: number };
};

describe('the rooms in the scene', () => {
  test('find a room by id, by its footprint and by its door', () => {
    const rooms = createInteriors(kit(), [HALL]);
    expect(rooms.byId('hall')).toBe(HALL);
    expect(rooms.byId('nope')).toBeUndefined();
    expect(rooms.roomAt(5, 5)).toBe(HALL);
    expect(rooms.roomAt(25, 5)).toBeUndefined();
    expect(rooms.beside(10, 14, 3)).toBe(HALL);
    expect(rooms.beside(5, 5, 3)).toBe(HALL);
    expect(rooms.beside(10, 30, 3)).toBeUndefined();
    expect(Array.from(rooms.footprint(HALL))).toEqual([0, 0, 20, 0, 20, 12, 0, 12]);
  });

  test('stand a room’s floor over the highest ground under it, its walls to its ceiling', () => {
    const rooms = createInteriors(kit(), [HALL]);
    expect(rooms.foot(HALL)).toBeCloseTo(1.03);
    expect(rooms.top(HALL)).toBeCloseTo(1.03 + 7);
  });

  test('ease the floor up from the street over the threshold, and up the stair', () => {
    const rooms = createInteriors(kit(), [HALL]);
    // At the door, the street's height; two metres in, the room's.
    expect(rooms.standing(HALL, 0, 10, 12).y).toBeCloseTo(0);
    expect(rooms.standing(HALL, 0, 10, 11).y).toBeGreaterThan(0);
    expect(rooms.standing(HALL, 0, 10, 9).y).toBeCloseTo(1.03);
    expect(rooms.standing(HALL, 0, 15.5, 2)).toEqual({ level: 1, y: 1.03 + 3 });
  });

  test('cache each floor’s grid and router', () => {
    const rooms = createInteriors(kit(), [HALL]);
    expect(rooms.grid(HALL, 1)).toBe(rooms.grid(HALL, 1));
    expect(rooms.router(HALL, 0)).toBe(rooms.router(HALL, 0));
    expect(rooms.grid(HALL, 0)).not.toBe(rooms.grid(HALL, 1));
  });

  test('show the floors up to the one the avatar is on, and the door from outside', () => {
    const k = kit();
    const rooms = createInteriors(k, [HALL]);
    // A door on the street, from the start.
    expect(k.scene.children).toHaveLength(1);
    const door = k.scene.children[0]!;
    rooms.prewarm(HALL);
    rooms.prewarm(HALL);
    expect(k.walls).toBe(1); // the ground floor took the building's walls, once
    // Two floors, a mesh and its ink each, hidden until someone goes in.
    expect(k.scene.children).toHaveLength(5);
    expect(k.scene.children.filter((o) => o.visible)).toEqual([door]);
    rooms.show(HALL, 0);
    expect(door.visible).toBe(false);
    expect(k.scene.children.filter((o) => o.visible)).toHaveLength(2);
    rooms.show(HALL, 1);
    expect(k.scene.children.filter((o) => o.visible)).toHaveLength(4);
    rooms.show(null, 0);
    expect(k.scene.children.filter((o) => o.visible)).toEqual([door]);
    expect(k.shadows).toBe(3);
    rooms.dispose();
    expect(k.scene.children).toHaveLength(0);
  });

  test('a room shown before it was built is built then', () => {
    const k = kit();
    const rooms = createInteriors(k, [HALL]);
    rooms.show(HALL, 1);
    expect(k.scene.children.filter((o) => o.visible)).toHaveLength(4);
  });

  test('a room whose building isn’t in the city has no footprint', () => {
    const lost: Room = { ...HALL, oidn: 99, id: 'lost' };
    const rooms = createInteriors(kit(), [lost]);
    expect(rooms.footprint(lost)).toEqual([]);
    expect(rooms.roomAt(5, 5)).toBeUndefined();
  });
});

/** Answers every fetch with `respond`. */
const serve = (respond: () => Promise<Response>) => {
  globalThis.fetch = (() => respond()) as unknown as typeof fetch;
};

describe('loading the rooms', () => {
  const real = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = real;
  });

  test('fetches rooms.json from under the site’s base', async () => {
    let asked = '';
    globalThis.fetch = ((url: string) => {
      asked = url;
      return Promise.resolve(Response.json([HALL]));
    }) as unknown as typeof fetch;
    const rooms = await loadInteriors(kit(), '/leuven/');
    expect(asked).toBe('/leuven/data/rooms.json');
    expect(rooms.rooms).toHaveLength(1);
  });

  test('a failed fetch, a bad answer or a malformed file is a RoomLoadError', async () => {
    serve(() => Promise.reject(new TypeError('offline')));
    await expect(loadInteriors(kit(), '/')).rejects.toBeInstanceOf(RoomLoadError);
    serve(() => Promise.resolve(new Response('', { status: 404 })));
    await expect(loadInteriors(kit(), '/')).rejects.toBeInstanceOf(RoomLoadError);
    serve(() => Promise.resolve(Response.json({ rooms: 'none' })));
    await expect(loadInteriors(kit(), '/')).rejects.toBeInstanceOf(RoomLoadError);
  });
});

test('one room is built ahead at a time, besides the one shown', () => {
  const k = kit();
  const b: Room = { ...HALL, id: 'b' };
  const c: Room = { ...HALL, id: 'c' };
  const rooms = createInteriors(k, [HALL, b, c]);
  rooms.show(HALL, 0);
  rooms.prewarm(b);
  // Three doors, and two rooms' floors: the shown one's stays.
  expect(k.scene.children).toHaveLength(3 + 4 + 4);
  rooms.prewarm(c);
  // b was built ahead and never shown: it goes when another is.
  expect(k.scene.children).toHaveLength(3 + 4 + 4);
  rooms.show(null, 0);
  rooms.prewarm(b);
  expect(k.scene.children).toHaveLength(3 + 4);
});
