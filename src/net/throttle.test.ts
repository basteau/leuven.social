import { describe, expect, test } from 'bun:test';

import type { PlayerState } from './protocol.ts';
import { HEARTBEAT, SEND_INTERVAL, bigChange, sameState, sendDelay } from './throttle.ts';

const base: PlayerState = {
  x: 10,
  z: 20,
  heading: 1,
  speed: 1.4,
  mode: 'foot',
  place: '',
  floor: 0,
};
const sent = { state: base, at: 1000 };

describe('bigChange', () => {
  test('a mode, room, floor or jump of a few metres', () => {
    expect(bigChange(base, { ...base, mode: 'bike' })).toBe(true);
    expect(bigChange(base, { ...base, place: 'stadhuis' })).toBe(true);
    expect(bigChange(base, { ...base, floor: 1 })).toBe(true);
    expect(bigChange(base, { ...base, x: 15 })).toBe(true);
    expect(bigChange(base, { ...base, x: 12, z: 22 })).toBe(false);
    expect(bigChange(base, { ...base, heading: 3, speed: 9 })).toBe(false);
  });
});

describe('sameState', () => {
  test('ignores rounding, notices a step, a turn or a change of pace', () => {
    expect(sameState(base, { ...base, x: 10.001 })).toBe(true);
    expect(sameState(base, { ...base, x: 10.1 })).toBe(false);
    expect(sameState(base, { ...base, z: 20.1 })).toBe(false);
    expect(sameState(base, { ...base, heading: 1.1 })).toBe(false);
    expect(sameState(base, { ...base, speed: 0 })).toBe(false);
    expect(sameState(base, { ...base, floor: 1 })).toBe(false);
  });
});

describe('sendDelay', () => {
  test('the first state goes at once', () => {
    expect(sendDelay(null, base, 0)).toBe(0);
  });

  test('movement waits for the next tenth of a second', () => {
    const moved = { ...base, x: 10.5 };
    expect(sendDelay(sent, moved, 1000)).toBe(SEND_INTERVAL);
    expect(sendDelay(sent, moved, 1040)).toBe(SEND_INTERVAL - 40);
    expect(sendDelay(sent, moved, 1100)).toBe(0);
    expect(sendDelay(sent, moved, 5000)).toBe(0);
  });

  test('a big change goes at once', () => {
    expect(sendDelay(sent, { ...base, place: 'stadhuis' }, 1001)).toBe(0);
    expect(sendDelay(sent, { ...base, x: 30 }, 1001)).toBe(0);
  });

  test('standing still is repeated as a heartbeat', () => {
    expect(sendDelay(sent, base, 1100)).toBe(HEARTBEAT - 100);
    expect(sendDelay(sent, base, 1000 + HEARTBEAT)).toBe(0);
  });
});
