import { describe, expect, test } from 'bun:test';

import { ELLIPSIS, MAX_NAME, boardName, cutName, latinOnly, placeBoards } from './boards.ts';
import type { ShopFront } from './city.ts';
import { AWNING_HALF, END_GAP } from './shops.ts';

describe('the name on a board', () => {
  test('is the brand first, then the name', () => {
    expect(boardName({ brand: 'Kruidvat', name: 'Kruidvat Leuven' })).toBe('Kruidvat');
    expect(boardName({ name: '  Café Belge ' })).toBe('Café Belge');
    expect(boardName({ brand: ' ', name: 'De Werf' })).toBe('De Werf');
    expect(boardName({ shop: 'bakery' })).toBeNull();
  });

  test('keeps Latin letters, accents and figures, and leaves other scripts out', () => {
    expect(latinOnly('老四川 - Lao Sichuan')).toBe('Lao Sichuan');
    expect(latinOnly('Œuf & Çà, 24/7!')).toBe('Œuf & Çà, 24/7!');
    expect(latinOnly('Pizza 🍕 Roma')).toBe('Pizza Roma');
    // Decomposed accents are composed first, so they stay.
    expect(latinOnly('Café')).toBe('Café');
    expect(latinOnly('寿司')).toBeNull();
    expect(latinOnly('Ελληνικά')).toBeNull();
    // A brand it can't show gives way to a name it can.
    expect(boardName({ brand: '星巴克', name: 'Starbucks' })).toBe('Starbucks');
    expect(boardName({ name: '寿司' })).toBeNull();
  });

  test('is cut at about 22 characters, at a word where it can, with an ellipsis', () => {
    expect(cutName('Brasserie De Vrijheid Leuven')).toBe(`Brasserie De Vrijheid${ELLIPSIS}`);
    expect(cutName('Supercalifragilisticexpialidocious')).toBe(
      `${'Supercalifragilisticexpialidocious'.slice(0, MAX_NAME - 1)}${ELLIPSIS}`,
    );
    expect([...cutName('Ab cdefghijklmnopqrstuvwxyz')].length).toBeLessThanOrEqual(MAX_NAME);
    expect(cutName('Exactly twenty-two ch.')).toBe('Exactly twenty-two ch.');
    // No dangling joiner before the ellipsis.
    expect(cutName('Frituur Tivoli - Oude Markt')).toBe(`Frituur Tivoli - Oude${ELLIPSIS}`);
    expect(cutName('Het Land van Belofte - Vin')).toBe(`Het Land van Belofte${ELLIPSIS}`);
  });
});

const front = (along: number, kind: ShopFront['kind'] = 'cafe'): ShopFront => ({
  building: 0,
  edge: 0,
  along,
  kind,
  terrace: false,
});

describe('placing boards', () => {
  // A 12 m wall along z = 0, the house to its south: it faces -z.
  const ring = new Float32Array([0, 0, 12, 0, 12, 10, 0, 10]);

  test('centres a board on its front, as wide as its awning, just off the wall', () => {
    const fronts = [front(6.04, 'bank'), front(10)];
    const tags = new Map([
      [fronts[0]!, { name: 'KBC' }],
      [fronts[1]!, { brand: 'Starbucks' }],
    ]);
    const { boards, skipped } = placeBoards(fronts, [ring], tags, 0.06);
    expect(skipped).toEqual({});
    expect(boards).toHaveLength(2);
    const [bank, cafe] = boards;
    // Rounded to a decimetre along, as city.bin keeps it.
    expect(bank).toMatchObject({ kind: 'bank', name: 'KBC', width: 4 });
    expect(bank!.x).toBeCloseTo(6, 9);
    expect(bank!.z).toBeCloseTo(-0.06, 9);
    expect(bank!.angle).toBeCloseTo(-Math.PI / 2, 9);
    expect(cafe!.width).toBeCloseTo(2 * (12 - END_GAP - 10), 9);
    // Inside its front: within the wall's ends and short of its neighbour's board.
    for (const b of boards) {
      expect(b.x - b.width / 2).toBeGreaterThanOrEqual(END_GAP - 1e-9);
      expect(b.x + b.width / 2).toBeLessThanOrEqual(12 - END_GAP + 1e-9);
      expect(b.width / 2).toBeLessThanOrEqual(AWNING_HALF);
    }
    expect(bank!.x + bank!.width / 2).toBeLessThanOrEqual(cafe!.x - cafe!.width / 2 + 1e-9);
  });

  test('skips a front with no name, one it cannot show and one too narrow for an awning', () => {
    const fronts = [front(2), front(5), front(8), front(11.8), front(11.9)];
    const tags = new Map([
      [fronts[1]!, { name: '寿司' }],
      [fronts[2]!, { name: '' }],
      [fronts[3]!, { name: 'Corner' }],
    ]);
    const { boards, skipped } = placeBoards(fronts, [ring], tags, 0.06);
    expect(boards).toEqual([]);
    expect(skipped).toEqual({ 'no name': 3, 'not in Latin letters': 1, 'too narrow': 1 });
  });
});
