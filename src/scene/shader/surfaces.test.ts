import { expect, test } from 'bun:test';

import { GROUND } from './ground-surface.ts';
import { BAYER, NOISE, f } from './glsl.ts';
import { ROOF_SURFACES } from './roof-surface.ts';
import { WALL } from './wall-surface.ts';

const sources = { BAYER, NOISE, GROUND, ROOF_SURFACES, WALL };

test('numbers are written as GLSL floats', () => {
  expect(f(1)).toBe('1.0000');
  expect(f(-0.5)).toBe('-0.5000');
});

test('every surface is balanced GLSL with its codes filled in', () => {
  for (const [name, source] of Object.entries(sources)) {
    expect([name, source.includes('${')]).toEqual([name, false]);
    expect([name, source.includes('undefined')]).toEqual([name, false]);
    expect([name, source.includes('NaN')]).toEqual([name, false]);
    const count = (c: string) => source.split(c).length - 1;
    expect([name, count('{')]).toEqual([name, count('}')]);
    expect([name, count('(')]).toEqual([name, count(')')]);
  }
});

test('each surface defines the function the dispatcher calls', () => {
  for (const [source, names] of [
    [ROOF_SURFACES, ['paneSurface', 'flatRoof', 'pitchedRoof']],
    [WALL, ['wallSkin', 'wallSurface', 'plainWall']],
    [GROUND, ['sleeperBand', 'groundSurface']],
  ] as const) {
    for (const name of names) expect(source).toContain(`void ${name}(`);
  }
});
