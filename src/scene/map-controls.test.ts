import { describe, expect, test } from 'bun:test';
import { OrthographicCamera, Vector3 } from 'three';

import { MapControls } from './map-controls.ts';
import type { Surface } from './map-controls.ts';

const [W, H] = [800, 600];

/** The map's camera: isometric, looking at the origin from far off, 800 × 600 px. */
function setup() {
  const camera = new OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, 1, 4000);
  const pitch = Math.atan(1 / Math.SQRT2);
  camera.position.set(
    Math.sin(Math.PI / 4) * Math.cos(pitch) * 2000,
    Math.sin(pitch) * 2000,
    Math.cos(Math.PI / 4) * Math.cos(pitch) * 2000,
  );
  camera.lookAt(0, 0, 0);
  const surface = Object.assign(new EventTarget(), {
    clientWidth: W,
    clientHeight: H,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    style: { cursor: '', touchAction: '' },
    captured: [] as number[],
    setPointerCapture(id: number) {
      this.captured.push(id);
    },
  }) satisfies Surface;
  let [changes, pans] = [0, 0];
  const controls = new MapControls(
    camera,
    surface,
    () => changes++,
    () => pans++,
  );
  return { camera, surface, controls, changes: () => changes, pans: () => pans };
}

const pointer = (type: string, id: number, x: number, y: number, more: object = {}) =>
  Object.assign(new Event(type, { cancelable: true }), {
    pointerId: id,
    clientX: x,
    clientY: y,
    pointerType: 'touch',
    button: 0,
    ...more,
  });

const ground = (controls: MapControls, x: number, y: number) =>
  controls.groundAt(x, y, new Vector3());

describe('MapControls', () => {
  test('the middle of the screen is the target, on its ground', () => {
    const { controls } = setup();
    const at = ground(controls, W / 2, H / 2);
    expect(at.x).toBeCloseTo(0, 6);
    expect(at.y).toBeCloseTo(0, 6);
    expect(at.z).toBeCloseTo(0, 6);
  });

  test('a drag keeps the ground under the finger, and lets go of the avatar', () => {
    const { controls, surface, changes, pans } = setup();
    controls.pinned = true;
    const grabbed = ground(controls, 300, 200);
    surface.dispatchEvent(pointer('pointerdown', 1, 300, 200));
    expect(surface.style.cursor).toBe('grabbing');
    expect(surface.captured).toEqual([1]);
    // A tap's wobble moves nothing.
    surface.dispatchEvent(pointer('pointermove', 1, 303, 202));
    expect([changes(), pans()]).toEqual([0, 0]);
    expect(controls.pinned).toBe(true);
    surface.dispatchEvent(pointer('pointermove', 1, 420, 330));
    const under = ground(controls, 420, 330);
    expect(under.distanceTo(grabbed)).toBeLessThan(1e-6);
    expect([changes(), pans()]).toEqual([1, 1]);
    expect(controls.pinned).toBe(false);
    surface.dispatchEvent(pointer('pointerup', 1, 420, 330));
    expect(surface.style.cursor).toBe('grab');
    // Moves after the finger lifts do nothing.
    surface.dispatchEvent(pointer('pointermove', 1, 0, 0));
    expect(changes()).toBe(1);
  });

  test('a pinch zooms about its middle and drags with it', () => {
    const { camera, controls, surface } = setup();
    surface.dispatchEvent(pointer('pointerdown', 1, 300, 300));
    surface.dispatchEvent(pointer('pointerdown', 2, 500, 300));
    const middle = ground(controls, 400, 300);
    surface.dispatchEvent(pointer('pointermove', 2, 700, 300));
    expect(camera.zoom).toBeCloseTo(2, 6);
    // The ground that was under the middle of the fingers is under their new middle.
    expect(ground(controls, 500, 300).distanceTo(middle)).toBeLessThan(1e-6);
    surface.dispatchEvent(pointer('pointercancel', 1, 0, 0));
    surface.dispatchEvent(pointer('pointercancel', 2, 0, 0));
  });

  test('pinned to the avatar, a pinch or the wheel zooms about the target and keeps it', () => {
    const { camera, controls, surface, pans } = setup();
    controls.pinned = true;
    surface.dispatchEvent(pointer('pointerdown', 1, 300, 300));
    surface.dispatchEvent(pointer('pointerdown', 2, 500, 300));
    surface.dispatchEvent(pointer('pointermove', 2, 700, 300));
    expect(camera.zoom).toBeCloseTo(2, 6);
    expect(controls.target.length()).toBe(0);
    surface.dispatchEvent(pointer('pointerup', 1, 0, 0));
    surface.dispatchEvent(pointer('pointerup', 2, 0, 0));
    surface.dispatchEvent(
      Object.assign(new Event('wheel', { cancelable: true }), {
        deltaY: -100,
        deltaMode: 0,
        clientX: 100,
        clientY: 100,
        ctrlKey: false,
      }),
    );
    expect(camera.zoom).toBeGreaterThan(2);
    expect(controls.target.length()).toBe(0);
    expect([pans(), controls.pinned]).toEqual([0, true]);
  });

  test('the wheel zooms about the cursor, within the limits', () => {
    const { camera, controls, surface } = setup();
    const wheel = (deltaY: number, more: object = {}) => {
      const event = Object.assign(new Event('wheel', { cancelable: true }), {
        deltaY,
        deltaMode: 0,
        clientX: 200,
        clientY: 150,
        ctrlKey: false,
        ...more,
      });
      surface.dispatchEvent(event);
      return event;
    };
    const spot = ground(controls, 200, 150);
    expect(wheel(-100).defaultPrevented).toBe(true);
    expect(camera.zoom).toBeCloseTo(1 / 0.95, 6);
    expect(ground(controls, 200, 150).distanceTo(spot)).toBeLessThan(1e-6);
    wheel(100);
    expect(camera.zoom).toBeCloseTo(1, 6);
    wheel(3, { deltaMode: 1 }); // lines
    expect(camera.zoom).toBeCloseTo(0.95 ** 0.48, 6);
    wheel(1, { deltaMode: 2 }); // a page
    wheel(-1, { ctrlKey: true }); // a trackpad pinch
    wheel(100_000);
    expect(camera.zoom).toBe(0.5);
    wheel(-100_000);
    expect(camera.zoom).toBe(4);
  });

  test('another mouse button moves nothing', () => {
    const { surface, changes } = setup();
    surface.dispatchEvent(pointer('pointerdown', 1, 10, 10, { pointerType: 'mouse', button: 2 }));
    surface.dispatchEvent(pointer('pointermove', 1, 50, 50));
    expect(changes()).toBe(0);
  });

  test('a grab cursor that grabs while dragging, and dispose lets the page scroll again', () => {
    const { controls, surface } = setup();
    expect(surface.style).toEqual({ cursor: 'grab', touchAction: 'none' });
    surface.dispatchEvent(pointer('pointerdown', 1, 10, 10));
    expect(surface.style.cursor).toBe('grabbing');
    surface.dispatchEvent(pointer('pointerup', 1, 10, 10));
    expect(surface.style.cursor).toBe('grab');
    surface.dispatchEvent(new Event('contextmenu', { cancelable: true }));
    controls.dispose();
    expect(surface.style.touchAction).toBe('');
  });
});
