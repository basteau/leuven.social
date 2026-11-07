import { describe, expect, test } from 'bun:test';

import { meant, unpackDepth } from './pick.ts';
import type { MeantTests } from './pick.ts';

/** `packDepthToRGBA` from three's packing chunk, as bytes, to check against. */
const fract = (x: number) => x - Math.floor(x);

function pack(v: number): [number, number, number, number] {
  const whole = v * 256 ** 3;
  const af = fract(whole);
  let vuf = Math.floor(whole);
  const bf = fract(vuf / 256);
  vuf = Math.floor(vuf / 256);
  const gf = fract(vuf / 256);
  vuf = Math.floor(vuf / 256);
  return [vuf, Math.round(gf * 256), Math.round(bf * 256), Math.round(af * 255)];
}

test('a depth packed into four bytes comes back to within a hair', () => {
  for (const v of [0, 0.25, 0.5, 0.123456789, 0.999]) {
    expect(unpackDepth(...pack(v))).toBeCloseTo(v, 7);
  }
});

test('the clear colour is nothing hit', () => {
  expect(unpackDepth(255, 255, 255, 255)).toBeNaN();
});

function testsFor(rows: string[]): MeantTests {
  const kind = (x: number, z: number) => rows[Math.round(z)]![Math.round(x)];
  return {
    ground: (_x, y) => y < 0.5,
    open: (x, z) => kind(x, z) === 'g' || kind(x, z) === 't',
    building: (x, z) => kind(x, z) === 'r' || kind(x, z) === 'b',
  };
}

describe('meant', () => {
  // A 5×5 square of pixels, 1 m apart on the ground: x = column, z = row (the top row furthest).
  const side = 5;
  /** Builds the square: `kind` per pixel, 'g' open ground, 'w' water, 'r' roof, 't' a tree. */
  function square(rows: string[]): Float32Array {
    const points = new Float32Array(side * side * 3);
    rows.forEach((line, row) => {
      [...line].forEach((kind, col) => {
        const y = kind === 'r' ? 10 : kind === 't' ? 4 : 0;
        points.set(kind === '.' ? [Number.NaN, 0, 0] : [col, y, row], (row * side + col) * 3);
      });
    });
    return points;
  }

  test('open ground, or something standing on it, is where it is', () => {
    const rows = ['ggggg', 'ggggg', 'ggtgg', 'ggggg', 'ggggg'];
    expect(meant(square(rows), side, testsFor(rows))).toEqual([2, 2]);
    rows[2] = 'ggggg';
    expect(meant(square(rows), side, testsFor(rows))).toEqual([2, 2]);
  });

  test('a roof or a wall is the building’s, for the caller', () => {
    const rows = ['ggggg', 'rrrrr', 'rrrrr', 'rrrrr', 'ggggg'];
    expect(meant(square(rows), side, testsFor(rows))).toBe('building');
  });

  test('water and ground the grid gives a building mean the open ground nearest', () => {
    const river = ['ggggg', 'wwwww', 'wwwww', 'wwwww', 'wwwgg'];
    expect(meant(square(river), side, testsFor(river))).toEqual([2, 0]);
    // A sliver of street at a wall's foot that the grid rasterised into the building.
    const sliver = ['rrrrr', 'rrrrr', 'rrbgg', 'rrrrr', 'rrrrr'];
    expect(meant(square(sliver), side, testsFor(sliver))).toEqual([3, 2]);
  });

  test('no open ground in sight round water, or nothing hit at all, is nowhere', () => {
    const lake = ['wwwww', 'wwwww', 'wwwww', 'wwwww', 'wwwww'];
    expect(meant(square(lake), side, testsFor(lake))).toBeNull();
    const sky = ['.....', '.....', '.....', '.....', '.....'];
    expect(meant(square(sky), side, testsFor(sky))).toBeNull();
  });
});
