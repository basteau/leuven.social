import { describe, expect, test } from 'bun:test';

import type { Building } from '../data/city.ts';
import { MAP_COLOURS, drawMinimap, indexCity } from './minimap.ts';
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

describe('drawMinimap', () => {
  test('draws what is near, each ring once, turned to the view; then the others and you', () => {
    const index = indexCity(city);
    const { pen, calls, fills, moves } = recorder();
    const others = [
      { x: 5, z: 5, colour: 0xff0000 },
      { x: -20, z: 0, colour: 0x00ff00 },
    ];
    drawMinimap(pen, index, { x: 0, z: 0, heading: 0.5, facing: 1, range: 300, size: 200 }, others);
    // The ground, then each layer in order, then a dot each (theirs, then yours).
    expect(calls[0]).toBe('save');
    expect(calls).toContain('fillRect');
    expect(calls).toContain('rotate -0.5');
    expect(calls).toContain('rotate -1');
    expect(fills.slice(0, 5)).toEqual([
      MAP_COLOURS.green,
      MAP_COLOURS.water,
      MAP_COLOURS.roads,
      MAP_COLOURS.plazas,
      MAP_COLOURS.buildings,
    ]);
    expect(fills.slice(5)).toEqual(['#ff0000', '#00ff00', '#fbf6ea']);
    // The far house is left out; the wide one, in two buckets, is drawn once (and the green,
    // the water, the road and the near house): five rings, plus your notch.
    expect(moves()).toBe(5 + 1);
    expect(calls.filter((c) => c === 'arc')).toHaveLength(3);
    // The houses' outlines, then a rim round each dot.
    expect(calls.filter((c) => c === 'stroke')).toHaveLength(1 + 3);
    expect(calls.at(-1)).toBe('restore');
  });
});
