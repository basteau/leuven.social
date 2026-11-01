import { describe, expect, test } from 'bun:test';

import { KEYCAPS, layoutKeycaps, movesMap, SETTLE_MS, strayPress } from './input.ts';
import type { KeyboardLayout } from './input.ts';

const layout = (keys: Record<string, string>): KeyboardLayout => ({
  getLayoutMap: async () => new Map(Object.entries(keys)),
});

describe('layoutKeycaps', () => {
  test('shows QWERTY letters without the Keyboard API', async () => {
    expect(await layoutKeycaps()).toEqual(KEYCAPS);
  });

  test('shows what the keys type on AZERTY', async () => {
    const azerty = layout({ KeyW: 'z', KeyA: 'q', KeyS: 's', KeyD: 'd', KeyQ: 'a', KeyE: 'e' });
    expect(await layoutKeycaps(azerty)).toEqual({
      KeyW: 'Z',
      KeyA: 'Q',
      KeyS: 'S',
      KeyD: 'D',
      KeyQ: 'A',
      KeyE: 'E',
    });
  });

  test('keeps the QWERTY letter for a key the layout leaves out or leaves blank', async () => {
    const caps = await layoutKeycaps(layout({ KeyW: 'z', KeyQ: ' ' }));
    expect(caps.KeyW).toBe('Z');
    expect(caps.KeyQ).toBe('Q');
    expect(caps.KeyE).toBe('E');
  });

  test('falls back to QWERTY letters when the layout is refused', async () => {
    const refused: KeyboardLayout = { getLayoutMap: () => Promise.reject(new Error('iframe')) };
    expect(await layoutKeycaps(refused)).toEqual(KEYCAPS);
  });

  test('never changes the defaults', async () => {
    await layoutKeycaps(layout({ KeyW: 'z' }));
    expect(KEYCAPS.KeyW).toBe('W');
  });
});

describe('movesMap', () => {
  test('arrows, zoom, turn and reset move the map', () => {
    for (const [code, key] of [
      ['ArrowLeft', 'ArrowLeft'],
      ['ArrowUp', 'ArrowUp'],
      ['Equal', '+'],
      ['Equal', '='],
      ['Minus', '-'],
      ['Digit6', '-'], // AZERTY's minus
      ['KeyQ', 'a'], // AZERTY's A turns left, by position
      ['KeyE', 'e'],
      ['KeyR', 'r'],
    ] as const) {
      expect(movesMap({ code, key })).toBe(true);
    }
  });

  test('Tab, Enter, Shift and Mute leave it be', () => {
    for (const [code, key] of [
      ['Tab', 'Tab'],
      ['Enter', 'Enter'],
      ['ShiftLeft', 'Shift'],
      ['KeyM', 'm'],
      ['KeyA', 'q'], // AZERTY's Q is QWERTY's A: no map key
    ] as const) {
      expect(movesMap({ code, key })).toBe(false);
    }
  });
});

describe('strayPress', () => {
  test('ignores the rest of a double-click', () => {
    expect(strayPress(2, 5_000)).toBe(true);
    expect(strayPress(3, 5_000)).toBe(true);
  });

  test('ignores a pointer press while the button is settling', () => {
    expect(strayPress(1, 0)).toBe(true);
    expect(strayPress(1, SETTLE_MS - 1)).toBe(true);
    expect(strayPress(1, SETTLE_MS)).toBe(false);
  });

  test('always lets the keyboard press', () => {
    expect(strayPress(0, 0)).toBe(false);
    expect(strayPress(0, 5_000)).toBe(false);
  });
});
