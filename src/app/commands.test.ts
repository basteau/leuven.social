import { describe, expect, test } from 'bun:test';

import { commandsFor, GROUPS, keyCommands, keySheet } from './commands.ts';
import type { CommandState } from './commands.ts';
import { KEYCAPS } from './input.ts';

const state = (over: Partial<CommandState> = {}): CommandState => ({
  mode: 'map',
  ride: '',
  running: false,
  soundOn: true,
  time: 'golden',
  passing: false,
  keys: KEYCAPS,
  mod: '⌘',
  ...over,
});
const ids = (s: CommandState) => commandsFor(s).map((c) => c.id);
const byId = (s: CommandState, id: string) => commandsFor(s).find((c) => c.id === id);

describe('commandsFor', () => {
  test('the map offers walking, the view and the general commands, in that order', () => {
    expect(ids(state())).toEqual([
      'walk',
      'zoom-in',
      'zoom-out',
      'turn-left',
      'turn-right',
      'reset',
      'time',
      'pass-time',
      'sound',
      'help',
      'about',
    ]);
  });

  test('Walk here starts in the middle of the view, as W and Enter do', () => {
    expect(byId(state(), 'walk')).toMatchObject({ action: 'centre', keys: [['W'], ['↵']] });
  });

  test('on foot: back to the map, run, closer and further, and no reset', () => {
    const walk = state({ mode: 'walk' });
    expect(ids(walk)).toEqual([
      'map',
      'run',
      'zoom-in',
      'zoom-out',
      'turn-left',
      'turn-right',
      'time',
      'pass-time',
      'sound',
      'help',
      'about',
    ]);
    expect(byId(walk, 'zoom-in')?.label).toBe('Closer');
    expect(byId(walk, 'zoom-out')?.label).toBe('Further');
    expect(byId(walk, 'turn-left')?.detail).toContain('eighth');
  });

  test('a bike nearby offers a ride; riding offers getting off, sprint and the bell', () => {
    const near = state({ mode: 'walk', ride: 'near' });
    expect(byId(near, 'ride')?.label).toBe('Ride the bike');
    expect(byId(near, 'bell')).toBeUndefined();
    const riding = state({ mode: 'walk', ride: 'riding', running: true });
    expect(byId(riding, 'ride')?.label).toBe('Get off the bike');
    expect(byId(riding, 'run')).toMatchObject({ label: 'Sprint', on: true });
    expect(byId(riding, 'bell')?.keys).toEqual([['B']]);
  });

  test('the time of day says where the day is and where T takes it; passing is a toggle', () => {
    expect(byId(state(), 'time')).toMatchObject({
      detail: 'Golden hour now; next, dusk',
      icon: 'sun',
      keys: [['T']],
    });
    expect(byId(state({ time: 'night' }), 'time')).toMatchObject({
      detail: 'Night now; next, morning',
      icon: 'moon',
    });
    expect(byId(state(), 'pass-time')).toMatchObject({ on: false, keys: [['P']] });
    expect(byId(state({ passing: true }), 'pass-time')?.on).toBe(true);
  });

  test('sound says what pressing it will do', () => {
    expect(byId(state(), 'sound')).toMatchObject({ label: 'Mute', icon: 'sound-on' });
    expect(byId(state({ soundOn: false }), 'sound')).toMatchObject({
      label: 'Unmute',
      icon: 'sound-off',
    });
  });

  test('positional keys show what they type on this keyboard', () => {
    const azerty = { ...KEYCAPS, KeyW: 'Z', KeyQ: 'A' };
    expect(byId(state({ keys: azerty }), 'walk')?.keys).toEqual([['Z'], ['↵']]);
    expect(byId(state({ keys: azerty }), 'turn-left')?.keys).toEqual([['A']]);
  });

  test('every command has a group the menu can name, and a unique id', () => {
    for (const s of [state(), state({ mode: 'walk', ride: 'riding' })]) {
      const list = commandsFor(s);
      expect(new Set(list.map((c) => c.id)).size).toBe(list.length);
      for (const c of list) expect(GROUPS[c.group]).toBeTruthy();
    }
  });
});

describe('keySheet', () => {
  test('covers the map, walking, riding and anywhere, with the menu chord', () => {
    const sheet = keySheet(KEYCAPS, 'Ctrl');
    expect(sheet.map((s) => s.id)).toEqual(['map', 'walk', 'ride', 'any']);
    const any = sheet.find((s) => s.id === 'any')!;
    expect(any.rows[0]?.keys).toEqual([['Ctrl', 'K'], ['/']]);
  });

  test('becomes searchable rows of the Keys group that open the controls page', () => {
    const rows = keyCommands(keySheet(KEYCAPS, '⌘'));
    expect(rows.every((r) => r.group === 'keys' && r.action === 'help')).toBe(true);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    const run = rows.find((r) => r.id === 'key-walk-Run')!;
    expect(run.detail).toBe('On foot · touch: Push the stick to its rim');
    expect(rows.find((r) => r.id === 'key-ride-Ring the bell')?.detail).toBe('On a bike');
  });
});
