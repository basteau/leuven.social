import { describe, expect, test } from 'bun:test';

import { fakeContext } from './context.fixture.ts';
import type { FakeContext, FakeNode } from './context.fixture.ts';
import { MASTER, createSound, vary } from './sound.ts';
import type { SoundEnv, Voice } from './sound.ts';

function memory(initial?: string) {
  const items = new Map<string, string>(initial ? [['leuven.sound', initial]] : []);
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    items,
  };
}

/** A sound engine with a fake context, storage and page, and what it made. */
function setup(stored?: string, state?: AudioContextState, broken = false) {
  const storage = memory(stored);
  const made: FakeContext[] = [];
  const env: SoundEnv = {
    context: () => {
      const ctx = fakeContext(state, broken);
      made.push(ctx);
      return ctx as unknown as AudioContext;
    },
    storage: () => storage,
  };
  const sound = createSound(env);
  const target = new EventTarget();
  const page = Object.assign(new EventTarget(), { hidden: false });
  const detach = sound.attach(target, page);
  const gesture = () => target.dispatchEvent(new Event('pointerdown'));
  const hide = (hidden: boolean) => {
    page.hidden = hidden;
    page.dispatchEvent(new Event('visibilitychange'));
  };
  return { sound, storage, made, target, page, detach, gesture, hide };
}

const sources = (ctx: FakeContext) =>
  ctx.nodes.filter((n) => n.kind === 'osc' || n.kind === 'buffer');

describe('sound', () => {
  test('is on by default and makes no context before a gesture', () => {
    const { sound, made } = setup();
    expect(sound.on).toBe(true);
    sound.tap();
    expect(made).toHaveLength(0);
  });

  test('the first gesture makes one context with a quiet master', () => {
    const { sound, made, gesture } = setup();
    gesture();
    gesture();
    expect(made).toHaveLength(1);
    const ctx = made[0]!;
    const master = ctx.nodes[0]!;
    expect(master.gain!.value).toBe(MASTER);
    expect(master.connected).toEqual([ctx.destination]);
    sound.tap();
    expect(sources(ctx)).toHaveLength(2);
  });

  test('a context the browser made suspended is resumed by the gesture', () => {
    const { made, gesture } = setup(undefined, 'suspended');
    gesture();
    expect(made[0]!.calls).toEqual(['resume']);
  });

  test('a context that will not wake stays silent without an error', async () => {
    const { made, gesture } = setup(undefined, 'suspended', true);
    gesture();
    await Promise.resolve();
    expect(made[0]!.calls).toEqual(['resume']);
  });

  test('remembers being turned off, and stays silent', () => {
    const first = setup();
    first.gesture();
    first.sound.setOn(false);
    expect(first.storage.items.get('leuven.sound')).toBe('off');
    expect(first.made[0]!.calls).toEqual(['suspend']);

    const next = setup('off');
    expect(next.sound.on).toBe(false);
    next.gesture();
    next.sound.tap();
    expect(next.made).toHaveLength(0);
    next.sound.setOn(true); // the click on the toggle is the gesture
    expect(next.made).toHaveLength(1);
    expect(next.storage.items.get('leuven.sound')).toBe('on');
  });

  test('a hidden tab suspends and plays nothing, and wakes when shown', () => {
    const { sound, made, gesture, hide } = setup();
    hide(true);
    gesture();
    expect(made).toHaveLength(0); // nothing to make while hidden
    hide(false);
    expect(made).toHaveLength(0); // no gesture yet: still nothing
    gesture();
    const ctx = made[0]!;
    hide(true);
    expect(ctx.calls).toEqual(['suspend']);
    const before = ctx.nodes.length;
    sound.tap();
    expect(ctx.nodes).toHaveLength(before);
    hide(false);
    expect(ctx.calls).toEqual(['suspend', 'resume']);
  });

  test('stops listening once detached', () => {
    const { made, detach, gesture } = setup();
    detach();
    gesture();
    expect(made).toHaveLength(0);
  });

  test('in the browser, makes a real AudioContext and reads localStorage', () => {
    const made: unknown[] = [];
    Object.assign(globalThis, {
      AudioContext: function AudioContext() {
        const ctx = fakeContext();
        made.push(ctx);
        return ctx;
      },
    });
    try {
      const sound = createSound();
      const target = new EventTarget();
      sound.attach(target, Object.assign(new EventTarget(), { hidden: false }));
      target.dispatchEvent(new Event('keydown'));
      expect(made).toHaveLength(1);
    } finally {
      Reflect.deleteProperty(globalThis, 'AudioContext');
    }
  });

  test('storage that throws only means the choice is not remembered', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const sound = createSound({
      context: () => fakeContext() as unknown as AudioContext,
      storage: () => throwing,
    });
    expect(sound.on).toBe(true);
    sound.setOn(false);
    expect(sound.on).toBe(false);
  });
});

/** What playing `voices` adds to a fresh, unlocked context. */
function played(voices: Voice[]) {
  const { sound, made, gesture } = setup();
  gesture();
  const ctx = made[0]!;
  const from = ctx.nodes.length;
  sound.play(voices);
  return { ctx, nodes: ctx.nodes.slice(from) };
}
const of = (nodes: FakeNode[], kind: string) => nodes.filter((n) => n.kind === kind);

/** The starting pitch of each note a toggle plays. */
function togglePitches(on: boolean) {
  const { sound, made, gesture } = setup();
  gesture();
  sound.toggle(on);
  return of(made[0]!.nodes, 'osc').map((n) => n.frequency!.events[0]![1]);
}

describe('voices', () => {
  test('a tone rises without a click, falls exponentially and is cleaned up after', () => {
    const { ctx, nodes } = played([
      { wave: 'triangle', pitch: [800, 400], gain: 0.1, decay: 0.05, delay: 0.01 },
    ]);
    const [osc] = of(nodes, 'osc');
    const [filter] = of(nodes, 'filter');
    const [level] = of(nodes, 'gain');
    expect(osc!.type).toBe('triangle');
    expect(filter!.type).toBe('lowpass');
    expect(osc!.connected).toEqual([filter]);
    expect(filter!.connected).toEqual([level]);
    expect(level!.connected).toEqual([ctx.nodes[0]]); // the master
    const t = ctx.currentTime + 0.01;
    expect(osc!.started).toEqual([t]);
    expect(level!.gain!.events).toEqual([
      ['setValueAtTime', 1e-4, t],
      ['linearRampToValueAtTime', 0.1, t + 0.003],
      ['exponentialRampToValueAtTime', 1e-4, t + 0.003 + 0.05],
    ]);
    expect(osc!.frequency!.events).toEqual([
      ['setValueAtTime', 800, t],
      ['exponentialRampToValueAtTime', 400, t + 0.003 + 0.05],
    ]);
    expect(osc!.stopped).toBeCloseTo(t + 0.073, 6);
    osc!.ended!();
    expect(nodes.every((n) => n.disconnected)).toBe(true);
  });

  test('noise is band-passed around its pitch and starts somewhere in the buffer', () => {
    const { nodes } = played([{ wave: 'noise', pitch: 2000, gain: 0.05, decay: 0.02, q: 2 }]);
    const [buffer] = of(nodes, 'buffer');
    const [filter] = of(nodes, 'filter');
    expect(filter!.type).toBe('bandpass');
    expect(filter!.Q!.value).toBe(2);
    expect(filter!.frequency!.events).toEqual([['setValueAtTime', 2000, 10]]);
    expect(buffer!.started![1]).toBeGreaterThanOrEqual(0);
    expect(buffer!.started![1]).toBeLessThan(0.5);
  });

  test('a toggle rises turning on and falls turning off', () => {
    const on = togglePitches(true);
    const off = togglePitches(false);
    expect(on[1]).toBeGreaterThan(on[0]!);
    expect(off).toEqual(on.toReversed());
  });
});

test('vary stays within its spread', () => {
  expect(vary(100, 0.1, () => 0)).toBeCloseTo(90);
  expect(vary(100, 0.1, () => 1)).toBeCloseTo(110);
  expect(vary(100, 0.1, () => 0.5)).toBe(100);
});
