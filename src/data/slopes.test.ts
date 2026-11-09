import { describe, expect, test } from 'bun:test';

import { groundTop, raiseOnSlope } from './slopes.ts';
import { FLAT, Terrain } from './terrain.ts';

/** Rising east at `grade`, on a grid of 60 m from x = 0. */
const slope = (grade: number) =>
  new Terrain({
    step: 60,
    minX: 0,
    minZ: 0,
    cols: 4,
    rows: 2,
    heights: Float32Array.of(0, 60, 120, 180, 0, 60, 120, 180).map((x) => x * grade),
  });
const box = (x0: number, x1: number) => [x0, 10, x1, 10, x1, 50, x0, 50];

describe('groundTop', () => {
  test('finds the high side of a footprint', () => {
    expect(groundTop(box(30, 90), slope(0.1))).toBeCloseTo(9, 3);
  });

  test('finds a ridge between its corners, along a wall', () => {
    const ridge = new Terrain({
      step: 60,
      minX: 0,
      minZ: 0,
      cols: 3,
      rows: 2,
      heights: Float32Array.of(0, 9, 0, 0, 9, 0),
    });
    expect(groundTop(box(10, 110), ridge)).toBeCloseTo(9, 0);
  });

  test('finds a hill wholly inside a footprint, at the terrain’s own point', () => {
    const hill = new Terrain({
      step: 60,
      minX: 0,
      minZ: 0,
      cols: 3,
      rows: 3,
      heights: Float32Array.of(0, 0, 0, 0, 12, 0, 0, 0, 0),
    });
    expect(groundTop([5, 5, 115, 5, 115, 115, 5, 115], hill)).toBe(12);
  });
});

describe('raiseOnSlope', () => {
  test('leaves a building on the level alone', () => {
    expect(raiseOnSlope(box(30, 90), 5, FLAT)).toBe(0);
  });

  test('leaves a house whose walls hardly lose anything alone', () => {
    expect(raiseOnSlope(box(30, 36), 8, slope(0.1))).toBe(0);
  });

  test('raises a wide, low building until most of its uphill wall shows', () => {
    const ground = slope(0.1);
    const ring = box(30, 90);
    const raised = raiseOnSlope(ring, 3, ground);
    expect(raised).toBeCloseTo(5.4, 3);
    const uphillWall = ground.base(ring) + 3 + raised - groundTop(ring, ground);
    expect(uphillWall).toBeCloseTo(0.8 * 3, 3);
  });

  test('stops short of making a cliff of the low side', () => {
    expect(raiseOnSlope(box(0, 180), 3, slope(0.2))).toBe(14);
  });
});
