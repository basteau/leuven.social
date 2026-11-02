import { describe, expect, test } from 'bun:test';

import {
  createTurnHold,
  HOLD_MS,
  KEYCAPS,
  layoutKeycaps,
  movesMap,
  SETTLE_MS,
  strayPress,
} from './input.ts';
import type { KeyboardLayout, Turner } from './input.ts';

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

/** A turn hold with its timer in hand: `later()` runs what waits, as if HOLD_MS went by. */
function setup() {
  const calls: string[] = [];
  const turner: Turner = {
    rotate: (direction) => calls.push(`rotate ${direction}`),
    spin: (direction) => calls.push(`spin ${direction}`),
  };
  let waiting: (() => void) | undefined;
  const waits: number[] = [];
  const hold = createTurnHold((then, ms) => {
    waiting = then;
    waits.push(ms);
    return () => {
      waiting = undefined;
    };
  });
  const later = () => waiting?.();
  const press = (source: string, direction: 1 | -1) => hold.press(source, direction, turner);
  return { hold, press, calls, waits, later };
}

describe('createTurnHold', () => {
  test('a tap is one step', () => {
    const { hold, press, calls, later } = setup();
    press('KeyQ', -1);
    hold.release('KeyQ');
    later();
    expect(calls).toEqual(['rotate -1']);
  });

  test('held, it steps at once, keeps turning after HOLD_MS and stops when let go', () => {
    const { hold, press, calls, waits, later } = setup();
    press('right', 1);
    expect(waits).toEqual([HOLD_MS]);
    later();
    expect(calls).toEqual(['rotate 1', 'spin 1']);
    hold.release('right');
    hold.release('right');
    expect(calls).toEqual(['rotate 1', 'spin 1', 'spin 0']);
  });

  test('only what started the hold ends it', () => {
    const { hold, press, calls, later } = setup();
    press('left', -1);
    later();
    hold.release('KeyE');
    expect(calls).toEqual(['rotate -1', 'spin -1']);
    hold.release();
    expect(calls).toEqual(['rotate -1', 'spin -1', 'spin 0']);
  });

  test('a new press takes over from the one held', () => {
    const { hold, press, calls, later } = setup();
    press('left', -1);
    later();
    press('KeyE', 1);
    hold.release('left');
    later();
    expect(calls).toEqual(['rotate -1', 'spin -1', 'spin 0', 'rotate 1', 'spin 1']);
  });

  test('waits for the viewer without failing', () => {
    let waiting: (() => void) | undefined;
    const hold = createTurnHold((then) => {
      waiting = then;
      return () => {};
    });
    hold.press('KeyQ', -1, null);
    waiting?.();
    hold.release();
    expect(waiting).toBeDefined();
  });

  test('times the hold with a real timer by default', async () => {
    const calls: number[] = [];
    const turner: Turner = { rotate: () => {}, spin: (d) => calls.push(d) };
    const hold = createTurnHold();
    hold.press('KeyE', 1, turner);
    hold.release('KeyE');
    hold.press('KeyE', 1, turner);
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS + 20));
    hold.release('KeyE');
    expect(calls).toEqual([1, 0]);
  });
});
