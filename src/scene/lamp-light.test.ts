import { expect, test } from 'bun:test';

import type { Building, Prop, ShopFront } from '../data/city.ts';
import { FRONT_RAY, LAMP_RAY, LIGHT_TEXEL, bakeLight } from './lamp-light.ts';

const area = [{ minX: 0, minZ: 0, maxX: 100, maxZ: 80 }];
const lamp = (x: number, z: number) => ({ kind: 'lamp', x, z }) as Pick<Prop, 'kind' | 'x' | 'z'>;
const flat = { height: () => 3, lowest: 0, highest: 10 };
const empty = { area, props: [], buildings: [], fronts: [] };

function read(field: ReturnType<typeof bakeLight>, x: number, z: number): number[] {
  const i = Math.floor((x - field.minX) / field.texel);
  const j = Math.floor((z - field.minZ) / field.texel);
  const k = (i + j * field.width) * 4;
  return [...field.data.subarray(k, k + 4)];
}

const front = (kind: ShopFront['kind']): ShopFront => ({
  building: 0,
  edge: 0,
  along: 10,
  kind,
  terrace: false,
});

test('the field covers the area, black where nothing shines', () => {
  const f = bakeLight(empty, flat);
  expect(f.width).toBe(Math.ceil(100 / LIGHT_TEXEL));
  expect(f.height).toBe(Math.ceil(80 / LIGHT_TEXEL));
  expect(f.data.length).toBe(f.width * f.height * 4);
  expect(f.data.every((v) => v === 0)).toBe(true);
});

test('a lamp is brightest at its foot, warm, and gone at its reach', () => {
  const f = bakeLight({ ...empty, props: [lamp(50, 40)] }, flat);
  const [r, g, b] = read(f, 50, 40) as [number, number, number];
  expect(r).toBeGreaterThan(g);
  expect(g).toBeGreaterThan(b);
  expect(r).toBeGreaterThan(120);
  const near = read(f, 50 + LAMP_RAY.radius / 2, 40)[0]!;
  expect(near).toBeLessThan(r);
  expect(near).toBeGreaterThan(0);
  expect(read(f, 50 + LAMP_RAY.radius + LIGHT_TEXEL, 40)[0]).toBe(0);
});

test('light fills up as it adds: a crowd of lamps is brighter, and never clips', () => {
  const one = read(bakeLight({ ...empty, props: [lamp(50, 40)] }, flat), 50, 40)[0]!;
  const crowd = Array.from({ length: 6 }, () => lamp(50, 40));
  const many = read(bakeLight({ ...empty, props: crowd }, flat), 50, 40)[0]!;
  expect(many).toBeGreaterThan(one);
  expect(many).toBeLessThan(255);
  const bench = { kind: 'bench', x: 50, z: 40 } as Pick<Prop, 'kind' | 'x' | 'z'>;
  expect(read(bakeLight({ ...empty, props: [bench] }, flat), 50, 40)[3]).toBe(0);
});

test('two lamps a street apart light the ground between them, about as much as at their feet', () => {
  // Lamps 19 m apart, the median in the city's own data: the street between them stays lit.
  const f = bakeLight({ ...empty, props: [lamp(40, 40), lamp(59, 40)] }, flat);
  const foot = read(f, 40, 40)[0]!;
  const middle = read(f, 49.5, 40)[0]!;
  expect(middle).toBeGreaterThan(foot * 0.8);
});

test('alpha holds the ground under the light, a little past where it reaches', () => {
  const f = bakeLight({ ...empty, props: [lamp(50, 40)] }, flat);
  const a = read(f, 50, 40)[3]!;
  expect(f.low + (a / 255) * (f.high - f.low)).toBeCloseTo(3, 0);
  expect(read(f, 50 + LAMP_RAY.radius + LIGHT_TEXEL, 40)[3]).toBe(a);
});

test('a lit front warms the pavement before it; a shop is cooler; each off the wall', () => {
  // A wall along z = 40, walked west to east: its outside is toward -z.
  const buildings = [
    { ring: new Float32Array([40, 40, 60, 40, 60, 60, 40, 60]) },
  ] as unknown as Pick<Building, 'ring' | 'kind' | 'tier'>[];
  const at = (kind: ShopFront['kind']) =>
    read(
      bakeLight({ ...empty, buildings, fronts: [front(kind)] }, flat),
      50,
      40 - FRONT_RAY.out,
    ) as [number, number, number];
  const [warmR, , warmB] = at('cafe');
  const [coolR, , coolB] = at('books');
  expect(warmR - warmB).toBeGreaterThan(coolR - coolB);
  expect(at('university')[0]).toBe(warmR); // a public place's door is lit like a café
});

test('a church and a civic hero wash the ground round them; a house does not', () => {
  const ring = new Float32Array([40, 40, 60, 40, 60, 60, 40, 60]);
  const at = (kind: string, tier: string) =>
    read(
      bakeLight(
        {
          ...empty,
          buildings: [{ ring, kind, tier }] as unknown as Pick<
            Building,
            'ring' | 'kind' | 'tier'
          >[],
        },
        flat,
      ),
      50,
      37,
    )[0]!;
  expect(at('church', 'core')).toBeGreaterThan(0);
  expect(at('civic', 'hero')).toBeGreaterThan(0);
  expect(at('civic', 'core')).toBe(0);
  expect(at('house', 'hero')).toBe(0);
});

test('a lamp near the edge of the map stays inside the field', () => {
  const f = bakeLight({ ...empty, props: [lamp(1, 1), lamp(99, 79)] }, flat);
  expect(f.data.length).toBe(f.width * f.height * 4);
  expect(read(f, 1, 1)[0]).toBeGreaterThan(0);
});
