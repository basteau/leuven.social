import { describe, expect, test } from 'bun:test';

import {
  CAMERA_DISTANCE,
  MAX_ZOOM,
  MIN_ZOOM,
  NO_FOG,
  PITCH,
  SPANS,
  VIEW_HEIGHT,
  detailAt,
  fogRange,
  spanOf,
} from './lod.ts';

describe('the one camera', () => {
  test('zooms from the whole city down to a street three houses wide', () => {
    expect(spanOf(MIN_ZOOM)).toBe(2 * VIEW_HEIGHT);
    expect(spanOf(1)).toBe(VIEW_HEIGHT);
    expect(spanOf(MAX_ZOOM)).toBe(14);
    expect(PITCH).toBeCloseTo((35.26 * Math.PI) / 180, 3);
  });
});

/** How much a span draws: each detail on, and the avatar as a marker (1) or a figure (2). */
const count = (span: number) =>
  Object.values(detailAt(span)).filter((v) => v === true || v === 'figure').length +
  (detailAt(span).avatar === 'none' ? 0 : 1);

describe('the level-of-detail table', () => {
  test('the city alone from far out', () => {
    expect(detailAt(spanOf(1))).toEqual({
      furniture: false,
      avatar: 'none',
      streetShadows: false,
      prewarm: false,
    });
  });

  test('each threshold adds its detail and keeps what came before', () => {
    expect(detailAt(SPANS.city).avatar).toBe('marker');
    expect(detailAt(SPANS.furniture)).toMatchObject({ furniture: true, avatar: 'marker' });
    expect(detailAt(SPANS.figure)).toMatchObject({ furniture: true, avatar: 'figure' });
    expect(detailAt(SPANS.street)).toEqual({
      furniture: true,
      avatar: 'figure',
      streetShadows: true,
      prewarm: true,
    });
    expect(detailAt(spanOf(MAX_ZOOM))).toEqual(detailAt(SPANS.street));
  });

  test('furniture keeps its old threshold: zoom 2', () => {
    expect(detailAt(spanOf(2)).furniture).toBe(true);
    expect(detailAt(spanOf(1.99)).furniture).toBe(false);
  });

  test('detail only grows as the view closes in', () => {
    let last = -1;
    for (let span = spanOf(MIN_ZOOM); span >= spanOf(MAX_ZOOM); span *= 0.9) {
      const now = count(span);
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
  });
});

describe('fog by span', () => {
  test('none on the map', () => {
    expect(fogRange(spanOf(1))).toBe(NO_FOG);
    expect(fogRange(120)).toBe(NO_FOG);
  });

  test('close in, the top of the screen fades a little, the middle not at all', () => {
    const span = spanOf(MAX_ZOOM);
    const [near, far] = fogRange(span);
    // The ground at the middle of the screen is CAMERA_DISTANCE away; at its top edge, about
    // half the span times √2 further.
    const top = CAMERA_DISTANCE + (span / 2) * Math.SQRT2;
    expect(near).toBeGreaterThan(CAMERA_DISTANCE);
    expect(near).toBeLessThan(top);
    expect(far).toBeGreaterThan(top);
  });

  test('comes in smoothly as the span shrinks', () => {
    let last = Infinity;
    for (let span = 119; span >= 14; span -= 1) {
      const [near, far] = fogRange(span);
      expect(far).toBeGreaterThan(near);
      const share = (near - CAMERA_DISTANCE) / span;
      expect(share).toBeLessThanOrEqual(last + 1e-9);
      last = share;
    }
    // Just under the threshold it's still past anything on screen.
    expect(fogRange(119)[0] - CAMERA_DISTANCE).toBeGreaterThan(119 * 5);
  });
});
