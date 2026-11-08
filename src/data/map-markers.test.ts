import { describe, expect, test } from 'bun:test';

import { DRIFT_STEP, driftChanged, edgePoint, homeDirection } from './drift.ts';
import {
  MAP_MAX_SCALE,
  MAP_MIN_SCALE,
  clampScale,
  onRadar,
  simplifyRing,
  toCity,
  toScreen,
  turnFor,
} from './map-view.ts';
import { marked, selfOf } from './presence.ts';
import type { Presence } from './presence.ts';
import {
  MAX_WAYPOINTS,
  NAME_MAX,
  WAYPOINTS_KEY,
  addWaypoint,
  loadWaypoints,
  parseWaypoints,
  removeWaypoint,
  renameWaypoint,
  saveWaypoints,
  waypointNear,
} from './waypoints.ts';

describe('presence', () => {
  const list: Presence[] = [
    { id: 'a', x: 1, z: 2, heading: 0, self: false },
    { id: 'me', x: 3, z: 4, heading: 1, self: true },
  ];
  test('only the own player is found and marked', () => {
    expect(selfOf(list)?.id).toBe('me');
    expect(list.filter(marked).map((p) => p.id)).toEqual(['me']);
    expect(selfOf([])).toBeUndefined();
  });
});

describe('drift', () => {
  test('points home only once it is out of view', () => {
    expect(homeDirection(0, 0, 400, 200)).toBeNull();
    expect(homeDirection(0.85, -0.5, 400, 200)).toBeNull();
    expect(homeDirection(2, 0, 400, 200)).toBeCloseTo(0);
    expect(homeDirection(0, -3, 400, 200)).toBeCloseTo(Math.PI / 2);
    expect(homeDirection(-2, 0, 400, 200)).toBeCloseTo(Math.PI);
    expect(DRIFT_STEP).toBeGreaterThan(0);
  });
  test('tells the arrow only of an appearance, a disappearance or a real turn', () => {
    expect(driftChanged(null, null)).toBe(false);
    expect(driftChanged(null, 1)).toBe(true);
    expect(driftChanged(1, null)).toBe(true);
    expect(driftChanged(1, 1 + DRIFT_STEP / 2)).toBe(false);
    expect(driftChanged(1, 1 + DRIFT_STEP * 2)).toBe(true);
  });
  test('places the arrow on the inset edge in its direction', () => {
    expect(edgePoint(0, 400, 200, 20)).toEqual({ x: 380, y: 100 });
    const down = edgePoint(Math.PI / 2, 400, 200, 20);
    expect(down.x).toBeCloseTo(200);
    expect(down.y).toBeCloseTo(180);
    const diagonal = edgePoint(Math.PI / 4, 400, 200, 20);
    expect(diagonal.y).toBeCloseTo(180);
    expect(diagonal.x).toBeCloseTo(280);
  });
});

describe('map view', () => {
  const frame = { cx: 10, cz: 20, scale: 2, turn: 0 };
  test('projects and unprojects, turned or not', () => {
    expect(toScreen(frame, 10, 20)).toEqual([0, 0]);
    expect(toScreen(frame, 15, 20)).toEqual([10, 0]);
    for (const turn of [0, 0.7, -2]) {
      const f = { ...frame, turn };
      const [px, py] = toScreen(f, 33, -5);
      const [x, z] = toCity(f, px, py);
      expect(x).toBeCloseTo(33);
      expect(z).toBeCloseTo(-5);
    }
  });
  test('a radar turned to the heading puts what is ahead at the top', () => {
    const heading = Math.PI / 2; // facing east
    const f = { cx: 0, cz: 0, scale: 1, turn: turnFor(heading) };
    const [x, y] = toScreen(f, 10, 0);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(-10);
  });
  test('clips what is beyond the rim to the rim', () => {
    expect(onRadar([3, 4], 10)).toEqual({ x: 3, y: 4, clipped: false });
    const rim = onRadar([30, 40], 10);
    expect(rim.clipped).toBe(true);
    expect(rim.x).toBeCloseTo(6);
    expect(rim.y).toBeCloseTo(8);
  });
  test('keeps the zoom within its limits', () => {
    expect(clampScale(0)).toBe(MAP_MIN_SCALE);
    expect(clampScale(99)).toBe(MAP_MAX_SCALE);
    expect(clampScale(1)).toBe(1);
  });
  test('thins a ring to its corners', () => {
    const ring = [0, 0, 5, 0.01, 10, 0, 10, 10, 0, 10];
    expect(simplifyRing(ring, 0.5)).toEqual([0, 0, 10, 0, 10, 10, 0, 10]);
    expect(simplifyRing(ring, 0)).toEqual(ring);
    expect(simplifyRing([0, 0, 1, 0, 1, 1], 5)).toEqual([0, 0, 1, 0, 1, 1]);
    // A sliver stays a triangle.
    expect(simplifyRing([0, 0, 5, 0, 10, 0, 5, 0.001], 1).length).toBeGreaterThanOrEqual(6);
  });
});

describe('waypoints', () => {
  test('adds with a default name and colour, trims and cuts names', () => {
    const one = addWaypoint([], { x: 1.234, z: 5.678 }, 'a');
    expect(one).toEqual([{ id: 'a', x: 1.2, z: 5.7, name: 'Mark 1', colour: '#d2553f' }]);
    const two = addWaypoint(
      one,
      { x: 0, z: 0, name: `  ${'x'.repeat(99)} `, colour: '#4a77a8' },
      'b',
    );
    expect(two[1]?.name).toHaveLength(NAME_MAX);
    expect(two[1]?.colour).toBe('#4a77a8');
  });
  test('keeps the newest up to the limit', () => {
    let list = addWaypoint([], { x: 0, z: 0 }, 'first');
    for (let i = 0; i < MAX_WAYPOINTS; i++) list = addWaypoint(list, { x: i, z: 0 }, `w${i}`);
    expect(list).toHaveLength(MAX_WAYPOINTS);
    expect(list.some((w) => w.id === 'first')).toBe(false);
  });
  test('removes and renames', () => {
    const list = addWaypoint(addWaypoint([], { x: 0, z: 0 }, 'a'), { x: 1, z: 1 }, 'b');
    expect(removeWaypoint(list, 'a').map((w) => w.id)).toEqual(['b']);
    expect(renameWaypoint(list, 'a', ' Home ')[0]?.name).toBe('Home');
    expect(renameWaypoint(list, 'a', '  ')[0]?.name).toBe('Mark 1');
  });
  test('parses stored JSON and drops what is malformed', () => {
    const good = { id: 'a', x: 1, z: 2, name: 'n', colour: '#d2553f' as const };
    expect(parseWaypoints(null)).toEqual([]);
    expect(parseWaypoints('{nope')).toEqual([]);
    expect(parseWaypoints('{}')).toEqual([]);
    const stored = JSON.stringify([good, { ...good, colour: 'red' }, { ...good, x: 'a' }, null, 4]);
    expect(parseWaypoints(stored)).toEqual([good]);
  });
  test('finds the nearest within reach', () => {
    const list = addWaypoint(addWaypoint([], { x: 0, z: 0 }, 'a'), { x: 10, z: 0 }, 'b');
    expect(waypointNear(list, 8, 0, 5)?.id).toBe('b');
    expect(waypointNear(list, 50, 0, 5)).toBeUndefined();
  });
  test('persists in localStorage, and survives it throwing', () => {
    const store = new Map<string, string>();
    const real = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
      },
    });
    const list = addWaypoint([], { x: 1, z: 2 }, 'a');
    saveWaypoints(list);
    expect(store.has(WAYPOINTS_KEY)).toBe(true);
    expect(loadWaypoints()).toEqual(list);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
    });
    expect(loadWaypoints()).toEqual([]);
    expect(() => saveWaypoints(list)).not.toThrow();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: real });
  });
});
