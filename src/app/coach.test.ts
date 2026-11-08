import { describe, expect, test } from 'bun:test';

import { coachStep } from './coach.ts';

const state = { done: false, street: false, stepped: false, settled: false };

describe('the first minute', () => {
  test('far out, it asks you down to the street', () => {
    expect(coachStep(state)).toBe('zoom');
  });

  test('close in, it teaches the first step', () => {
    expect(coachStep({ ...state, street: true })).toBe('walk');
  });

  test('a step taken before coming close still counts, without asking for the zoom', () => {
    expect(coachStep({ ...state, stepped: true })).toBe('walk');
  });

  test('a few seconds after the first step, it shows looking around and the map', () => {
    expect(coachStep({ ...state, street: true, stepped: true, settled: true })).toBe('look');
  });

  test('once done, it says nothing, whatever else is true', () => {
    expect(coachStep({ done: true, street: false, stepped: false, settled: false })).toBeNull();
    expect(coachStep({ done: true, street: true, stepped: true, settled: true })).toBeNull();
  });
});
