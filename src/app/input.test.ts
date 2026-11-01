import { describe, expect, test } from 'bun:test';

import { KEYCAPS, layoutKeycaps, SETTLE_MS, strayPress } from './input.ts';
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
