import { describe, expect, test } from 'bun:test';

import {
  HOVER,
  PLUMBOB,
  createPlumbob,
  plumbobFloat,
  plumbobGeometry,
  plumbobScale,
} from './plumbob.ts';

describe('plumbob', () => {
  test('is eight triangles with a colour at every corner', () => {
    const g = plumbobGeometry();
    expect(g.getAttribute('position').count).toBe(24);
    expect(g.getAttribute('color').count).toBe(24);
    expect(PLUMBOB.accent).toBe(0x1d5c9b);
  });
  test('bobs and spins, or holds still for reduced motion', () => {
    expect(plumbobFloat(0, false).lift).toBeCloseTo(0);
    expect(Math.abs(plumbobFloat(1, false).lift)).toBeGreaterThan(0.05);
    expect(plumbobFloat(1, false).spin).not.toBe(plumbobFloat(2, false).spin);
    expect(plumbobFloat(1, true)).toEqual(plumbobFloat(9, true));
    expect(plumbobFloat(1, true).lift).toBe(0);
  });
  test('grows with the view but is never under life size', () => {
    expect(plumbobScale(10)).toBe(1);
    expect(plumbobScale(560)).toBeCloseTo(22.4);
  });
  test('is placed over a spot, hidden until then', () => {
    const p = createPlumbob(true);
    expect(p.mesh.visible).toBe(false);
    p.place(1, 2, 3, 2, 0);
    expect(p.mesh.position.toArray()).toEqual([1, 2 + HOVER * 2, 3]);
    expect(p.mesh.scale.x).toBe(2);
    p.dispose();
  });
});
