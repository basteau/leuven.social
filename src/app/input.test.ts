import { describe, expect, test } from 'bun:test';

import {
  createTurnHold,
  HOLD_MS,
  idleRepeat,
  KEYCAPS,
  layoutKeycaps,
  menuKey,
  modKey,
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

describe('menuKey', () => {
  type Mods = Partial<Record<'metaKey' | 'ctrlKey' | 'altKey', boolean>>;
  const press = (key: string, mods: Mods = {}) =>
    menuKey({ key, metaKey: false, ctrlKey: false, altKey: false, ...mods });

  test('⌘K, Ctrl+K, ⌘P and Ctrl+P are chords that open and close it', () => {
    expect(press('k', { metaKey: true })).toBe('chord');
    expect(press('K', { ctrlKey: true })).toBe('chord');
    expect(press('p', { metaKey: true })).toBe('chord');
    expect(press('p', { ctrlKey: true })).toBe('chord');
  });

  test('/ and ? open it on their own', () => {
    expect(press('/')).toBe('key');
    expect(press('?')).toBe('key');
  });

  test('other keys and chords leave it be', () => {
    expect(press('k')).toBeNull();
    expect(press('p')).toBeNull();
    expect(press('c', { metaKey: true })).toBeNull();
    expect(press('/', { ctrlKey: true })).toBeNull();
    expect(press('k', { metaKey: true, altKey: true })).toBeNull();
    expect(press('?', { altKey: true })).toBeNull();
  });
});

describe('idleRepeat', () => {
  test('a first press always counts', () => {
    for (const key of ['w', 'f', 'm', 'Escape', 'Enter', 'k', '+']) {
      expect(idleRepeat({ key, repeat: false })).toBe(false);
    }
  });

  test('a held toggle’s repeats do nothing', () => {
    for (const key of ['w', 'f', 'm', 'r', 'Escape', 'Enter', 'k', '/']) {
      expect(idleRepeat({ key, repeat: true })).toBe(true);
    }
  });

  test('held, zoom goes on', () => {
    for (const key of ['+', '=', '-']) expect(idleRepeat({ key, repeat: true })).toBe(false);
  });
});

describe('modKey', () => {
  test('⌘ on Apple’s platforms, Ctrl elsewhere', () => {
    expect(modKey('MacIntel')).toBe('⌘');
    expect(modKey('macOS')).toBe('⌘');
    expect(modKey('iPhone')).toBe('⌘');
    expect(modKey('Win32')).toBe('Ctrl');
    expect(modKey('Linux x86_64')).toBe('Ctrl');
    expect(modKey('')).toBe('Ctrl');
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
