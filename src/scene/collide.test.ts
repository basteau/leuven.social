import { afterEach, describe, expect, test } from 'bun:test';

import { loose, moveBody, overlap, settle } from './collide.ts';
import type { Body, Ground } from './collide.ts';

const open: Ground = { wallOverlap: () => 0, closed: () => 0 };
const body = (x = 0, z = 0): Body => ({ x, z, dirX: 0, dirZ: 1, speed: 4, accel: 0, slide: 1 });
const out: [number, number] = [0, 0];

afterEach(() => {
  loose.length = 0;
});

describe('loose things in the street', () => {
  test('a bike left on its stand is met as a circle, and pushes out away from its middle', () => {
    loose.push(0, 0.6, 0.5);
    expect(overlap(0, 0, open, 0.45, 0, out)).toBeCloseTo(0.45 + 0.5 - 0.6);
    expect(out[1]).toBeCloseTo(-1);
    expect(overlap(0, -2, open, 0.45, 0, out)).toBe(0);
  });

  test('a body walking straight at one stops in front of it rather than through it', () => {
    loose.push(0, 2, 0.5);
    const b = body();
    for (let i = 0; i < 240; i++) moveBody(b, b.speed / 120, 1 / 120, open, 0.45);
    expect(b.z).toBeLessThan(2 - 0.9);
    expect(b.z).toBeGreaterThan(0.5);
  });

  test('glancing one, it slides round it', () => {
    loose.push(0.3, 2, 0.5);
    const b = body();
    for (let i = 0; i < 240; i++) moveBody(b, 4 / 120, 1 / 120, open, 0.45);
    expect(b.z).toBeGreaterThan(3);
    expect(b.x).toBeLessThan(0);
  });

  test('settling never moves a body onto closed ground', () => {
    const water: Ground = { wallOverlap: () => 0, closed: (x) => (x > 1 ? 1 : 0) };
    const b = { x: 0, z: 0 };
    settle(b, 2, 0, 1 / 120, water, 0.45);
    expect(b.x).toBe(0);
    settle(b, 0.5, 0, 1 / 120, water, 0.45);
    expect(b.x).toBe(0.5);
  });
});
