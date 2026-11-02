import { describe, expect, test } from 'bun:test';

import { deltaE, gamma, linear, toOklab } from '../data/colour.ts';
import { HOUSE_PLATE_HEIGHT, STREET_PLATE_HEIGHT } from '../data/plates.ts';
import { SHOP_KINDS } from '../data/shop-kinds.ts';
import { frontPoint } from '../data/shops.ts';
import { Terrain } from '../data/terrain.ts';
import { footing } from './buildings.ts';
import { MeshBuilder } from './mesh-builder.ts';
import { FRONTS, PLATE } from './palette.ts';
import {
  AWNING_REACH,
  PLATE_DEPTH,
  PlateBuffers,
  Walls,
  addPlate,
  boardColour,
  contrast,
  fitBoard,
  linearRgb,
  packCells,
  plateHeights,
  plateOutline,
  plateWidth,
} from './plate-mesh.ts';
import type { PlateStyle, Slice } from './plate-mesh.ts';
import { addAwning } from './storefronts.ts';

const slice = (u0: number, width: number): Slice => ({
  u0,
  v0: 0.5,
  u1: u0 + 0.1,
  v1: 0.75,
  width,
});
const style: PlateStyle = {
  height: 0.25,
  radius: 0.2,
  left: slice(0, 0.3),
  right: slice(0.1, 0.3),
  blank: slice(0.2, 0),
  minWidth: 1.5,
  glyphs: new Map([
    ['1', slice(0.3, 0.4)],
    ['2', slice(0.4, 0.5)],
  ]),
};
const ink: [number, number] = [0.9, 0.1];

describe('fitBoard', () => {
  // Letters 0.3 board heights wide, caps 0.3 each.
  const board: PlateStyle = {
    ...style,
    glyphs: new Map([...'abcdefghij …'].map((ch, i) => [ch, slice(i / 20, 0.3)])),
  };

  test('a name that fits keeps the board at its tallest', () => {
    expect(fitBoard('abc', board, 3, 0.2, 0.4)).toEqual({ text: 'abc', height: 0.4 });
  });

  test('a longer one makes it shorter, filling the front', () => {
    // 10 letters and the caps are 3.6 board heights: 0.25 m tall in 0.9 m.
    const fit = fitBoard('abcdefghij', board, 0.9, 0.2, 0.4)!;
    expect(fit.text).toBe('abcdefghij');
    expect(fit.height).toBeCloseTo(0.25, 9);
    expect(plateWidth(fit.text, { ...board, minWidth: 0 }) * fit.height).toBeCloseTo(0.9, 9);
  });

  test('then cuts the name, ending in an ellipsis, never on a space', () => {
    const fit = fitBoard('abcde fghij', board, 0.55, 0.2, 0.4)!;
    expect(fit.text).toBe('abcde…');
    expect(plateWidth(fit.text, { ...board, minWidth: 0 }) * fit.height).toBeLessThanOrEqual(0.55);
    expect(fitBoard('abcd…', board, 0.6, 0.2, 0.4)!.text).toBe('abcd…');
    expect(fitBoard('abcdefghij', board, 0.1, 0.2, 0.4)).toBeNull();
  });

  test('a board stays inside its front', () => {
    const width = 2.4;
    const fit = fitBoard('abcdefghij', board, width, 0.2, 0.34)!;
    const out = new PlateBuffers();
    const at = { x: 3, y: 2.7, z: 0, angle: -Math.PI / 2, text: fit.text };
    addPlate(
      out,
      { ...at, style: { ...board, height: fit.height, minWidth: width / fit.height } },
      ink,
    );
    for (let i = 0; i < out.vertices; i++) {
      expect(Math.abs(out.positions[i * 3]! - 3)).toBeLessThanOrEqual(width / 2 + 1e-6);
      expect(Math.abs(out.positions[i * 3 + 1]! - 2.7)).toBeLessThanOrEqual(fit.height / 2 + 1e-6);
    }
  });
});

const hue = (c: number) => {
  const [, a, b] = toOklab(c);
  return Math.atan2(b, a);
};

describe("a board's paint", () => {
  test('takes paper letters at 4.5:1 or more on every kind of front', () => {
    for (const kind of SHOP_KINDS) {
      expect(contrast(boardColour(FRONTS[kind], PLATE.paper), PLATE.paper)).toBeGreaterThanOrEqual(
        4.5,
      );
    }
    expect(contrast(0xffffff, 0)).toBeCloseTo(21, 9);
    expect(contrast(0, 0xffffff)).toBeCloseTo(21, 9);
  });

  test('converts to linear light as colour.ts does', () => {
    for (const hex of [0, 0xffffff, 0x0a0a0a, 0x8c2f3a, FRONTS.cafe.canvas]) {
      const want = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map(linear);
      expect(linearRgb(hex).map((u, i) => u - want[i]!)).toEqual([0, 0, 0]);
      expect(linearRgb(hex).map(gamma)).toEqual([(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]);
    }
  });

  test("is its kind's colour, deepened by lightness alone", () => {
    for (const kind of SHOP_KINDS) {
      const { canvas, stripe = canvas } = FRONTS[kind];
      const paint = boardColour(FRONTS[kind], PLATE.paper);
      const base = toOklab(stripe)[0] < toOklab(canvas)[0] ? stripe : canvas;
      expect(toOklab(paint)[0]).toBeLessThanOrEqual(toOklab(base)[0] + 1e-3);
      if (Math.hypot(...toOklab(base).slice(1)) > 0.03) {
        const turn = Math.abs(
          Math.atan2(Math.sin(hue(paint) - hue(base)), Math.cos(hue(paint) - hue(base))),
        );
        expect(turn).toBeLessThan(0.2);
      }
    }
    // A dark canvas is left as it is; a bakery's cream gives way to its brown stripe.
    expect(boardColour(FRONTS.books, PLATE.paper)).toBe(FRONTS.books.canvas);
    expect(deltaE(boardColour(FRONTS.bakery, PLATE.paper), FRONTS.bakery.stripe!)).toBeLessThan(
      0.2,
    );
  });
});

describe('plateWidth', () => {
  test('is the caps and letters, or the least width', () => {
    expect(plateWidth('12', style)).toBeCloseTo(1.5);
    expect(plateWidth('1212', style)).toBeCloseTo(0.6 + 1.8);
    expect(plateWidth('', style)).toBe(1.5);
  });

  test('skips letters it has no slice for', () => {
    expect(plateWidth('1x2x', style)).toBeCloseTo(plateWidth('12', style));
  });
});

test('plateOutline goes round four rounded corners, counter-clockwise', () => {
  const points = plateOutline(2, 1, 0.2);
  expect(points).toHaveLength(32);
  let area = 0;
  for (let i = 0; i < points.length; i += 2) {
    const j = (i + 2) % points.length;
    area += points[i]! * points[j + 1]! - points[j]! * points[i + 1]!;
  }
  // Counter-clockwise, and just under the full rectangle for the rounded corners.
  expect(area / 2).toBeGreaterThan(1.95);
  expect(area / 2).toBeLessThan(2);
  for (let i = 0; i < points.length; i += 2) {
    expect(Math.abs(points[i]!)).toBeLessThanOrEqual(1 + 1e-9);
    expect(Math.abs(points[i + 1]!)).toBeLessThanOrEqual(0.5 + 1e-9);
  }
  // A radius larger than the plate is clamped to it.
  expect(Math.max(...plateOutline(1, 0.2, 5).filter((_, i) => i % 2 === 1))).toBeCloseTo(0.1);
});

describe('addPlate', () => {
  const plate = { x: 10, y: 2, z: -4, angle: Math.PI / 2, text: '12', style };

  test('builds a face that looks along the wall normal and sides that reach the wall', () => {
    const out = new PlateBuffers();
    addPlate(out, plate, ink);
    expect(out.vertices).toBeGreaterThan(40);
    expect(out.count % 3).toBe(0);
    // The face looks +z (angle a quarter turn): its normals; every vertex within the plate.
    const zs: number[] = [];
    for (let v = 0; v < out.vertices; v++) {
      const [x, y, z] = [
        out.positions[v * 3]!,
        out.positions[v * 3 + 1]!,
        out.positions[v * 3 + 2]!,
      ];
      expect(Math.abs(x - 10)).toBeLessThanOrEqual((1.5 * 0.25) / 2 + 1e-5);
      expect(Math.abs(y - 2)).toBeLessThanOrEqual(0.125 + 1e-5);
      zs.push(z);
    }
    expect(Math.max(...zs)).toBeCloseTo(-4);
    expect(Math.min(...zs)).toBeCloseTo(-4 - PLATE_DEPTH);
    expect(out.normals[2]).toBeCloseTo(1);
    // Every index points at a vertex.
    for (let i = 0; i < out.count; i++) expect(out.indices[i]!).toBeLessThan(out.vertices);
  });

  test('turns the face counter-clockwise toward the viewer in front of it', () => {
    const out = new PlateBuffers();
    addPlate(out, plate, ink);
    const p = (i: number) => [0, 1, 2].map((k) => out.positions[out.indices[i]! * 3 + k]!);
    const [a, b, c] = [p(0), p(1), p(2)];
    const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    // The cross product of the first triangle points out of the face (+z).
    expect(e1[0]! * e2[1]! - e1[1]! * e2[0]!).toBeGreaterThan(0);
  });

  test('maps letters onto their slices and the sides onto ink', () => {
    const out = new PlateBuffers();
    addPlate(out, plate, ink);
    const us = new Set<number>();
    for (let v = 0; v < out.vertices; v++) us.add(Math.round(out.uvs[v * 2]! * 100) / 100);
    for (const u of [0.3, 0.4, 0.5, 0.9]) expect(us).toContain(u);
  });

  test('pads a short text with blank enamel, and none a long one', () => {
    const short = new PlateBuffers();
    addPlate(short, { ...plate, text: '1' }, ink);
    const long = new PlateBuffers();
    addPlate(long, { ...plate, text: '1212' }, ink);
    // One letter and two pads against four letters: the same number of quads.
    expect(short.vertices).toBe(long.vertices - 4);
  });

  test('carries its tint on every vertex', () => {
    const out = new PlateBuffers();
    out.tint = [0.5, 0.25, 0.125];
    addPlate(out, { x: 0, y: 0, z: 0, angle: 0, text: '12', style }, ink);
    expect(out.colors.length).toBeGreaterThanOrEqual(out.vertices * 3);
    for (let i = 0; i < out.vertices; i++) {
      expect([...out.colors.subarray(i * 3, i * 3 + 3)]).toEqual([0.5, 0.25, 0.125]);
    }
  });

  test('grows its buffers and starts over on reset', () => {
    const out = new PlateBuffers();
    for (let i = 0; i < 50; i++) addPlate(out, { ...plate, x: i }, ink);
    const one = new PlateBuffers();
    addPlate(one, plate, ink);
    expect(out.vertices).toBe(one.vertices * 50);
    expect(out.positions[(one.vertices * 49 + 1) * 3 - 3]).toBeCloseTo(49, 0);
    out.reset();
    expect([out.vertices, out.count]).toEqual([0, 0]);
    addPlate(out, plate, ink);
    expect(Array.from(out.positions.slice(0, 9))).toEqual(Array.from(one.positions.slice(0, 9)));
  });
});

describe('packCells', () => {
  test('lays cells in rows, a gutter apart, and rounds the height up', () => {
    const { at, height } = packCells(
      [
        { width: 40, height: 20 },
        { width: 40.5, height: 30 },
        { width: 40, height: 20 },
      ],
      120,
      4,
    );
    expect(at).toEqual([
      [4, 4],
      [48, 4],
      [4, 38],
    ]);
    expect(height).toBe(64);
  });

  test('a cell wider than the atlas still gets a row of its own', () => {
    expect(packCells([{ width: 500, height: 10 }], 100, 2).at).toEqual([[2, 2]]);
    expect(packCells([], 100, 2).height).toBe(4);
  });
});

describe('Walls', () => {
  // Rising 0.1 m a metre to the east.
  const slope = new Terrain({
    step: 100,
    minX: -100,
    minZ: -100,
    cols: 3,
    rows: 3,
    heights: Float32Array.of(-10, 0, 10, -10, 0, 10, -10, 0, 10),
  });
  // A house from x = 23 to 60, its lowest corner at 2.3 m (it stands at 2), drawn on its own
  // footprint; and one further west whose walls are drawn on a ring 20 cm inside its footprint,
  // as a hipped roof's are.
  const rings = [
    Float32Array.of(23, 0, 60, 0, 60, 10, 23, 10),
    Float32Array.of(-43, 30, -30, 30, -30, 40),
  ];
  const drawn = [rings[0]!, Float32Array.of(-42.8, 30.2, -30.2, 30.2, -30.2, 39.4)];
  const walls = new Walls(rings, {
    facade: (b) => ({
      rings: [drawn[b]!],
      foot: footing(slope, rings[b]!),
      top: 9 + b,
      shop: (nx) => b === 1 && nx > -2,
    }),
    height: (x, z) => slope.height(x, z),
  });
  const face = PLATE_DEPTH - 0.01;

  test('a plate hangs from the foot of its house, wherever along the wall it is', () => {
    // On the front wall (z = 0, facing -z), at either end.
    expect(walls.hang(25, -0.05, -Math.PI / 2, 0.5).foot).toBeCloseTo(2);
    expect(walls.hang(58, -0.05, -Math.PI / 2, 0.5).foot).toBeCloseTo(2);
    // On the east wall, facing +x.
    const east = walls.hang(60.05, 5, 0, 0.5);
    expect([east.foot, east.top, east.shop]).toEqual([2, 9, false]);
    expect(walls.hang(-35, 29.95, -Math.PI / 2, 0.5).foot).toBeCloseTo(-4.5);
  });

  test('settles onto the drawn wall: its facing, just off it, its sides tucked in', () => {
    // Hung a few centimetres out and a little turned, it comes to the wall's own facing.
    const at = walls.hang(40, -0.08, -Math.PI / 2 + 0.02, 0.5);
    expect(at.angle).toBeCloseTo(-Math.PI / 2);
    expect(at.x).toBeCloseTo(40);
    expect(at.z).toBeCloseTo(-face);
    // The western house's walls stand 20 cm in from its footprint: the plate follows them in.
    const west = walls.hang(-36, 29.94, -Math.PI / 2, 0.5);
    expect(west.z).toBeCloseTo(30.2 - face);
    expect([west.top, west.shop]).toEqual([10, true]);
  });

  test('keeps a plate within its wall where it fits, and lets a long one overhang', () => {
    expect(walls.hang(23.2, -0.05, -Math.PI / 2, 1).x).toBeCloseTo(24);
    expect(walls.hang(59.9, -0.05, -Math.PI / 2, 1).x).toBeCloseTo(59);
    // The east wall is 10 m long: a 12 m plate stays where it was put.
    expect(walls.hang(60.05, 9, 0, 6).z).toBeCloseTo(9);
  });

  test('leaves a plate be where no drawn wall faces its way nearby', () => {
    // Facing +z on the front wall, which faces -z: no wall of the house faces that way near it.
    const at = walls.hang(40, 0.5, Math.PI / 2, 0.5);
    expect([at.x, at.z, at.angle]).toEqual([40, 0.5, Math.PI / 2]);
  });

  test('a plate on no house hangs over the ground at its point', () => {
    const at = walls.hang(80, 50, 0, 0.5);
    expect(at.foot).toBeCloseTo(8);
    expect([at.x, at.z]).toEqual([80, 50]);
  });
});

describe('plateHeights', () => {
  const [house, street] = [HOUSE_PLATE_HEIGHT / 2, STREET_PLATE_HEIGHT / 2];

  test('hangs between the ground floor openings and the first floor sills', () => {
    // Three storeys of 3.2 m: windows to 2.56 m, the next sills at 4.22 m.
    const { house: h, street: s } = plateHeights(9.6, false);
    expect(h - house).toBeGreaterThan(2.56);
    expect(s - street).toBeGreaterThan(h + house);
    expect(s + street).toBeLessThan(4.22);
    // Low and tall storeys alike.
    for (const top of [5.6, 6, 7, 8, 10, 11.5, 13, 16, 20, 30]) {
      const storey = Math.min(4, Math.max(2.8, top / Math.max(1, Math.round(top / 3.2))));
      const heights = plateHeights(top, false);
      expect(heights.house - house).toBeGreaterThan(0.8 * storey);
      expect(heights.street - street).toBeGreaterThan(heights.house + house);
      expect(heights.street + street).toBeLessThan(1.32 * storey);
    }
  });

  test('clears the awning over a shop front', () => {
    expect(plateHeights(9.6, true).house - house).toBeGreaterThan(0.97 * 3.2);
    expect(plateHeights(9.6, true).street + street).toBeLessThan(1.32 * 3.2);
    expect(plateHeights(9.6, true).street).toBeGreaterThan(plateHeights(9.6, false).street - 1e-9);
  });

  test("hangs a name board over the shop window, under the ground floor's top", () => {
    for (const top of [5.6, 6, 8, 9.6, 13, 20]) {
      const storey = Math.min(4, Math.max(2.8, top / Math.max(1, Math.round(top / 3.2))));
      const { fascia, house: h } = plateHeights(top, true);
      // The highest fascia board is 0.45 m: clear of the panes, of the first floor and the number.
      expect(fascia - 0.225).toBeGreaterThan(0.72 * storey);
      expect(fascia + 0.225).toBeLessThan(storey);
      expect(fascia + 0.225).toBeLessThan(h - house);
    }
  });

  test("or on the middle of its awning's valance, just in front of it", () => {
    // A front 2 m wide on a wall 12 m tall facing -z, its house's foot at 0.
    const ring = new Float32Array([0, 0, 12, 0, 12, 10, 0, 10]);
    const p = frontPoint(ring, { edge: 0, along: 6 });
    const mesh = new MeshBuilder();
    addAwning(mesh, p, 'cafe', 12, 1, 0);
    const g = mesh.build();
    const position = g.getAttribute('position');
    const front = Array.from({ length: position.count }, (_, i) => [
      position.getY(i),
      position.getZ(i),
    ])
      .filter(([, z]) => Math.abs(z! + AWNING_REACH) < 1e-6)
      .map(([y]) => y!);
    expect(front.length).toBeGreaterThan(0);
    const middle = (Math.min(...front) + Math.max(...front)) / 2;
    expect(plateHeights(12, false).valance).toBeCloseTo(middle, 6);
    expect(plateHeights(12, true).valance).toBeCloseTo(middle, 6);
  });

  test('stays under the eaves of a low house', () => {
    const { house: h, street: s } = plateHeights(3.4, false);
    expect(h + house).toBeLessThan(3.4);
    expect(s + street).toBeLessThan(3.4);
  });
});
