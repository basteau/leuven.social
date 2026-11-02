import { describe, expect, test } from 'bun:test';

import { fold, score, search } from './search.ts';

const item = (label: string, more: Partial<Parameters<typeof score>[1]> = {}) => ({
  label,
  group: 'g',
  ...more,
});

describe('fold', () => {
  test('drops case and accents', () => {
    expect(fold('Café Élysée')).toBe('cafe elysee');
  });

  test('reads the minus sign as the hyphen a keyboard types', () => {
    expect(fold('\u2212')).toBe('-');
    expect(score('-', item('Zoom out', { keys: [['\u2212']] }))).toBe(50);
  });
});

describe('score', () => {
  test('an empty query matches everything a little', () => {
    expect(score('', item('Zoom in'))).toBe(1);
    expect(score('   ', item('Zoom in'))).toBe(1);
  });

  test('ranks the label’s start over a word in it over anywhere in it', () => {
    const zoom = item('Zoom in');
    expect(score('zo', zoom)).toBe(100);
    expect(score('in', zoom)).toBe(80);
    expect(score('om', zoom)).toBe(60);
  });

  test('finds words after hyphens and brackets', () => {
    expect(score('pieters', item('Sint-Pieterskerk'))).toBe(80);
  });

  test('then the keys, the keywords and the detail', () => {
    const ride = item('Ride the bike', { keys: [['F']], keywords: 'fiets', detail: 'nearest' });
    expect(score('f', ride)).toBe(50);
    expect(score('fiets', ride)).toBe(40);
    expect(score('earest', ride)).toBe(20);
  });

  test('last, the label’s letters in order', () => {
    expect(score('rst', item('Reset view'))).toBe(10);
    // Too short to guess from: one letter must be a real match.
    expect(score('x', item('Reset view'))).toBe(0);
  });

  test('ignores case and accents in both', () => {
    expect(score('GROTE', item('Grote Markt'))).toBe(100);
    expect(score('cafe', item('Café Belge'))).toBe(100);
  });

  test('every word must match somewhere, in any order', () => {
    const turn = item('Turn left', { keywords: 'rotate anticlockwise' });
    expect(score('left turn', turn)).toBe(180);
    expect(score('rotate left', turn)).toBe(120);
    expect(score('turn right', turn)).toBe(0);
  });
});

describe('search', () => {
  const items = [
    { label: 'Walk here', group: 'map' },
    { label: 'Zoom in', group: 'view' },
    { label: 'Zoom out', group: 'view' },
    { label: 'Mute', group: 'general', keywords: 'sound' },
  ];

  test('without a query, everything in its groups in the order given', () => {
    expect(search(items, '')).toEqual([
      { id: 'map', items: [items[0]!] },
      { id: 'view', items: [items[1]!, items[2]!] },
      { id: 'general', items: [items[3]!] },
    ]);
  });

  test('with one, only matches, the best group and the best match first', () => {
    expect(search(items, 'out')).toEqual([{ id: 'view', items: [items[2]!] }]);
    const sound = [{ label: 'Sound check', group: 'view' }, ...items];
    expect(search(sound, 'sound').map((g) => g.id)).toEqual(['view', 'general']);
    expect(search(items, 'o').map((g) => g.items.map((i) => i.label))).toEqual([
      ['Zoom out', 'Zoom in'],
    ]);
  });

  test('nothing matches: no groups', () => {
    expect(search(items, 'xyzzy')).toEqual([]);
  });
});
