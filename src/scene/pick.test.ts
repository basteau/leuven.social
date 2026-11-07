import { expect, test } from 'bun:test';

import { unpackDepth } from './pick.ts';

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
