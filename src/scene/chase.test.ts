import { describe, expect, test } from 'bun:test';

import {
  CHASE_FOV,
  DISTANCE,
  DISTANCE_RANGE,
  LOOK_HEIGHT,
  MAP_FOV,
  PITCH,
  PITCH_RANGE,
  ZOOM_STOPS,
  boomDirection,
  boomPitch,
  chaseFov,
  DIVE_LIMIT,
  clearPitch,
  openYaw,
  createBoom,
  createSteerFrame,
  easeBoom,
  figureOpacity,
  flight,
  followStrength,
  freeLength,
  headLook,
  mapYaw,
  recentre,
  recentreWeight,
  spanAt,
  steerYaw,
  stretchBoom,
  turnBoom,
  wheelKind,
  wheelZoom,
  wrap,
  zoomStop,
} from './chase.ts';
import type { Lens, Shot, Vec3 } from './chase.ts';

describe('the boom', () => {
  test('starts behind and a little above, and aims within its pitch limits', () => {
    const boom = createBoom(1);
    expect(boom).toMatchObject({ yaw: 1, aimYaw: 1, pitch: PITCH, distance: DISTANCE });
    turnBoom(boom, 2.5, 5);
    expect(boom.aimYaw).toBeCloseTo(3.5 - Math.PI * 2);
    expect(boom.aimPitch).toBe(PITCH_RANGE[1]);
    expect(boom.yaw).toBe(1);
    turnBoom(boom, 0, -5);
    expect(boom.aimPitch).toBe(PITCH_RANGE[0]);
  });

  test('eases to its aim and length in the same time at any frame rate', () => {
    const ends = [30, 60, 120].map((hz) => {
      const boom = createBoom(0);
      turnBoom(boom, 1, 0.3);
      stretchBoom(boom, 2);
      let moving = true;
      for (let i = 0; i < hz / 10; i++) moving = easeBoom(boom, 0, 1 / hz);
      expect(moving).toBe(true);
      // A tenth of a second in, the turn is nearly done; the length, eased, about half way.
      expect(boom.yaw).toBeGreaterThan(0.8);
      expect(boom.length).toBeGreaterThan(DISTANCE * 1.4);
      expect(boom.length).toBeLessThan(DISTANCE * 1.7);
      for (let i = 0; i < hz * 3; i++) moving = easeBoom(boom, 0, 1 / hz);
      expect(moving).toBe(false);
      return [boom.yaw, boom.pitch, boom.length];
    });
    for (const end of ends) {
      expect(end[0]).toBeCloseTo(1, 3);
      expect(end[1]).toBeCloseTo(PITCH + 0.3, 3);
      expect(end[2]).toBeCloseTo(DISTANCE * 2, 2);
    }
  });

  test('a run lengthens the boom and widens the lens a little', () => {
    const boom = createBoom(0);
    for (let i = 0; i < 120; i++) easeBoom(boom, 1, 1 / 60);
    expect(boom.length).toBeGreaterThan(DISTANCE * 1.1);
    expect(chaseFov(16 / 9, 1)).toBeGreaterThan(chaseFov(16 / 9) + 4);
  });

  test('stretches within its length limits', () => {
    const boom = createBoom(0);
    stretchBoom(boom, 2);
    expect(boom.distance).toBeCloseTo(DISTANCE * 2);
    stretchBoom(boom, 100);
    expect(boom.distance).toBe(DISTANCE_RANGE[1]);
    stretchBoom(boom, 0.001);
    expect(boom.distance).toBe(DISTANCE_RANGE[0]);
  });

  test('points out behind the walker: yaw 0 is toward +z, pitch lifts it', () => {
    const out: Vec3 = [0, 0, 0];
    expect(boomDirection(0, 0, out)).toEqual([0, 0, 1]);
    const [x, y, z] = boomDirection(Math.PI / 2, Math.PI / 6, out);
    expect([x, y, z].map((v) => +v.toFixed(6))).toEqual([
      +Math.cos(Math.PI / 6).toFixed(6),
      0.5,
      0,
    ]);
  });
});

describe('zoom', () => {
  test('the buttons step between clear stops, from over the shoulder to a high follow view', () => {
    expect(ZOOM_STOPS[0]).toBe(DISTANCE_RANGE[0]);
    expect(ZOOM_STOPS.at(-1)).toBe(DISTANCE_RANGE[1]);
    expect(ZOOM_STOPS).toContain(DISTANCE);
    for (let i = 1; i < ZOOM_STOPS.length; i++) {
      expect(ZOOM_STOPS[i]! / ZOOM_STOPS[i - 1]!).toBeGreaterThan(1.5);
      expect(ZOOM_STOPS[i]! / ZOOM_STOPS[i - 1]!).toBeLessThan(2);
    }
    expect(zoomStop(DISTANCE, false)).toBe(13);
    expect(zoomStop(DISTANCE, true)).toBe(4.4);
    // From between stops (after a pinch), to the next one along, not back to the last.
    expect(zoomStop(9, true)).toBe(DISTANCE);
    expect(zoomStop(9, false)).toBe(13);
    // A hair off a stop counts as on it.
    expect(zoomStop(7.4, false)).toBe(13);
    expect(zoomStop(DISTANCE_RANGE[1], false)).toBe(DISTANCE_RANGE[1]);
    expect(zoomStop(DISTANCE_RANGE[0], true)).toBe(DISTANCE_RANGE[0]);
  });

  test('a mouse notch zooms about a sixth in any unit, a pinch as far as the fingers go', () => {
    const at = { deltaMode: 0, deltaX: 0, deltaY: 0, ctrlKey: false };
    const notch = wheelZoom({ ...at, deltaY: 100 }, false);
    expect(notch).toBeGreaterThan(1.1);
    expect(notch).toBeLessThan(1.25);
    // Firefox counts three lines a notch.
    expect(wheelZoom({ ...at, deltaMode: 1, deltaY: 3 }, false)).toBeCloseTo(notch, 1);
    expect(wheelZoom({ ...at, deltaMode: 2, deltaY: -1 }, false)).toBeLessThan(1);
    expect(wheelZoom({ ...at, deltaY: -100 }, false)).toBeCloseTo(1 / notch);
    expect(wheelZoom({ ...at, deltaY: 10, ctrlKey: true }, true)).toBeCloseTo(Math.exp(0.1));
    // A wheel spun hard still moves a step at a time.
    expect(wheelZoom({ ...at, deltaY: 5000 }, false)).toBeLessThan(2.1);
  });

  test('zoomed out it looks further down, zoomed in nearer level, smoothly', () => {
    expect(boomPitch(PITCH, DISTANCE)).toBeCloseTo(PITCH);
    const far = boomPitch(PITCH, DISTANCE_RANGE[1]);
    expect(far).toBeGreaterThan(PITCH + 0.3);
    expect(far).toBeLessThan(PITCH_RANGE[1]);
    const near = boomPitch(PITCH, DISTANCE_RANGE[0]);
    expect(near).toBeLessThan(PITCH);
    expect(near).toBeGreaterThan(0);
    let last = near;
    for (let length = DISTANCE_RANGE[0]; length <= DISTANCE_RANGE[1]; length *= 1.05) {
      const pitch = boomPitch(PITCH, length);
      expect(pitch).toBeGreaterThanOrEqual(last - 1e-9);
      expect(pitch - last).toBeLessThan(0.03);
      last = pitch;
    }
  });

  test('a drag still reaches straight down zoomed out, and every bit of it moves the view', () => {
    const far = DISTANCE_RANGE[1];
    expect(boomPitch(PITCH_RANGE[1], far)).toBeCloseTo(PITCH_RANGE[1]);
    for (let pitch = PITCH_RANGE[0]; pitch < PITCH_RANGE[1]; pitch += 0.05) {
      expect(boomPitch(pitch + 0.05, far)).toBeGreaterThan(boomPitch(pitch, far));
    }
  });

  test('looking up, the camera never sinks under the street', () => {
    for (const length of [DISTANCE_RANGE[0], DISTANCE, 20, DISTANCE_RANGE[1]]) {
      const height = LOOK_HEIGHT + Math.sin(boomPitch(PITCH_RANGE[0], length)) * length;
      expect(height).toBeGreaterThanOrEqual(1 - 1e-9);
    }
    // Shorter than the drop to the floor, any pitch is fine.
    expect(boomPitch(PITCH_RANGE[0], 1)).toBeLessThan(PITCH_RANGE[0]);
  });

  test('over rising ground behind the walker, the camera keeps a metre over that', () => {
    for (const rise of [2, 5]) {
      const pitch = boomPitch(PITCH_RANGE[0], 20, rise);
      expect(LOOK_HEIGHT + Math.sin(pitch) * 20).toBeGreaterThanOrEqual(1 + rise - 1e-9);
    }
    // Ground higher than the boom reaches: straight up is as high as it goes.
    expect(boomPitch(PITCH, 2.5, 10)).toBeCloseTo(Math.PI / 2);
  });
});

/** A house 10 m tall from z = 5 to 8, open street elsewhere. */
const house = (_x: number, z: number) => (z >= 5 && z <= 8 ? 10 : 0);

describe("the flight's line of sight", () => {
  test('stops short of a house behind the walker', () => {
    const free = freeLength(house, [0, 2.6, 0], [0, 0, 1], 20);
    expect(free).toBeLessThan(5);
    expect(free).toBeGreaterThan(3.5);
  });

  test('over the roof, or with open street behind, it reaches all the way', () => {
    expect(freeLength(house, [0, 2.6, 0], [0, 0.9, Math.sqrt(0.19)], 20)).toBe(20);
    expect(freeLength(house, [0, 2.6, 0], [0, 0, -1], 20)).toBe(20);
  });

  test('looking up, it stops above the ground, and never shrinks to nothing', () => {
    const free = freeLength(() => 0, [0, 2.6, 0], [0, -0.5, Math.sqrt(0.75)], 20);
    expect(free).toBeLessThan(4.2);
    expect(free).toBeGreaterThan(3);
    expect(freeLength(() => 99, [0, 2.6, 0], [0, 0, 1], 20)).toBe(0.5);
  });

  test('rising above every roof, it stops looking, however long it is', () => {
    let lookups = 0;
    const count = () => {
      lookups++;
      return 0;
    };
    expect(freeLength(count, [0, 2.6, 0], [0, 0.6, 0.8], 4000)).toBe(4000);
    expect(lookups).toBeLessThan(400);
  });

  test('changes smoothly as the walker nears a house, not a step at a time', () => {
    const lengths: number[] = [];
    for (let z = 0; z <= 0.5; z += 0.05)
      lengths.push(freeLength(house, [0, 2.6, z], [0, 0, 1], 20));
    const jumps = lengths.slice(1).map((l, i) => lengths[i]! - l);
    for (const jump of jumps) expect(jump).toBeLessThan(0.1);
    expect(lengths[0]! - lengths.at(-1)!).toBeCloseTo(0.5, 1);
  });
});

test('the figure fades only once the camera is within about a metre of it', () => {
  expect(figureOpacity(0, 5, 3)).toBe(1);
  expect(figureOpacity(1.5, 1.2, 0)).toBe(1);
  // Beside the head, half a metre off it: mostly gone; touching it, gone.
  const near = figureOpacity(0.4 + 0.6, 2, 0);
  expect(near).toBeGreaterThan(0);
  expect(near).toBeLessThan(0.5);
  expect(figureOpacity(0.2, 2, 0)).toBe(0);
  // Above the head counts from the top of it, below the feet from the soles.
  expect(figureOpacity(0, 2.4 + 0.4 + 0.65, 0)).toBeCloseTo(0.5, 1);
  expect(figureOpacity(0, -0.5, 0)).toBe(0);
});

describe('following', () => {
  test('recentres behind the walker the short way round, and its pitch to the default', () => {
    const boom = createBoom(Math.PI - 0.4); // walker faces +z, so behind is yaw π
    turnBoom(boom, 0, 0.5);
    recentre(boom, 0, 1, 0.5);
    expect(boom.aimYaw).toBeGreaterThan(Math.PI - 0.4);
    expect(boom.aimYaw).toBeLessThan(Math.PI);
    expect(boom.aimPitch).toBeLessThan(PITCH + 0.5);
    for (let i = 0; i < 40; i++) recentre(boom, 0, 1, 0.5);
    expect(Math.abs(boom.aimYaw)).toBeCloseTo(Math.PI);
    expect(boom.aimPitch).toBeCloseTo(PITCH);
    const across = createBoom(Math.PI - 0.2);
    recentre(across, 0.3, 1, 0.5); // behind is yaw -π + 0.3: on through π
    expect(Math.abs(across.aimYaw)).toBeGreaterThan(Math.PI - 0.2);
  });

  test('swings behind after a turn to either side, and after an about-turn a little slower', () => {
    expect(recentreWeight(0, Math.PI)).toBe(1);
    expect(recentreWeight(Math.PI / 2, Math.PI)).toBe(1);
    expect(recentreWeight(-Math.PI / 2, Math.PI)).toBe(1);
    // Turned right round toward the camera, it still comes round behind, at 0.6 the rate.
    expect(recentreWeight((3 * Math.PI) / 4, Math.PI)).toBeLessThan(1);
    expect(recentreWeight((3 * Math.PI) / 4, Math.PI)).toBeGreaterThan(0.6);
    expect(recentreWeight(Math.PI, Math.PI)).toBeCloseTo(0.6);
  });

  test('an about-turn ends with the camera behind the walker, its held key still going the same way', () => {
    // Walking toward the camera (heading 0, camera at yaw 0 in front), holding S.
    const boom = createBoom(0);
    const frame = createSteerFrame();
    const yaw0 = steerYaw(frame, boom.aimYaw, 0, -1);
    for (let i = 0; i < 60 * 3; i++) {
      const w = recentreWeight(0, boom.aimYaw);
      frame.drift = wrap(frame.drift + recentre(boom, 0, 2.2 * w, 1 / 60));
    }
    // Behind a walker facing +z is yaw π.
    expect(Math.abs(wrap(boom.aimYaw - Math.PI))).toBeLessThan(0.2);
    // The held key still steers the way it set off.
    expect(steerYaw(frame, boom.aimYaw, 0, -1)).toBeCloseTo(yaw0, 5);
  });

  test('a turn to the side is behind the walker within a second, the same at any frame rate', () => {
    const ends = [30, 60, 144].map((hz) => {
      const boom = createBoom(Math.PI); // behind a walker facing +z, who turns to +x
      for (let i = 0; i < hz; i++) {
        recentre(boom, Math.PI / 2, 2.2 * recentreWeight(Math.PI / 2, boom.aimYaw), 1 / hz);
      }
      return boom.aimYaw;
    });
    // Behind a walker facing +x is yaw -π/2: from π, the short way through -π.
    for (const yaw of ends) expect(Math.abs(yaw + Math.PI / 2)).toBeLessThan(0.2);
    expect(ends[0]).toBeCloseTo(ends[2]!, 2);
  });

  test('says how far it turned, so steering can leave that out', () => {
    const boom = createBoom(3);
    const turned = recentre(boom, 0, 2, 0.1);
    expect(turned).toBeCloseTo(boom.aimYaw - 3);
    expect(turned).toBeGreaterThan(0);
  });

  test('waits after a look by hand, then eases back in', () => {
    expect(followStrength(0)).toBe(0);
    expect(followStrength(0.9)).toBe(0);
    const ramp = [1.1, 1.3, 1.5].map(followStrength);
    expect(ramp[0]).toBeGreaterThan(0);
    expect(ramp[0]).toBeLessThan(ramp[1]!);
    expect(ramp[1]).toBeLessThan(ramp[2]!);
    expect(followStrength(5)).toBe(1);
    expect(followStrength(Infinity)).toBe(1);
  });

  test('a held key keeps its way while the camera swings round, a new key steers by the camera', () => {
    const frame = createSteerFrame();
    // Holding right (D) with the camera at yaw 0.
    expect(steerYaw(frame, 0, 1, 0)).toBe(0);
    // Following swings the aim by 0.8: the key still steers by yaw 0.
    frame.drift += 0.8;
    expect(steerYaw(frame, 0.8, 1, 0)).toBeCloseTo(0);
    // A look by hand on top turns the steering with it.
    expect(steerYaw(frame, 1.1, 1, 0)).toBeCloseTo(0.3);
    // Adding forward (W) is a new direction: by the camera as it is now.
    expect(steerYaw(frame, 1.1, 1, 1)).toBeCloseTo(1.1);
    expect(frame.drift).toBe(0);
    // A stick drifting a little stays in its frame; letting go forgets it.
    frame.drift = 0.4;
    expect(steerYaw(frame, 1.5, 0.9, 1)).toBeCloseTo(1.1);
    expect(steerYaw(frame, 1.5, 0, 0)).toBe(1.5);
    expect(frame.input).toBeNaN();
  });

  test('a new key while the camera comes round steers by where it will rest, not where it is', () => {
    const frame = createSteerFrame();
    // Walking forward (W) with the camera at yaw 0, then W+D turns the walker 45° right.
    expect(steerYaw(frame, 0, 0, 1)).toBe(0);
    expect(steerYaw(frame, 0, 1, 1, 0)).toBe(0);
    // The camera is only partway round (aim -0.3) to behind the walker (-π/4) when D is let go:
    // W now steers toward -π/4, the way the walker goes, not back toward -0.3.
    expect(steerYaw(frame, -0.3, 0, 1, -Math.PI / 4)).toBeCloseTo(-Math.PI / 4);
    // As the camera keeps coming round, the key keeps that way.
    frame.drift += -0.2;
    expect(steerYaw(frame, -0.5, 0, 1, -Math.PI / 4)).toBeCloseTo(-Math.PI / 4);
    // With the camera not following (NaN), a new key steers by the camera as it is.
    expect(steerYaw(frame, -0.5, 1, 0)).toBeCloseTo(-0.5);
  });

  test('the head looks where the camera looks, or back at the camera in front of it', () => {
    // Camera behind (yaw π for a walker facing +z): straight ahead.
    expect(headLook(0, Math.PI)).toBeCloseTo(0);
    expect(headLook(0, Math.PI - 0.5)).toBeCloseTo(-0.5);
    // Camera in front, a little to the side: the head turns to it.
    expect(headLook(0, 0.3)).toBeCloseTo(0.3);
  });
});

/** A 20 m block from 10 to 20 m out along +z, the way a yaw of 0 points the boom. */
const block = (_x: number, z: number) => (z > 10 && z < 20 ? 20 : 0);

describe('the flight between map and street', () => {
  const map: Shot = { look: [0, 0, 0], yaw: 0.8, pitch: 0.6, fov: MAP_FOV, span: 400 };
  const street: Shot = { look: [10, 2.6, 4], yaw: 0.8, pitch: 0.3, fov: CHASE_FOV, span: 8 };
  const lens: Lens = { look: [0, 0, 0], yaw: 0, pitch: 0, fov: 0, distance: 0 };

  test('starts on the map and ends behind the walker', () => {
    flight(map, street, 0, lens);
    expect(lens.look).toEqual([0, 0, 0]);
    expect([lens.pitch, lens.fov]).toEqual([0.6, MAP_FOV]);
    expect(spanAt(lens.distance, lens.fov)).toBeCloseTo(400);
    flight(map, street, 1, lens);
    expect(lens.look).toEqual([10, 2.6, 4]);
    expect([lens.pitch, lens.fov]).toEqual([0.3, CHASE_FOV]);
    expect(spanAt(lens.distance, lens.fov)).toBeCloseTo(8);
  });

  test('closes in steadily, without overshooting, and clamps its progress', () => {
    let last = Infinity;
    for (let t = 0; t <= 1; t += 0.05) {
      flight(map, street, t, lens);
      const span = spanAt(lens.distance, lens.fov);
      expect(span).toBeLessThanOrEqual(last + 1e-9);
      last = span;
    }
    flight(map, street, 2, lens);
    expect(lens.fov).toBe(CHASE_FOV);
  });

  test('dives over the middle of the way, never straight down, and lands as without', () => {
    const plain = { ...flight(map, street, 0.45, lens), look: [...lens.look] as Vec3 };
    flight(map, street, 0.45, lens, 0.7);
    expect(lens.pitch).toBeGreaterThan(plain.pitch + 0.5);
    expect(lens.look).toEqual(plain.look);
    expect(lens.distance).toBeCloseTo(plain.distance);
    flight(map, street, 0.5, lens, 5);
    expect(lens.pitch).toBe(DIVE_LIMIT);
    for (const t of [0, 1]) {
      const pitch = flight(map, street, t, lens).pitch;
      expect(flight(map, street, t, lens, 0.7).pitch).toBeCloseTo(pitch);
    }
    // Already steeper than the limit, the dive leaves it be.
    expect(flight({ ...map, pitch: 1.5 }, { ...street, pitch: 1.5 }, 0.5, lens, 0.7).pitch).toBe(
      1.5,
    );
  });

  test('starts from a heading that sees the walker without climbing over a roof', () => {
    const look: Vec3 = [0, 2.6, 0];
    // From the south (yaw 0) the house in the way; turned a sixteenth either way it still is,
    // so the nearest open heading is further round, and the same whichever way it was asked.
    const yaw = openYaw(block, look, 0, 200, 0.3);
    expect(Math.abs(yaw)).toBeGreaterThan(0);
    expect(clearPitch(block, look, yaw, 200, 0.3)).toBeLessThanOrEqual(0.35);
    // Open already: kept.
    expect(openYaw(block, look, Math.PI, 200, 0.3)).toBe(Math.PI);
    // Walled in all round: the heading that climbs least, the one asked for when all are equal.
    expect(openYaw(() => 1e3, look, 0.5, 50, 0.3)).toBe(0.5);
    // Open as asked: kept, whatever lies ahead.
    expect(openYaw(block, look, Math.PI, 200, 0.3, () => false)).toBe(Math.PI);
    // Turned, the nearest open heading that leaves somewhere to walk, else the nearest open one.
    expect(
      openYaw(block, look, 0, 200, 0.3, (at) => Math.abs(Math.abs(at) - Math.PI) < 0.01),
    ).toBeCloseTo(Math.PI);
    expect(openYaw(block, look, 0, 200, 0.3, () => false)).toBeCloseTo(yaw);
  });

  test('turns the short way round', () => {
    flight({ ...map, yaw: 3 }, { ...street, yaw: -3 }, 0.5, lens);
    expect(Math.abs(lens.yaw)).toBeCloseTo(Math.PI);
  });

  test('climbs over a roof in the way, and only as high as it must', () => {
    const look: Vec3 = [0, 2.6, 0];
    const low = 0.3;
    const pitch = clearPitch(block, look, 0, 200, low);
    expect(pitch).toBeGreaterThan(low);
    const dir = boomDirection(0, pitch, [0, 0, 0]);
    expect(freeLength(block, look, dir, 200)).toBe(200);
    expect(freeLength(block, look, boomDirection(0, pitch - 0.02, [0, 0, 0]), 200)).toBeLessThan(
      200,
    );
    // Nothing in the way, or the camera still short of the house: no climb at all.
    expect(clearPitch(block, look, Math.PI, 200, low)).toBe(low);
    expect(clearPitch(block, look, 0, 8, low)).toBe(low);
    // Walled in on every side, it goes as high as the boom may.
    expect(clearPitch(() => 1e3, look, 0, 50, low)).toBe(PITCH_RANGE[1]);
    expect(clearPitch(block, look, 0, 50, PITCH_RANGE[1] + 0.1)).toBe(PITCH_RANGE[1] + 0.1);
  });

  test('the map turns back to its nearest quarter view', () => {
    expect(mapYaw(Math.PI / 4 + 0.3)).toBeCloseTo(Math.PI / 4);
    expect(mapYaw(Math.PI - 0.1)).toBeCloseTo((3 * Math.PI) / 4);
    expect(mapYaw(-0.1)).toBeCloseTo(-Math.PI / 4);
  });
});

test('tall screens get a wider lens, so a phone still sees the street either side', () => {
  expect(chaseFov(16 / 9)).toBe(CHASE_FOV);
  expect(chaseFov(390 / 844)).toBeGreaterThan(80);
  const side = 2 * Math.atan(Math.tan((chaseFov(390 / 844) * Math.PI) / 360) * (390 / 844));
  expect((side * 180) / Math.PI).toBeCloseTo(44);
});

test('a trackpad swipe looks around; a pinch or a mouse wheel zooms', () => {
  const at = { deltaMode: 0, deltaX: 0, deltaY: 0, ctrlKey: false };
  expect(wheelKind({ ...at, deltaY: 3, ctrlKey: true })).toBe('pinch');
  expect(wheelKind({ ...at, deltaMode: 1, deltaY: 3 })).toBe('wheel');
  expect(wheelKind({ ...at, deltaX: -4, deltaY: 1 })).toBe('swipe');
  expect(wheelKind({ ...at, deltaY: 100, wheelDeltaY: -120 })).toBe('wheel');
  expect(wheelKind({ ...at, deltaY: -7, wheelDeltaY: 21 })).toBe('swipe');
  // A swipe that moves 40 px reads 120, like a notch, but keeps the trackpad's ratio.
  expect(wheelKind({ ...at, deltaY: -40, wheelDeltaY: 120 })).toBe('swipe');
  expect(wheelKind({ ...at, deltaY: 4, wheelDeltaY: -120 })).toBe('wheel');
  expect(wheelKind({ ...at, deltaY: 5 })).toBe('swipe');
});
