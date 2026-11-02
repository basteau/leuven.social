import { describe, expect, test } from 'bun:test';

import {
  PLATE_BUCKET,
  PlateIndex,
  WalkFormatError,
  compareNumbers,
  decodeWalk,
  encodeWalk,
  packWalk,
  plateBucket,
  unpackWalk,
} from './plates.ts';
import type { WalkData } from './plates.ts';

const data: WalkData = {
  houses: [
    { x: 12.3, z: -4.5, angle: Math.PI / 2, text: '10' },
    { x: 15.1, z: -4.4, angle: Math.PI / 2, text: '2' },
    { x: -300.4, z: 812.9, angle: 0, text: '12A' },
    { x: -301.2, z: 815, angle: Math.PI, text: '2' },
  ],
  streets: [{ x: 4.4, z: 1.2, angle: -Math.PI / 4, name: 7 }],
};

describe('the walk file', () => {
  test('round-trips plates to a decimetre and a 256th of a turn', async () => {
    const back = await unpackWalk(await packWalk(data));
    expect(back.houses.map((h) => h.text)).toEqual(['10', '2', '12A', '2']);
    for (const [i, h] of back.houses.entries()) {
      const want = data.houses[i]!;
      expect(Math.abs(h.x - want.x)).toBeLessThanOrEqual(0.05001);
      expect(Math.abs(h.z - want.z)).toBeLessThanOrEqual(0.05001);
      const turn = Math.atan2(Math.sin(h.angle - want.angle), Math.cos(h.angle - want.angle));
      expect(Math.abs(turn)).toBeLessThan(Math.PI / 256 + 1e-9);
    }
    const [plate] = back.streets;
    expect(plate).toMatchObject({ name: 7 });
    expect(plate!.x).toBeCloseTo(4.4, 5);
    expect(plate!.angle).toBeCloseTo((224 / 256) * Math.PI * 2, 9);
  });

  test('stores each number once, in natural order', () => {
    const bytes = encodeWalk(data);
    const text = new TextDecoder().decode(bytes);
    expect(text.indexOf('2')).toBeLessThan(text.indexOf('10'));
    expect(text.indexOf('10')).toBeLessThan(text.indexOf('12A'));
    expect(text.split('12A').length).toBe(2);
  });

  test('reads plain bytes as well as gzipped', async () => {
    expect((await unpackWalk(encodeWalk(data))).houses).toHaveLength(4);
  });

  test('refuses what is not a walk file', () => {
    expect(() => decodeWalk(new TextEncoder().encode('LVN1'))).toThrow(WalkFormatError);
    expect(() => decodeWalk(new Uint8Array([1]))).toThrow('Not a walk file.');
    const bytes = encodeWalk(data);
    const future = Uint8Array.from(bytes);
    future[4] = 99;
    expect(() => decodeWalk(future)).toThrow('Unsupported walk format v99.');
    expect(() => decodeWalk(Uint8Array.from([...bytes, 0]))).toThrow('1 trailing bytes.');
  });

  test('refuses a house number outside its table', () => {
    const bytes = encodeWalk({ houses: [{ x: 0, z: 0, angle: 0, text: '1' }], streets: [] });
    // magic, version, table (1 string of 1), count, x, z, then the index: point it past the table.
    bytes[11] = 5;
    expect(() => decodeWalk(bytes)).toThrow('Bad house number.');
  });
});

test('house numbers sort naturally', () => {
  const sorted = ['10', '2', '2B', '2A', 'Blok 1', '1–3', '100'].toSorted(compareNumbers);
  expect(sorted).toEqual(['1–3', '2', '2A', '2B', '10', '100', 'Blok 1']);
  expect(compareNumbers('Blok 1', 'Blok 1')).toBe(0);
});

describe('PlateIndex', () => {
  const plates = [
    { x: 0, z: 0 },
    { x: 30, z: 0 },
    { x: -5, z: 3 },
    { x: 100, z: 100 },
  ];
  const index = new PlateIndex(plates);

  test('finds the plates within reach, nearest first', () => {
    expect(index.near(0, 0, 40)).toEqual([0, 2, 1]);
    expect(index.near(0, 0, 10)).toEqual([0, 2]);
    expect(index.near(100, 99, 2)).toEqual([3]);
    expect(index.near(500, 500, 50)).toEqual([]);
  });

  test('keeps the nearest when there are too many', () => {
    expect(index.near(0, 0, 40, 2)).toEqual([0, 2]);
  });
});

test('the walker is snapped to squares, the same anywhere inside one', () => {
  expect(plateBucket(0.5, 0.5)).toBe(plateBucket(PLATE_BUCKET - 0.5, PLATE_BUCKET - 0.5));
  expect(plateBucket(0.5, 0.5)).not.toBe(plateBucket(-0.5, 0.5));
  expect(plateBucket(0.5, 0.5)).not.toBe(plateBucket(0.5, PLATE_BUCKET + 0.5));
});
