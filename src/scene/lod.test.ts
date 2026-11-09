import { describe, expect, test } from 'bun:test';

import {
  CAMERA_DISTANCE,
  MAX_ZOOM,
  MIN_ZOOM,
  NO_FOG,
  PEOPLE,
  PITCH,
  RIG_HOLD,
  RIG_LOSE,
  RIG_WIN,
  SPANS,
  VIEW_HEIGHT,
  crowdFade,
  detailAt,
  figureAlpha,
  figurePixels,
  fogRange,
  groundRect,
  inGround,
  markShare,
  markerAlpha,
  rigAlpha,
  spanOf,
  wantsRig,
} from './lod.ts';

describe('the one camera', () => {
  test('zooms from the whole city down to a street three houses wide', () => {
    expect(spanOf(MIN_ZOOM)).toBe(2 * VIEW_HEIGHT);
    expect(spanOf(1)).toBe(VIEW_HEIGHT);
    expect(spanOf(MAX_ZOOM)).toBe(14);
    expect(PITCH).toBeCloseTo((35.26 * Math.PI) / 180, 3);
  });
});

const H = 800;
/** How much a span draws: each detail on. */
const count = (span: number) => Object.values(detailAt(span, H)).filter((v) => v === true).length;

describe('the level-of-detail table', () => {
  test('the city alone from far out', () => {
    expect(detailAt(spanOf(1), H)).toEqual({
      furniture: false,
      figure: false,
      streetShadows: false,
      prewarm: false,
    });
  });

  test('each threshold adds its detail and keeps what came before', () => {
    expect(detailAt(SPANS.furniture, H)).toMatchObject({ furniture: true });
    expect(detailAt(SPANS.street, H)).toEqual({
      furniture: true,
      figure: true,
      streetShadows: true,
      prewarm: true,
    });
    expect(detailAt(spanOf(MAX_ZOOM), H)).toEqual(detailAt(SPANS.street, H));
  });

  test('furniture keeps its old threshold: zoom 2', () => {
    expect(detailAt(spanOf(2), H).furniture).toBe(true);
    expect(detailAt(spanOf(1.99), H).furniture).toBe(false);
  });

  test('the avatar\u2019s figure goes by pixels, so a phone matches a desktop', () => {
    expect(detailAt(spanOf(2), 800).figure).toBe(figurePixels(800, 2) >= 7.5);
    // A taller window shows a figure bigger at the same zoom: it reads sooner.
    expect(detailAt(spanOf(3.2), 800).figure).toBe(false);
    expect(detailAt(spanOf(3.4), 800).figure).toBe(true);
    expect(detailAt(spanOf(3.4), 500).figure).toBe(false);
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

describe('people by the pixels of a figure', () => {
  test('a figure of 91 px at the closest zoom in an 800 px window', () => {
    expect(figurePixels(800, MAX_ZOOM)).toBeCloseTo(90.9, 0);
    expect(figurePixels(800, 1)).toBeCloseTo(2.3, 1);
  });

  test('a full figure gives way to a crowd figure, whole until they swap', () => {
    expect(rigAlpha(PEOPLE.rig)).toBe(1);
    expect(rigAlpha(PEOPLE.rigGone)).toBe(0);
    expect(rigAlpha((PEOPLE.rig + PEOPLE.rigGone) / 2)).toBeCloseTo(0.5, 5);
  });

  test('a marker fades in over a whole figure, which goes only once the marker hides it', () => {
    expect(figureAlpha(PEOPLE.markerWhole)).toBe(1);
    expect(figureAlpha(PEOPLE.figureGone)).toBe(0);
    expect(figureAlpha((PEOPLE.figureGone + PEOPLE.markerWhole) / 2)).toBeCloseTo(0.5, 5);
    expect(markerAlpha(PEOPLE.markerFrom)).toBe(0);
    expect(markerAlpha(PEOPLE.markerWhole)).toBe(1);
    expect(markerAlpha(1)).toBe(1);
  });

  test('a swap adds up to one person: rig, then whichever of figure or marker takes the rest', () => {
    for (const rig of [0, 0.25, 0.5, 0.9]) {
      for (const fits of [0, 0.3, 1]) {
        const crowd = Math.abs(crowdFade(rig, fits, 1, 0.5));
        expect(rig * 0.5 + crowd + markShare(rig, fits, 0) * 0.5).toBeCloseTo(0.5, 5);
      }
    }
    // Whole and swapping: the rig's own complement, drawing exactly the pixels it leaves.
    expect(crowdFade(0.25, 1, 1, 1)).toBe(-0.25);
    expect(markShare(0.25, 1, 0)).toBe(0);
    // Over the cap with a rig fading in: the marker holds what the rig doesn't yet.
    expect(crowdFade(0.25, 0, 1, 1)).toBe(0);
    expect(markShare(0.25, 0, 0)).toBe(0.75);
    // No rig at all at this zoom: a whole figure and a marker over it, as the band wants.
    expect(crowdFade(0, 1, 1, 1)).toBe(1);
    expect(markShare(0, 1, markerAlpha(PEOPLE.markerWhole))).toBe(1);
  });

  test('nothing pops: every alpha moves a little for a small step of the zoom', () => {
    for (let p = 2; p < 30; p += 0.05) {
      expect(Math.abs(figureAlpha(p + 0.05) - figureAlpha(p))).toBeLessThan(0.05);
      expect(Math.abs(markerAlpha(p + 0.05) - markerAlpha(p))).toBeLessThan(0.05);
      expect(Math.abs(rigAlpha(p + 0.05) - rigAlpha(p))).toBeLessThan(0.05);
    }
  });

  test('rig ranks: won at 24, kept to 30, and at least a second once had', () => {
    expect(wantsRig(RIG_WIN, false, 0)).toBe(true);
    expect(wantsRig(RIG_WIN + 1, false, 0)).toBe(false);
    expect(wantsRig(RIG_LOSE, true, 5000)).toBe(true);
    expect(wantsRig(RIG_LOSE + 1, true, 5000)).toBe(false);
    expect(wantsRig(RIG_LOSE + 1, true, RIG_HOLD - 1)).toBe(true);
    expect(wantsRig(0, true, RIG_HOLD)).toBe(false);
  });
});

describe('the ground a view sees', () => {
  test('its reach is the true half-diagonal: span and pitch', () => {
    const r = groundRect(0, 0, 100, 1.6, 0);
    expect(r.reach).toBeCloseTo(Math.hypot(80, 50 / Math.sin(PITCH)), 5);
  });

  test('a turned view sees the same ground turned', () => {
    const r = groundRect(0, 0, 100, 1, Math.PI / 2);
    expect(inGround(r, 40, 0)).toBe(true);
    expect(inGround(r, 0, 45)).toBe(true);
    // Along the screen only half the span, across the depth nearly twice as far.
    expect(inGround(r, 60, 0)).toBe(true);
    expect(inGround(r, 0, 60)).toBe(false);
  });

  test('the rectangle, not a circle: a corner of the window is in view', () => {
    const r = groundRect(10, -10, 100, 2, 0);
    expect(inGround(r, 10 + 95, -10)).toBe(true);
    expect(inGround(r, 10 + 110, -10)).toBe(false);
  });

  test('writes into a reused object and adds its margin', () => {
    const out = groundRect(0, 0, 100, 1, 0);
    const r = groundRect(1, 2, 50, 2, 1, 3, out);
    expect(r).toBe(out);
    expect(r.halfWidth).toBeCloseTo(50 + 3, 5);
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
