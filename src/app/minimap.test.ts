import { describe, expect, test } from 'bun:test';

import type { Building } from '../data/city.ts';
import { MAP_COLOURS, YOU, covers, drawCity, drawMinimap, indexCity } from './minimap.ts';
import type { Pen } from './minimap.ts';

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

describe('drawMinimap', () => {
  test('the city image turned to the view, then the others, then you', () => {
    const { pen, calls, fills, moves } = recorder();
    const others = [
      { x: 5, z: 5, colour: 0xff0000 },
      { x: -20, z: 0, colour: 0x00ff00 },
    ];
    const image = { image: {} as CanvasImageSource, x: 10, z: -10, span: 600 };
    drawMinimap(pen, image, { x: 0, z: 0, heading: 0.5, facing: 1, range: 300, size: 200 }, others);
    expect(calls).toContain('rotate -0.5');
    expect(calls).toContain('rotate -1');
    // The image, centred on where it was drawn, its span a side.
    expect(calls).toContain('drawImage -290 -310 600 600');
    expect(fills).toEqual(['#ff0000', '#00ff00', YOU]);
    expect(moves()).toBe(1);
    expect(calls.filter((c) => c === 'arc')).toHaveLength(2);
    expect(calls.at(-1)).toBe('restore');
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
