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
  const turns: number[] = [];
  const flicks: number[] = [];
  let yaw = Math.PI / 4;
  // As the viewer does: the camera goes round the target, at the same height and distance.
  const place = () => {
    const t = controls.target;
    camera.position.set(
      t.x + Math.sin(yaw) * Math.cos(pitch) * 2000,
      t.y + Math.sin(pitch) * 2000,
      t.z + Math.cos(yaw) * Math.cos(pitch) * 2000,
    );
    camera.lookAt(t);
  };
  const controls = new MapControls(
    camera,
    surface,
    () => changes++,
    () => pans++,
    (radians) => {
      turns.push(radians);
      yaw += radians;
      place();
    },
    (rate) => flicks.push(rate),
  );
  const turned = () => turns.reduce((sum, turn) => sum + turn, 0);
  return {
    camera,
    surface,
    controls,
    changes: () => changes,
    pans: () => pans,
    turns,
    turned,
    flicks,
  };
}

/** An event with these properties, read-only ones (its `timeStamp`) included. */
const made = (type: string, properties: object) => {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(event, key, { value });
  }
  return event;
};

const pointer = (type: string, id: number, x: number, y: number, more: object = {}) =>
  made(type, {
    pointerId: id,
    clientX: x,
    clientY: y,
    pointerType: 'touch',
    button: 0,
    ...more,
  });

const scroll = (surface: EventTarget, deltaX: number, deltaY: number, more: object = {}) => {
  const event = made('wheel', {
    deltaX,
    deltaY,
    deltaMode: 0,
    clientX: 200,
    clientY: 150,
    ctrlKey: false,
    shiftKey: false,
    timeStamp: 1000,
    ...more,
  });
  surface.dispatchEvent(event);
  return event;
};

const gesture = (type: string, scale: number, rotation: number, timeStamp = 100) =>
  made(type, { scale, rotation, clientX: 200, clientY: 150, timeStamp });

const ground = (controls: MapControls, x: number, y: number) =>
  controls.groundAt(x, y, new Vector3());

const mouse = { pointerType: 'mouse' };
/** A press, then moves at 16 ms apart, without the lift. */
const drag = (surface: EventTarget, id: number, press: object, path: number[][]) => {
  surface.dispatchEvent(pointer('pointerdown', id, path[0]![0]!, path[0]![1]!, press));
  for (const [i, [x, y]] of path.slice(1).entries()) {
    surface.dispatchEvent(pointer('pointermove', id, x!, y!, { timeStamp: 100 + i * 16 }));
  }
};
const lift = (surface: EventTarget, id: number, timeStamp: number, type = 'pointerup') =>
  surface.dispatchEvent(pointer(type, id, 0, 0, { timeStamp }));

/** Two fingers either side of (400, 300), `radians` round from level. */
const fingers = (radians: number, r = 100) => [
  [400 + Math.cos(radians) * r, 300 + Math.sin(radians) * r],
  [400 - Math.cos(radians) * r, 300 - Math.sin(radians) * r],
];
const moveTo = (surface: EventTarget, radians: number, r = 100, timeStamp = 100) => {
  const [a, b] = fingers(radians, r);
  surface.dispatchEvent(pointer('pointermove', 1, a![0]!, a![1]!, { timeStamp }));
  surface.dispatchEvent(pointer('pointermove', 2, b![0]!, b![1]!, { timeStamp }));
};
const twoDown = (surface: EventTarget) => {
  const [a, b] = fingers(0);
  surface.dispatchEvent(pointer('pointerdown', 1, a![0]!, a![1]!));
  surface.dispatchEvent(pointer('pointerdown', 2, b![0]!, b![1]!));
};

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
        deltaX: 0,
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
        deltaX: 0,
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

  describe('turning', () => {
    test.each([
      ['the right button', { button: 2 }],
      ['the middle button', { button: 1 }],
      ['Ctrl', { ctrlKey: true }],
      ['Alt', { altKey: true }],
    ])('%s and a sideways drag turns the map, and the avatar stays pinned', (_, press) => {
      const { controls, surface, turned, pans } = setup();
      controls.pinned = true;
      drag(surface, 1, { ...mouse, ...press }, [
        [100, 100],
        [103, 100], // a wobble
        [120, 100], // past the slop: from here, no jump
        [220, 300],
      ]);
      expect(turned()).toBeCloseTo((-100 * 0.8 * Math.PI) / 180, 6);
      expect([pans(), controls.pinned]).toEqual([0, true]);
      expect(controls.target.length()).toBe(0);
    });

    test('a plain mouse drag still drags, and a touch never counts as a turning drag', () => {
      const { controls, surface, turned, pans } = setup();
      drag(surface, 1, mouse, [
        [100, 100],
        [200, 100],
      ]);
      lift(surface, 1, 200);
      drag(surface, 2, { ctrlKey: true }, [
        [100, 100],
        [200, 100],
      ]);
      expect(turned()).toBe(0);
      expect(pans()).toBe(2);
      expect(controls.pinned).toBe(false);
    });

    test('a twist turns the map one for one, once past the slop, without a jump', () => {
      const { surface, turned, turns } = setup();
      twoDown(surface);
      // 25 px along a circle of radius 100 is a quarter of a radian.
      moveTo(surface, 0.1);
      expect(turns).toEqual([]);
      moveTo(surface, 0.4);
      const first = turned();
      expect(Math.abs(first)).toBeLessThanOrEqual(0.3);
      moveTo(surface, 0.9);
      // Clockwise on screen (y down) is the way yaw grows.
      expect(turned() - first).toBeCloseTo(0.5, 6);
    });

    test('a twist keeps the ground under the fingers’ middle', () => {
      const { controls, surface } = setup();
      twoDown(surface);
      moveTo(surface, 0.4);
      const middle = ground(controls, 400, 300);
      moveTo(surface, 1);
      expect(ground(controls, 400, 300).distanceTo(middle)).toBeLessThan(1e-6);
    });

    test('pinned, a twist turns about the avatar and keeps it', () => {
      const { controls, surface, turned, pans } = setup();
      controls.pinned = true;
      twoDown(surface);
      moveTo(surface, 0.5);
      moveTo(surface, 1);
      expect(turned()).toBeGreaterThan(0.4);
      expect(controls.target.length()).toBe(0);
      expect([pans(), controls.pinned]).toEqual([0, true]);
    });

    test('a pinch alone never turns, even wobbling, and closer fingers need more of a twist', () => {
      const { camera, surface, turned } = setup();
      twoDown(surface);
      for (const [i, r] of [120, 150, 180, 220].entries()) moveTo(surface, i % 2 ? 0.05 : -0.05, r);
      expect(turned()).toBe(0);
      expect(camera.zoom).toBeGreaterThan(2);
      const close = setup();
      twoDown(close.surface);
      moveTo(close.surface, 0, 20); // the fingers come together
      moveTo(close.surface, 0.3, 20); // a quarter radian would do at 100 px; 0.3 not at 20
      expect(close.turned()).toBe(0);
      moveTo(close.surface, 0.6, 20); // but never more than 20° is asked
      expect(Math.abs(close.turned())).toBeGreaterThan(0);
    });

    test('a finger left behind after a twist does not let go of the avatar', () => {
      const { controls, surface, pans } = setup();
      controls.pinned = true;
      twoDown(surface);
      moveTo(surface, 0.5);
      moveTo(surface, 1);
      lift(surface, 2, 200);
      const [a] = fingers(1);
      // It trembles, a pixel from where it was.
      surface.dispatchEvent(pointer('pointermove', 1, a![0]! + 1, a![1]!));
      expect([pans(), controls.pinned]).toEqual([0, true]);
      // A real drag of it still lets go.
      surface.dispatchEvent(pointer('pointermove', 1, a![0]! + 40, a![1]!));
      expect([pans(), controls.pinned]).toEqual([1, false]);
    });

    test('two fingers reporting at one stamp count as one slow turn, not a flick', () => {
      const { surface, flicks } = setup();
      twoDown(surface);
      moveTo(surface, 0.4, 100, 100);
      // 0.02 rad a frame each of 50 ms: 0.4 rad/s, however the events bunch.
      for (let i = 1; i <= 8; i++) moveTo(surface, 0.4 + i * 0.02, 100, 100 + i * 50);
      lift(surface, 1, 500);
      lift(surface, 2, 505);
      expect(flicks).toHaveLength(1);
      expect(Math.abs(flicks[0]!)).toBeLessThan(1);
    });

    test('a twist goes on past half a turn', () => {
      const { surface, turned } = setup();
      twoDown(surface);
      for (let a = 0.3; a < 4; a += 0.3) moveTo(surface, a);
      expect(turned()).toBeGreaterThan(3);
    });

    test('lifted while turning, it flicks; lifted after a pause, it does not', () => {
      const flicked = setup();
      drag(flicked.surface, 1, { ...mouse, button: 2 }, [
        [100, 100],
        [120, 100],
        [130, 100],
        [140, 100],
        [150, 100],
      ]);
      lift(flicked.surface, 1, 150);
      expect(flicked.flicks).toHaveLength(1);
      expect(flicked.flicks[0]!).toBeLessThan(0); // the way the drag was turning
      const paused = setup();
      drag(paused.surface, 1, { ...mouse, button: 2 }, [
        [100, 100],
        [120, 100],
        [130, 100],
      ]);
      lift(paused.surface, 1, 400);
      expect(paused.flicks).toEqual([]);
      const cancelled = setup();
      drag(cancelled.surface, 1, { ...mouse, button: 2 }, [
        [100, 100],
        [120, 100],
        [130, 100],
      ]);
      lift(cancelled.surface, 1, 120, 'pointercancel');
      expect(cancelled.flicks).toEqual([]);
    });

    test('a drag that never turned, lifted, is no flick', () => {
      const { surface, flicks } = setup();
      drag(surface, 1, mouse, [
        [100, 100],
        [200, 100],
      ]);
      lift(surface, 1, 110);
      expect(flicks).toEqual([]);
    });

    describe('a scroll', () => {
      test('sideways turns, about the middle, and stays pinned', () => {
        const { camera, controls, surface, turned } = setup();
        controls.pinned = true;
        expect(scroll(surface, 100, 0).defaultPrevented).toBe(true);
        expect(turned()).toBeCloseTo((100 * 0.2 * Math.PI) / 180, 6);
        expect([camera.zoom, controls.pinned]).toEqual([1, true]);
      });

      test('keeps to the axis it started on, however the fingers drift', () => {
        const zoom = setup();
        scroll(zoom.surface, 0, 40, { timeStamp: 0 });
        scroll(zoom.surface, 80, 0, { timeStamp: 20 });
        expect(zoom.turned()).toBe(0);
        expect(zoom.camera.zoom).toBeLessThan(1);
        const turn = setup();
        scroll(turn.surface, 40, 2, { timeStamp: 0 });
        const was = turn.camera.zoom;
        scroll(turn.surface, 0, 80, { timeStamp: 20 });
        expect(turn.camera.zoom).toBe(was);
        // A new scroll, after a gap, chooses again.
        scroll(turn.surface, 0, 80, { timeStamp: 400 });
        expect(turn.camera.zoom).toBeLessThan(was);
      });

      test('a diagonal zooms, and a first tiny event waits to show its way', () => {
        const { camera, surface, turned } = setup();
        scroll(surface, 1, 1, { timeStamp: 0 });
        expect([camera.zoom, turned()]).toEqual([1, 0]);
        scroll(surface, 30, 28, { timeStamp: 5 });
        expect(turned()).toBe(0);
        expect(camera.zoom).toBeLessThan(1);
      });

      test('a pinch is always a zoom, whichever way its fingers drift', () => {
        const { camera, surface, turned } = setup();
        scroll(surface, 50, -1, { ctrlKey: true });
        expect(turned()).toBe(0);
        expect(camera.zoom).toBeGreaterThan(1);
      });
    });

    describe('Safari’s trackpad gesture', () => {
      test('pinches and, past a small twist, turns with no jump', () => {
        const { camera, surface, turned } = setup();
        const start = gesture('gesturestart', 1, 0);
        surface.dispatchEvent(start);
        expect(start.defaultPrevented).toBe(true);
        surface.dispatchEvent(gesture('gesturechange', 1.5, 3));
        expect(camera.zoom).toBeCloseTo(1.5, 6);
        expect(turned()).toBe(0);
        surface.dispatchEvent(gesture('gesturechange', 1.5, 20));
        const past = turned();
        surface.dispatchEvent(gesture('gesturechange', 1.5, 30));
        expect(turned() - past).toBeCloseTo((10 * Math.PI) / 180, 6);
      });

      test('leaves the touch screen to the pointers, which have already said it', () => {
        const { camera, surface, turned } = setup();
        surface.dispatchEvent(pointer('pointerdown', 1, 100, 100));
        surface.dispatchEvent(gesture('gesturestart', 1, 0));
        surface.dispatchEvent(gesture('gesturechange', 2, 40));
        expect([camera.zoom, turned()]).toEqual([1, 0]);
      });
    });
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
