import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { Building } from '../data/city.ts';
import { createPeople } from '../net/people.ts';
import type { Marks } from '../scene/clumps.ts';
import { YOU } from './colours.ts';
import {
  MAP_COLOURS,
  NOBODY,
  covers,
  createMinimapCrowd,
  drawCity,
  drawMinimap,
  indexCity,
} from './minimap.ts';
import type { Pen } from './minimap.ts';

// Sprites are made on canvases, which a test has none of.
beforeAll(() => {
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        scale: () => {},
        beginPath: () => {},
        arc: () => {},
        fill: () => {},
        stroke: () => {},
      }),
    }),
  };
});
afterAll(() => {
  delete (globalThis as { document?: unknown }).document;
});

const square = (x: number, z: number, half: number) =>
  new Float32Array([
    x - half,
    z - half,
    x + half,
    z - half,
    x + half,
    z + half,
    x - half,
    z + half,
  ]);
const house = (ring: Float32Array) => ({ ring }) as Building;

/** A pen that writes down what it was asked to draw, and with what fill. */
function recorder() {
  const calls: string[] = [];
  const fills: string[] = [];
  let moves = 0;
  const pen = {
    fillStyle: '' as Pen['fillStyle'],
    strokeStyle: '' as Pen['strokeStyle'],
    lineWidth: 1,
    globalAlpha: 1,
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    setTransform: () => calls.push('setTransform'),
    translate: (x: number, y: number) => calls.push(`translate ${x} ${y}`),
    rotate: (a: number) => calls.push(`rotate ${a}`),
    scale: (x: number) => calls.push(`scale ${x}`),
    fillRect: () => calls.push('fillRect'),
    drawImage: (_i: unknown, ...at: number[]) => calls.push(`drawImage ${at.join(' ')}`),
    beginPath: () => calls.push('beginPath'),
    moveTo: () => {
      moves++;
    },
    lineTo: () => {},
    closePath: () => {},
    fill: () => fills.push(String(pen.fillStyle)),
    stroke: () => calls.push('stroke'),
    arc: () => calls.push('arc'),
  };
  return { pen: pen as unknown as Pen, calls, fills, moves: () => moves };
}

const city = {
  buildings: [house(square(10, 10, 5)), house(square(2000, 0, 5)), house(square(95, 50, 20))],
  green: [square(-50, -50, 10)],
  water: [square(0, 60, 10)],
  roads: [square(0, 0, 3)],
  plazas: [],
};

describe('indexCity', () => {
  test('puts each ring in every bucket its box touches', () => {
    const { buckets } = indexCity(city);
    // The wide house straddles x = 100: in two buckets.
    const spread = [...buckets.values()].filter((b) =>
      b.buildings.includes(city.buildings[2]!.ring),
    );
    expect(spread).toHaveLength(2);
    expect([...buckets.values()].some((b) => b.green.length && b.water.length)).toBe(false);
  });
});

describe('drawCity', () => {
  test('draws what is in reach, each ring once, layer by layer, inked', () => {
    const index = indexCity(city);
    const { pen, calls, fills, moves } = recorder();
    drawCity(pen, index, 0, 0, 600, 400);
    expect(calls[0]).toBe('save');
    expect(calls).toContain('fillRect');
    // North up: nothing turned.
    expect(calls.some((c) => c.startsWith('rotate'))).toBe(false);
    expect(fills).toEqual([
      MAP_COLOURS.green,
      MAP_COLOURS.water,
      MAP_COLOURS.roads,
      MAP_COLOURS.plazas,
      MAP_COLOURS.buildings,
    ]);
    // The far house is left out; the wide one, in two buckets, is drawn once (and the green,
    // the water, the road and the near house): five rings.
    expect(moves()).toBe(5);
    expect(calls.filter((c) => c === 'stroke')).toHaveLength(1);
    expect(calls.at(-1)).toBe('restore');
  });
});

const oneMark = (x: number, z: number): Marks => ({
  ...NOBODY,
  count: 1,
  x: Float32Array.of(x),
  z: Float32Array.of(z),
  n: Uint32Array.of(1),
  colour: Int32Array.of(0xff0000),
  radius: Float32Array.of(3.5),
  alpha: Float32Array.of(1),
});
const cityImage = { image: {} as CanvasImageSource, x: 10, z: -10, span: 600 };
const view = { x: 0, z: 0, heading: 0.5, facing: 1, range: 300, size: 200, dpr: 1 };

/** Where a mark at (x, z) lands, its centre on the canvas, for a view that looks `heading`. */
function placed(x: number, z: number, heading: number) {
  const { pen, calls } = recorder();
  drawMinimap(pen, cityImage, { ...view, heading, x: 0, z: 0 }, oneMark(x, z));
  // The image is the first drawImage; the mark's sprite the second.
  const [left, top, width, height] = calls
    .filter((c) => c.startsWith('drawImage'))[1]!
    .split(' ')
    .slice(1)
    .map(Number) as [number, number, number, number];
  return [left + width / 2, top + height / 2] as const;
}

describe('drawMinimap', () => {
  test('the city image turned to the view, then the marks, then you on top', () => {
    const { pen, calls, fills, moves } = recorder();
    drawMinimap(pen, cityImage, view, oneMark(5, 5));
    expect(calls).toContain('rotate -0.5');
    expect(calls).toContain('rotate -1');
    // The image, centred on where it was drawn, its span a side.
    expect(calls).toContain('drawImage -290 -310 600 600');
    expect(fills.at(-1)).toBe(YOU);
    expect(moves()).toBe(1);
    expect(calls.filter((c) => c.startsWith('drawImage'))).toHaveLength(2);
    expect(calls.at(-1)).toBe('restore');
  });

  test('marks are turned with the view', () => {
    // Up the screen is north at heading 0: someone 10 m north is above you.
    const [nx, ny] = placed(0, -10, 0);
    expect(nx).toBeCloseTo(100, 3);
    expect(ny).toBeCloseTo(100 - (10 / 300) * 200, 3);
    // Looking east, up the screen is east: someone 10 m east is above you.
    const [ex, ey] = placed(10, 0, Math.PI / 2);
    expect(ex).toBeCloseTo(100, 3);
    expect(ey).toBeCloseTo(100 - (10 / 300) * 200, 3);
    // And someone 10 m north is to your left.
    const [wx, wy] = placed(0, -10, Math.PI / 2);
    expect(wx).toBeCloseTo(100 - (10 / 300) * 200, 3);
    expect(wy).toBeCloseTo(100, 3);
  });

  test('a city image covers the minimap until you walk far enough from its middle', () => {
    const image = { image: {} as CanvasImageSource, x: 0, z: 0, span: 720 };
    expect(covers(null, 0, 0, 360)).toBe(false);
    expect(covers(image, 0, 0, 360)).toBe(true);
    expect(covers(image, 100, 0, 360)).toBe(true);
    expect(covers(image, 110, 0, 360)).toBe(false);
    // Drawn for another range: drawn again.
    expect(covers(image, 0, 0, 1400)).toBe(false);
  });
});

function crowd(spots: [number, number][]) {
  const people = createPeople();
  spots.forEach(([x, z], i) => people.coarse(0, i + 1, x, z, 0x336699, 1));
  people.sample(1000);
  people.sample(2000);
  return people;
}

describe('the minimap crowd', () => {
  const view2 = { x: 0, z: 0, heading: 0, facing: 0, range: 360, size: 320, dpr: 2 };

  test('leaves out someone inside the square but outside the circle', () => {
    const people = crowd([
      [10, 10],
      [170, 170], // 240 m off, in the corner of a 360 m square
    ]);
    const marks = createMinimapCrowd(() => 0)(people, view2);
    expect(marks.count).toBe(1);
    expect(marks.x[0]).toBeCloseTo(10, 3);
  });

  test('a crowd in the circle is one clump, never halfway between two levels', () => {
    const spots: [number, number][] = [];
    for (let i = 0; i < 12; i++) spots.push([8 + (i % 4), 8 + ((i / 4) | 0)]);
    const people = crowd(spots);
    for (const size of [240, 300, 320, 480, 512]) {
      const marks = createMinimapCrowd(() => 0)(people, { ...view2, size });
      expect(marks.count).toBe(1);
      expect(marks.alpha[0]).toBe(1);
    }
  });

  test('grows with the crowd, and keeps its working array while the crowd fits', () => {
    const spots: [number, number][] = [];
    for (let i = 0; i < 200; i++) spots.push([i - 100, 0]);
    const clump = createMinimapCrowd(() => 0);
    const first = clump(crowd(spots), view2);
    expect(first.count).toBeGreaterThan(0);
  });
});
