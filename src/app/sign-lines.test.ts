import { expect, test } from 'bun:test';

import { signLines } from './sign-lines.ts';

test('a short name stays on one line', () => {
  expect(signLines('Grote Markt')).toEqual({ first: 'Grote Markt' });
  expect(signLines('Sint-Pieterskerk · Nave').second).toBe('Nave');
  expect(signLines('Minderbroedersstraat')).toEqual({ first: 'Minderbroedersstraat' });
});

test('a long name breaks where its two lines come out most even', () => {
  expect(signLines('Monseigneur Van Waeyenberghlaan')).toEqual({
    first: 'Monseigneur Van',
    second: 'Waeyenberghlaan',
    between: ' ',
  });
  expect(signLines('Lodewijk Engelbertus Van Arenbergplein')).toEqual({
    first: 'Lodewijk Engelbertus',
    second: 'Van Arenbergplein',
    between: ' ',
  });
});

test('a room and its floor part where they meet, whatever would be even', () => {
  expect(signLines('Sint-Pieterskerk · Organ gallery')).toEqual({
    first: 'Sint-Pieterskerk',
    second: 'Organ gallery',
    between: ' · ',
  });
});

test('one very long word has nowhere to break', () => {
  const word = 'Donaudampfschifffahrtsgesellschaft';
  expect(signLines(word)).toEqual({ first: word });
});
