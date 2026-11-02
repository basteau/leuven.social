import { expect, test } from 'bun:test';

import { AWNING_HALF, awningRoom } from './awnings.ts';

test('an awning reaches its most, short of the wall ends and halfway to the next front', () => {
  expect(awningRoom(6, 12, [])).toBe(AWNING_HALF);
  expect(awningRoom(1, 12, [])).toBeCloseTo(0.7, 9);
  expect(awningRoom(11, 12, [])).toBeCloseTo(0.7, 9);
  expect(awningRoom(6, 12, [8, 1])).toBe(1);
});
