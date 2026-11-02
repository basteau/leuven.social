import { describe, expect, test } from 'bun:test';

import { loadStep, stallWatch, unlessAborted } from './loading.ts';

const start = { received: 0, total: 0, engine: false, built: false };

describe('loadStep', () => {
  test('counts the city file’s kilobytes as they arrive', () => {
    expect(loadStep({ ...start, received: 312 * 1024, total: 1200 * 1024 })).toEqual({
      step: 'Fetching the map',
      detail: '312 of 1,200 KB',
      fraction: 0.7 * (312 / 1200),
    });
  });

  test('without a size from the server, the count alone and an empty bar', () => {
    expect(loadStep({ ...start, received: 2048 })).toEqual({
      step: 'Fetching the map',
      detail: '2 KB',
      fraction: 0,
    });
  });

  test('then unpacking, the engine if it’s still on its way, building and ready', () => {
    const downloaded = { ...start, received: 10, total: 10 };
    expect(loadStep(downloaded).step).toBe('Unpacking the city');
    const unpacked = { ...downloaded, buildings: 24_310 };
    expect(loadStep(unpacked)).toMatchObject({
      step: 'Starting the 3D engine',
      detail: '24,310 buildings',
    });
    const building = loadStep({ ...unpacked, engine: true });
    expect(building).toMatchObject({ step: 'Building the streets', detail: '24,310 buildings' });
    expect(loadStep({ ...unpacked, engine: true, built: true })).toEqual({
      step: 'Ready',
      detail: '',
      fraction: 1,
    });
  });

  test('the bar only ever moves forward', () => {
    const steps = [
      { ...start, received: 1, total: 10 },
      { ...start, received: 10, total: 10 },
      { ...start, received: 10, total: 10, buildings: 1 },
      { ...start, received: 10, total: 10, buildings: 1, engine: true },
      { ...start, received: 10, total: 10, buildings: 1, engine: true, built: true },
    ].map((s) => loadStep(s).fraction);
    expect(steps).toEqual(steps.toSorted((a, b) => a - b));
    expect(new Set(steps).size).toBe(steps.length);
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('stallWatch', () => {
  test('a slow load that keeps moving never trips it, however long it takes', async () => {
    // Bytes every 15 ms for 90 ms, more than twice the 40 ms it would take a stall to trip.
    const watch = stallWatch(40);
    const arriving = setInterval(() => watch.alive(), 15);
    await sleep(90);
    clearInterval(arriving);
    expect(watch.signal.aborted).toBe(false);
    watch.stop();
  });

  test('nothing for the whole wait is a stall, and life after it changes nothing', async () => {
    const watch = stallWatch(10);
    await sleep(30);
    expect(watch.signal.aborted).toBe(true);
    watch.alive();
    expect(watch.signal.aborted).toBe(true);
  });

  test('stopped, it never trips', async () => {
    const watch = stallWatch(10);
    watch.stop();
    await sleep(30);
    expect(watch.signal.aborted).toBe(false);
  });
});

describe('unlessAborted', () => {
  test('the promise’s own result while the signal holds', async () => {
    const signal = new AbortController().signal;
    expect(await unlessAborted(Promise.resolve(7), signal)).toBe(7);
    await expect(unlessAborted(Promise.reject(new Error('no')), signal)).rejects.toThrow('no');
  });

  test('the signal’s reason once it aborts, even if the promise never settles', async () => {
    const controller = new AbortController();
    const waiting = unlessAborted(new Promise(() => {}), controller.signal);
    controller.abort(new Error('stalled'));
    await expect(waiting).rejects.toThrow('stalled');
    await expect(unlessAborted(Promise.resolve(1), controller.signal)).rejects.toThrow('stalled');
  });
});
