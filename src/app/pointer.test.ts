import { describe, expect, test } from 'bun:test';

import { pinOpacity, pointerFor } from './pointer.ts';

const inset = { top: 30, right: 20, bottom: 40, left: 10 };

describe('the diamond over the avatar', () => {
  test('none while its figure is on screen', () => {
    expect(pointerFor(400, 300, 800, 600, true)).toBeNull();
  });

  test('over it, pointing down, while the view is too far out for its figure', () => {
    expect(pointerFor(400, 300, 800, 600, false)).toEqual({
      x: 400,
      y: 300,
      angle: 0,
      edge: false,
    });
  });

  test('off screen, at the edge inside the HUD, pointing toward it', () => {
    // The inset rectangle runs from (10, 30) to (780, 560); its middle is (395, 295).
    const right = pointerFor(2000, 295, 800, 600, true, inset)!;
    expect(right).toMatchObject({ x: 780, y: 295, edge: true });
    expect(right.angle).toBeCloseTo(-Math.PI / 2);
    const below = pointerFor(395, 5000, 800, 600, false, inset)!;
    expect(below).toMatchObject({ x: 395, y: 560 });
    expect(below.angle).toBeCloseTo(0);
    const above = pointerFor(395, -10, 800, 600, true, inset)!;
    expect(above.y).toBe(30);
    expect(Math.abs(above.angle)).toBeCloseTo(Math.PI);
    const left = pointerFor(-50, 295, 800, 600, true, inset)!;
    expect(left.x).toBe(10);
    // Up and to the left: on the rectangle, toward the corner.
    const corner = pointerFor(-400, -300, 800, 600, true, inset)!;
    expect(corner.x).toBeGreaterThanOrEqual(10 - 1e-9);
    expect(corner.y).toBeGreaterThanOrEqual(30 - 1e-9);
    expect(Math.min(corner.x - 10, corner.y - 30)).toBeCloseTo(0);
    // With the HUD's own insets by default.
    expect(pointerFor(2000, 300, 800, 600, true)!.x).toBe(800 - 96);
  });

  test('at the edge too while it stands under the controls round the screen', () => {
    // 10 px inside the bottom right corner, under the menu button: on the rectangle's bottom,
    // toward its corner.
    for (const figure of [true, false]) {
      const corner = pointerFor(790, 590, 800, 600, figure, inset)!;
      expect(corner).toMatchObject({ y: 560, edge: true });
      expect(corner.x).toBeGreaterThan(700);
      expect(corner.x).toBeLessThan(780);
      expect(corner.angle).toBeGreaterThan(-Math.PI / 2);
      expect(corner.angle).toBeLessThan(0);
    }
    // Under the top edge, with the HUD's own inset (the shell adds the top row's height).
    expect(pointerFor(400, 10, 800, 600, true)).toMatchObject({ y: 28, edge: true });
    // Just inside the rectangle, it is on screen as ever.
    expect(pointerFor(780, 560, 800, 600, true, inset)).toBeNull();
    expect(pointerFor(10, 30, 800, 600, false, inset)).toMatchObject({ edge: false });
  });

  test('nowhere for a point that isn’t one', () => {
    expect(pointerFor(Number.NaN, 0, 800, 600, true)).toBeNull();
  });
});

const pinAt = (far: number, x: number, y: number, ax = 0, ay = 0) =>
  pinOpacity(far, x, y, ax, ay, 800, 600);

describe('pinOpacity', () => {
  test('as much as the zoom asks for, while you are a way off', () => {
    expect(pinAt(1, 400, 300)).toBe(1);
    expect(pinAt(0.5, 400, 300)).toBe(0.5);
    expect(pinAt(0, 400, 300)).toBe(0);
  });

  test('it gives way as you get there, so it never stands on your diamond', () => {
    expect(pinAt(1, 400, 300, 400, 310)).toBe(0);
    expect(pinAt(1, 400, 300, 400, 335)).toBeCloseTo(0.5, 5);
    expect(pinAt(1, 400, 300, 400, 360)).toBe(1);
  });

  test('none off the map, but its head may show from just past an edge', () => {
    expect(pinAt(1, -40, 300)).toBe(0);
    expect(pinAt(1, 840, 300)).toBe(0);
    expect(pinAt(1, 400, -1)).toBe(0);
    expect(pinAt(1, 400, 670)).toBe(0);
    expect(pinAt(1, 820, 300)).toBe(1);
    expect(pinAt(1, 400, 640)).toBe(1);
  });

  test('with no diamond placed yet it is whole', () => {
    expect(pinAt(1, 400, 300, Infinity, Infinity)).toBe(1);
  });
});
