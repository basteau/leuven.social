import { expect, test } from 'bun:test';

import { PLACES, SHOP_KINDS } from '../data/shop-kinds.ts';
import type { ShopKind } from '../data/shop-kinds.ts';
import { MeshBuilder } from './mesh-builder.ts';
import { FRONTS } from './palette.ts';
import type { Frame } from './prop-shapes.ts';
import {
  BOARD,
  LOW_EDGE,
  SIGN_SCALE,
  addBanner,
  addBarberPole,
  addFlags,
  addHangings,
  addMarquee,
  addMedallion,
  addSign,
  bar,
  disc,
  groundFloor,
  signHeight,
  slab,
} from './signs.ts';

// A wall along x at z = 0, facing north (-z): u runs along it (+x), v out of it (-z).
const f: Frame = { x: 10, z: 0, fx: 0, fz: -1, scale: 1 };

const built = (draw: (mesh: MeshBuilder) => unknown) => {
  const mesh = new MeshBuilder();
  draw(mesh);
  const p = mesh.build().getAttribute('position');
  return Array.from({ length: p.count }, (_, i) => [p.getX(i), p.getY(i), p.getZ(i)] as const);
};
const span = (
  points: readonly (readonly [number, number, number])[],
  axis: 0 | 1 | 2,
): [number, number] => [
  Math.min(...points.map((p) => p[axis])),
  Math.max(...points.map((p) => p[axis])),
];
/** A span, to float precision: positions are 32-bit. */
const spans = (
  points: readonly (readonly [number, number, number])[],
  axis: 0 | 1 | 2,
  [a, b]: readonly [number, number],
) => {
  const [low, high] = span(points, axis);
  expect(low).toBeCloseTo(a, 5);
  expect(high).toBeCloseTo(b, 5);
};

test('the ground floor is as tall as the shader draws it', () => {
  expect(groundFloor(12)).toBe(3);
  expect(groundFloor(5)).toBe(2.8);
  expect(groundFloor(30)).toBeCloseTo(3.33);
});

test('a slab is a flat shape seen from both sides, its edges turned out', () => {
  const triangle = built((m) =>
    slab(
      m,
      f,
      [-0.1, 0.1],
      [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
      0xffffff,
    ),
  );
  // Two faces of three corners, three edges of four.
  expect(triangle).toHaveLength(6 + 12);
  spans(triangle, 0, [9.9, 10.1]);
  spans(triangle, 2, [-1, 0]);
  // Wound the other way, the same shape.
  const back = built((m) =>
    slab(
      m,
      f,
      [-0.1, 0.1],
      [
        [0, 1],
        [1, 0],
        [0, 0],
      ],
      0xffffff,
    ),
  );
  expect(back).toHaveLength(18);
});

test('a bar runs between its ends, as wide as asked; a disc is a ring of corners', () => {
  const b = built((m) => bar(m, f, 0.05, [0, 1], [2, 1], 0.2, 0xffffff));
  spans(b, 1, [0.9, 1.1]);
  spans(b, 2, [-2, 0]);
  // A bar of no length is nothing, not a broken shape.
  expect(built((m) => bar(m, f, 0.05, [1, 1], [1, 1], 0.2, 0xffffff))).toHaveLength(0);
  const d = built((m) => disc(m, f, 0.05, [1, 2], 0.5, 8, 0xffffff));
  expect(d).toHaveLength(6 * 8);
  for (const [, y, z] of d) expect(Math.hypot(-z - 1, y - 2)).toBeCloseTo(0.5);
});

test('every shop has a sign but those whose goods or pole say it', () => {
  const none = new Set<ShopKind>(['greengrocer', 'florist', 'hairdresser']);
  for (const kind of SHOP_KINDS) {
    if (PLACES.has(kind)) continue;
    const mesh = new MeshBuilder();
    expect(addSign(mesh, f, kind, 3.6)).toBe(!none.has(kind));
  }
});

test('signs hang square to the wall, out over the street and over the walker’s head', () => {
  const y = signHeight(12);
  expect(y - BOARD.half * SIGN_SCALE).toBeGreaterThan(LOW_EDGE);
  for (const kind of SHOP_KINDS.filter((k) => !PLACES.has(k))) {
    const points = built((m) => addSign(m, f, kind, y));
    if (points.length === 0) continue;
    const [low, high] = span(points, 1);
    expect(low).toBeGreaterThan(LOW_EDGE);
    // A frituur's fries stand a little over its bracket.
    expect(high).toBeLessThanOrEqual(y + 0.6 * SIGN_SCALE);
    // Out of the wall, and no further than its bracket reaches.
    const [near, far] = span(points, 2);
    expect(-far).toBeGreaterThanOrEqual(-1e-6);
    expect(-near).toBeLessThanOrEqual(BOARD.out[1] * SIGN_SCALE + 1e-6);
    // Thin along the wall, so it reads down the street.
    const [a, b] = span(points, 0);
    expect(b - a).toBeLessThan(0.75);
  }
});

test('the signs are a few dozen to a few hundred vertices each', () => {
  const sizes = Object.fromEntries(
    (['cafe', 'bar', 'pharmacy', 'bicycle', 'restaurant', 'school'] as const).map((kind) => [
      kind,
      built((m) => addSign(m, f, kind, 3.6)).length,
    ]),
  );
  expect(sizes).toEqual({
    cafe: 100,
    bar: 80,
    pharmacy: 60,
    bicycle: 20 + 12 * 24 + 6 * 24 + 20,
    restaurant: 112,
    school: 20 + 30 + 24 + 24 + 24 + 12 + 6,
  });
});

test('every kind’s symbol is cheap: about 110 vertices on average', () => {
  const sizes = SHOP_KINDS.filter((k) => !PLACES.has(k)).map(
    (kind) => built((m) => addSign(m, f, kind, 3.6)).length,
  );
  const drawn = sizes.filter((n) => n > 0);
  expect(drawn.reduce((a, b) => a + b, 0) / drawn.length).toBeLessThan(200);
});

test('a public place without a door of its own has a medallion, and no flag', () => {
  const quiet = built((m) => addMedallion(m, f, 'dorm', 3.6));
  expect(quiet.length).toBeGreaterThan(150);
  expect(span(quiet, 1)[1]).toBeLessThan(6);
});

test('a barber’s pole stands by the wall, its bands winding, its foot over the walker', () => {
  const points = built((m) => addBarberPole(m, f, 12));
  expect(points).toHaveLength(220);
  const [low] = span(points, 1);
  expect(low).toBeGreaterThan(LOW_EDGE - 0.35);
  expect(-span(points, 2)[0]).toBeLessThan(0.45);
});

test('a banner hangs from high on the wall, and none from a wall too low for it', () => {
  const tall = built((m) => expect(addBanner(m, f, 'university', 12)).toBe(true));
  expect(tall).toHaveLength(60);
  expect(span(tall, 1)[0]).toBeGreaterThanOrEqual(LOW_EDGE);
  expect(addBanner(new MeshBuilder(), f, 'university', 3.5)).toBe(false);
});

test('a hotel’s three flags hang side by side, over the walker’s head', () => {
  const points = built((m) => addFlags(m, f, 9));
  expect(points).toHaveLength(120);
  spans(points, 0, [8.77, 11.23]);
  expect(span(points, 1)[0]).toBeGreaterThan(LOW_EDGE);
});

test('a museum’s hangings lie flat on a tall front; a low one has none', () => {
  const points = built((m) => expect(addHangings(m, f, 'museum', 12)).toBe(true));
  expect(points).toHaveLength(80);
  expect(-span(points, 2)[0]).toBeLessThan(0.1);
  expect(addHangings(new MeshBuilder(), f, 'museum', 5)).toBe(false);
});

test('a marquee reaches out over a cinema’s door, bulbs along its edge', () => {
  const points = built((m) => addMarquee(m, f, 'cinema', 12));
  expect(points).toHaveLength(20 + 11 * 20);
  expect(span(points, 1)[0]).toBeGreaterThan(LOW_EDGE);
});

test('a public place’s sign: a pencil, a book, a red cross, a ball', () => {
  for (const kind of ['school', 'library', 'hospital', 'sports'] as const) {
    expect(built((m) => addSign(m, f, kind, 3.6)).length).toBeGreaterThan(60);
  }
});

/** The colours a kind's sign is drawn in, as 24-bit sRGB. */
const colours = (kind: ShopKind) => {
  const mesh = new MeshBuilder();
  addSign(mesh, f, kind, 4);
  const c = mesh.build().getAttribute('color');
  return new Set(
    Array.from(
      { length: c.count },
      (_, i) =>
        (Math.round(c.getX(i) * 255) << 16) |
        (Math.round(c.getY(i) * 255) << 8) |
        Math.round(c.getZ(i) * 255),
    ),
  );
};

test('a board takes its kind’s own board colour where the canvas would read as a dark block', () => {
  const fashion = colours('fashion');
  expect(fashion.has(FRONTS.fashion.board!)).toBe(true);
  expect(fashion.has(FRONTS.fashion.canvas)).toBe(false);
  // Without one, the board is the canvas, as the awning is.
  expect(colours('cafe').has(FRONTS.cafe.canvas)).toBe(true);
});
