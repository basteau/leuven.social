import { describe, expect, test } from 'bun:test';

import {
  MAP_MAX_SCALE,
  MAP_MIN_SCALE,
  clampScale,
  simplifyRing,
  toCity,
  toScreen,
} from './map-view.ts';
import { selfOf } from './presence.ts';
import type { Presence } from './presence.ts';
import {
  MAX_WAYPOINTS,
  NAME_MAX,
  WAYPOINTS_KEY,
  WAYPOINT_COLOURS,
  addWaypoint,
  loadWaypoints,
  parseWaypoints,
  removeWaypoint,
  updateWaypoint,
  saveWaypoints,
  waypointNear,
} from './waypoints.ts';

describe('presence', () => {
  const list: Presence[] = [
    { id: 'a', x: 1, z: 2, heading: 0, self: false },
    { id: 'me', x: 3, z: 4, heading: 1, self: true },
  ];
  test('finds the own player', () => {
    expect(selfOf(list)?.id).toBe('me');
    expect(selfOf([])).toBeUndefined();
  });
});

describe('map view', () => {
  const frame = { cx: 10, cz: 20, scale: 2 };
  test('projects and unprojects', () => {
    expect(toScreen(frame, 10, 20)).toEqual([0, 0]);
    expect(toScreen(frame, 15, 20)).toEqual([10, 0]);
    const [px, py] = toScreen(frame, 33, -5);
    const [x, z] = toCity(frame, px, py);
    expect(x).toBeCloseTo(33);
    expect(z).toBeCloseTo(-5);
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
  test('removes', () => {
    const list = addWaypoint(addWaypoint([], { x: 0, z: 0 }, 'a'), { x: 1, z: 1 }, 'b');
    expect(removeWaypoint(list, 'a').map((w) => w.id)).toEqual(['b']);
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

describe('renaming a mark', () => {
  const list = addWaypoint([], { x: 1, z: 2, name: 'Thuis' }, 'a');

  test('changes its name and colour, nothing else', () => {
    const next = updateWaypoint(list, 'a', { name: 'Kot', colour: WAYPOINT_COLOURS[2] });
    expect(next[0]).toEqual({ ...list[0]!, name: 'Kot', colour: WAYPOINT_COLOURS[2] });
    expect(list[0]!.name).toBe('Thuis');
  });

  test('keeps spaces while someone types, cuts a name that is too long', () => {
    expect(updateWaypoint(list, 'a', { name: 'De ' })[0]!.name).toBe('De ');
    expect(updateWaypoint(list, 'a', { name: 'x'.repeat(80) })[0]!.name).toHaveLength(NAME_MAX);
  });

  test('a colour alone keeps the name, another id changes nothing', () => {
    expect(updateWaypoint(list, 'a', { colour: WAYPOINT_COLOURS[1] })[0]!.name).toBe('Thuis');
    expect(updateWaypoint(list, 'b', { name: 'Kot' })).toEqual(list);
  });
});
