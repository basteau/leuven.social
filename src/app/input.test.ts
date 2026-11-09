import { describe, expect, test } from 'bun:test';

import {
  createTurnHold,
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

/** A turn hold and what it told the map to do, in order. */
function held() {
  const calls: number[] = [];
  const turner: Turner = { spin: (direction) => calls.push(direction) };
  return { hold: createTurnHold(), calls, turner };
}

describe('createTurnHold', () => {
  test('turns from the press until it is let go, in one motion', () => {
    const { hold, calls, turner } = held();
    hold.press('KeyE', 1, turner);
    expect(calls).toEqual([1]);
    hold.release('KeyE');
    expect(calls).toEqual([1, 0]);
  });

  test('a new press takes over from the one before', () => {
    const { hold, calls, turner } = held();
    hold.press('KeyE', 1, turner);
    hold.press('KeyQ', -1, turner);
    expect(calls).toEqual([1, 0, -1]);
  });

  test('only what started a hold ends it', () => {
    const { hold, calls, turner } = held();
    hold.press('rail-left', -1, turner);
    hold.release('KeyQ');
    expect(calls).toEqual([-1]);
    hold.release();
    expect(calls).toEqual([-1, 0]);
    hold.release();
    expect(calls).toEqual([-1, 0]);
  });

  test('with no map yet a press does nothing and nothing breaks', () => {
    const hold = createTurnHold();
    hold.press('KeyQ', -1, null);
    hold.release('KeyQ');
  });
});
