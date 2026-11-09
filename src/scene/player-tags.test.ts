import { describe, expect, test } from 'bun:test';

import { declutter } from './player-tags.ts';

const flat = (...boxes: number[][]) => new Float32Array(boxes.flat());

describe('declutter', () => {
  test('keeps tags clear of each other, the nearer one first', () => {
    const boxes = flat([100, 100, 60, 18], [120, 100, 60, 18], [300, 100, 60, 18]);
    const keep = new Uint8Array(3);
    declutter(boxes, 3, keep);
    // The second overlaps the first and loses; the third is clear of both.
    expect([...keep]).toEqual([1, 0, 1]);
  });

  test('stacked above each other, they keep', () => {
    const boxes = flat([100, 100, 60, 18], [100, 60, 60, 18]);
    const keep = new Uint8Array(2);
    declutter(boxes, 2, keep);
    expect([...keep]).toEqual([1, 1]);
  });

  test('a tag that lost its place makes no room: only those shown count', () => {
    // 2 overlaps 1, 3 overlaps 2 but not 1: 3 is fine, since 2 isn't shown.
    const boxes = flat([0, 100, 60, 18], [50, 100, 60, 18], [100, 100, 60, 18]);
    const keep = new Uint8Array(3);
    declutter(boxes, 3, keep);
    expect([...keep]).toEqual([1, 0, 1]);
  });

  test('a tag with no size is not there, and takes no room', () => {
    const boxes = flat([100, 100, 0, 0], [100, 100, 60, 18]);
    const keep = new Uint8Array(2);
    declutter(boxes, 2, keep);
    expect([...keep]).toEqual([0, 1]);
  });
});
