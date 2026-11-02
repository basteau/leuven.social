import { describe, expect, test } from 'bun:test';
import { MeshBasicMaterial, Vector3 } from 'three';

import { BRACKET, CRANK, SADDLE } from './bike-rig.ts';
import { ARM_SPREAD, FOREARM, applyPose, createCharacter, restPose } from './character.ts';
import type { Pose } from './character.ts';
import { FOOT_LEAN, createInput, createRider, stepRider } from './rider.ts';
import {
  ANKLE,
  DISMOUNT_TIME,
  FOOT_X,
  HIP_X,
  MOUNT_TIME,
  SHOULDER,
  SHOWN_STEER,
  UPRIGHT,
  gripAt,
  swingAt,
  pedalAt,
  rideAt,
} from './rider-pose.ts';
import type { Place, RideState } from './rider-pose.ts';
import { STEP } from './walker.ts';

const figure = createCharacter(new MeshBasicMaterial(), new MeshBasicMaterial());
const pose = restPose();
const at = new Vector3();

/** Where a bone's pivot (or a point along it) is, in the figure's model space, once posed. */
function where(bone: keyof typeof figure.bones, down = 0): [number, number, number] {
  figure.mesh.updateMatrixWorld(true);
  at.set(0, -down, 0).applyMatrix4(figure.bones[bone].matrixWorld);
  return [at.x, at.y, at.z];
}

const state = (more: Partial<RideState> = {}): RideState => ({
  crank: 0,
  steer: 0,
  stand: 0,
  foot: 0,
  look: 0,
  lean: 0,
  ...more,
});

describe('the rider on the figure’s own rig', () => {
  test('knows where the figure’s hips, ankles and shoulders are', () => {
    applyPose(figure, restPose());
    expect(figure.bones.legL.position.x).toBeCloseTo(HIP_X);
    expect(where('footL')[1]).toBeCloseTo(ANKLE);
    expect(figure.bones.armL.position.x).toBeCloseTo(SHOULDER.x);
    expect(figure.bones.armL.position.y).toBeCloseTo(SHOULDER.y);
  });

  test('seated, its feet stay on the pedals all the way round the crank', () => {
    for (let k = 0; k < 24; k++) {
      const crank = (k / 24) * Math.PI * 2;
      applyPose(figure, rideAt(pose, state({ crank })));
      for (const [bone, side] of [
        ['footL', 1],
        ['footR', -1],
      ] as const) {
        const [, y, z] = where(bone);
        const p = pedalAt(crank, side);
        // The ankle sits over the ball of the foot, which rests on the pedal.
        expect(Math.hypot(z - (p.z - 0.08), y - (p.y + ANKLE + 0.02))).toBeLessThan(0.01);
      }
      expect(pose.hips).toBeGreaterThan(SADDLE[1]);
    }
  });

  test('its hands stay on the grips, the bars straight or turned as far as half a radian', () => {
    expect(SHOWN_STEER).toBeGreaterThanOrEqual(0.5);
    for (const steer of [-SHOWN_STEER, -0.25, 0, 0.25, SHOWN_STEER]) {
      for (const stand of [0, 1]) {
        for (const crank of [0, 1, 2.5]) {
          applyPose(figure, rideAt(pose, state({ steer, stand, crank })));
          for (const [bone, side] of [
            ['foreL', 1],
            ['foreR', -1],
          ] as const) {
            const [x, y, z] = where(bone, FOREARM);
            const [gx, gy, gz] = gripAt(steer, side);
            expect(Math.hypot(x - gx, y - gy, z - gz)).toBeLessThan(0.005);
          }
          // Elbows a little bent, never locked straight; the hips square on the saddle.
          expect(Math.max(pose.elbowL, pose.elbowR)).toBeLessThan(-0.05);
          expect(pose.twist).toBe(0);
        }
      }
    }
    // Bars straight, the arms hang out from the body as walking.
    rideAt(pose, state());
    expect(pose.spreadL).toBeCloseTo(ARM_SPREAD, 1);
    expect(pose.spreadR).toBeCloseTo(ARM_SPREAD, 1);
  });

  test('standing, it rises off the saddle and rocks with the crank, the legs still reaching', () => {
    let [low, high] = [Infinity, -Infinity];
    for (let k = 0; k < 24; k++) {
      const crank = (k / 24) * Math.PI * 2;
      applyPose(figure, rideAt(pose, state({ crank, stand: 1 })));
      [low, high] = [Math.min(low, pose.hips), Math.max(high, pose.hips)];
      const [, y, z] = where('footL');
      const p = pedalAt(crank, 1);
      expect(Math.hypot(z - (p.z - 0.08), y - (p.y + ANKLE + 0.02))).toBeLessThan(0.02);
    }
    expect(low).toBeGreaterThan(SADDLE[1] + 0.06);
    expect(high - low).toBeGreaterThan(0.02);
    expect(rideAt(pose, state({ crank: Math.PI / 2, stand: 1 })).roll).toBeCloseTo(0.1);
    expect(pose.lean).toBeCloseTo(0.45);
  });

  test('stopped, it puts its left foot on the ground and leans less', () => {
    applyPose(figure, rideAt(pose, state({ crank: Math.PI / 2, foot: 1 })));
    expect(where('footL')[1]).toBeLessThan(ANKLE + 0.03);
    const [, y, z] = where('footR');
    const p = pedalAt(Math.PI / 2, -1);
    expect(Math.hypot(z - (p.z - 0.08), y - (p.y + ANKLE + 0.02))).toBeLessThan(0.01);
    expect(pose.lean).toBeCloseTo(0.25);
    // The head lifts against the lean.
    expect(pose.nod).toBeLessThan(0);
  });

  test('sits up against the bike’s lean, the hands still on the grips', () => {
    for (const lean of [-0.28, 0, 0.28]) {
      applyPose(figure, rideAt(pose, state({ lean, steer: 0.3 })));
      expect(pose.bank).toBeCloseTo(UPRIGHT * lean);
      for (const [bone, side] of [
        ['foreL', 1],
        ['foreR', -1],
      ] as const) {
        const [x, y, z] = where(bone, FOREARM);
        const [gx, gy, gz] = gripAt(0.3, side);
        expect(Math.hypot(x - gx, y - gy, z - gz)).toBeLessThan(0.005);
      }
    }
  });

  test('a foot down stands on the ground out beside the leaning bike', () => {
    const lean = 0.12;
    applyPose(figure, rideAt(pose, state({ crank: Math.PI / 2, foot: 1, lean })));
    figure.mesh.rotation.z = -lean;
    const [x, y] = where('footL');
    figure.mesh.rotation.z = 0;
    expect(y).toBeCloseTo(ANKLE, 2);
    expect(x).toBeCloseTo(FOOT_X, 2);
  });
});

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Where the figure's bones are in the bike's frame stood upright, getting on or off. */
function placed(stands: Place, bone: keyof typeof figure.bones, down = 0) {
  figure.mesh.position.set(stands.x, 0, stands.z);
  figure.mesh.rotation.z = -stands.tilt;
  const out = where(bone, down);
  figure.mesh.position.set(0, 0, 0);
  figure.mesh.rotation.z = 0;
  return out;
}
const near = (a: number[], b: readonly number[], within: number) =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) < within;

describe('getting on and off', () => {
  const seat = state({ crank: (3 * Math.PI) / 2, foot: 1, lean: FOOT_LEAN });
  const stands: Place = { x: 0, z: 0, tilt: 0, bike: 0, grip: 0 };
  /** Every step of a script at the riding rate, as poses and where the figure stood. */
  function run(on: boolean, from: Pose) {
    const steps = Math.round((on ? MOUNT_TIME : DISMOUNT_TIME) / STEP);
    return Array.from({ length: steps + 1 }, (_, i) => {
      const u = i / steps;
      const out = swingAt({} as Pose, on, u, seat, from, KICKSTAND, stands);
      applyPose(figure, out);
      const feet = [placed(stands, 'footL'), placed(stands, 'footR')];
      return { u, out, at: { ...stands }, feet, hands: placed(stands, 'foreL', FOREARM) };
    });
  }
  const KICKSTAND = 0.105;

  test('take about a second each, and start and end exactly in the poses either side', () => {
    expect(MOUNT_TIME).toBeGreaterThan(0.8);
    expect(MOUNT_TIME).toBeLessThan(1.2);
    expect(DISMOUNT_TIME).toBeGreaterThan(0.8);
    expect(DISMOUNT_TIME).toBeLessThan(1.2);
    const stood = restPose();
    const on = run(true, stood);
    const sat = rideAt({} as Pose, seat);
    for (const key of Object.keys(stood) as (keyof Pose)[]) {
      expect(on[0]!.out[key]).toBeCloseTo(stood[key]!);
      expect(on.at(-1)!.out[key]).toBeCloseTo(sat[key]!);
    }
    // Got on, the figure is in the bike's middle leaning as it does; off, it stands beside it.
    expect(on.at(-1)!.at).toMatchObject({ x: 0, z: 0, tilt: FOOT_LEAN, bike: FOOT_LEAN });
    const off = run(false, sat);
    for (const key of Object.keys(sat) as (keyof Pose)[])
      expect(off[0]!.out[key]).toBeCloseTo(sat[key]!);
    expect(off.at(-1)!.at.x).toBeGreaterThan(0.2);
    expect(off.at(-1)!.at).toMatchObject({ tilt: 0, bike: KICKSTAND, grip: 0 });
  });

  test('never pop: no joint jumps from one step to the next', () => {
    for (const steps of [run(true, restPose()), run(false, rideAt({} as Pose, seat))]) {
      let most = 0;
      for (let i = 1; i < steps.length; i++) {
        const [a, b] = [steps[i - 1]!, steps[i]!];
        // (An angle that goes round past half a turn draws the same, a whole turn on.)
        for (const key of Object.keys(b.out) as (keyof Pose)[]) {
          const turn = Math.abs(wrap((b.out[key] ?? 0) - (a.out[key] ?? 0)));
          // The swinging thigh turns about its own length quickest, as it passes level with
          // the hip, which shows little.
          most = Math.max(most, key.startsWith('splay') ? turn * (2 / 3) : turn);
        }
        // Nor where the figure stands, nor the feet.
        expect(Math.hypot(b.at.x - a.at.x, b.at.z - a.at.z)).toBeLessThan(0.01);
        // A swinging foot is quick, at most 7 m/s at the figure's scale, but never jumps.
        for (const f of [0, 1]) expect(near(b.feet[f]!, a.feet[f]!, 0.06)).toBe(true);
      }
      // At 120 steps a second, under 0.2 rad a step: at most 24 rad/s anywhere (36 for that).
      expect(most).toBeLessThan(0.2);
    }
  });

  test('feet stay on the ground: planted where they stand, never through it', () => {
    const on = run(true, restPose());
    const left = on.find((s) => s.u >= 0.24)!.feet[0]!;
    expect(left[1]).toBeCloseTo(ANKLE, 2);
    for (const s of on) {
      for (const f of s.feet) expect(f[1]).toBeGreaterThan(ANKLE - 0.005);
      // The left foot holds the ground while the right leg comes over.
      if (s.u >= 0.24 && s.u <= 0.74) expect(near(s.feet[0]!, left, 0.01)).toBe(true);
      // So does the right until it lifts.
      if (s.u <= 0.24) expect(s.feet[1]![1]).toBeCloseTo(ANKLE, 2);
    }
    const off = run(false, rideAt({} as Pose, seat));
    const down = off[0]!.feet[0]!;
    const landed = off.find((s) => s.u >= 0.76)!.feet[1]!;
    for (const s of off) {
      for (const f of s.feet) expect(f[1]).toBeGreaterThan(ANKLE - 0.005);
      if (s.u >= 0.05) expect(near(s.feet[0]!, down, 0.015)).toBe(true);
      if (s.u >= 0.76) expect(near(s.feet[1]!, landed, 0.01)).toBe(true);
    }
    expect(landed[1]).toBeCloseTo(ANKLE, 2);
  });

  test('the leg swings over the back of the bike, clear of the saddle and carrier', () => {
    for (const steps of [run(true, restPose()), run(false, rideAt({} as Pose, seat))]) {
      let crossed = false;
      for (const { feet } of steps) {
        const [x, y, z] = feet[1]!;
        // Over the bike's middle behind the bars, the ankle is above the saddle.
        if (Math.abs(x!) < 0.06 && z! < -0.1) {
          crossed = true;
          expect(y).toBeGreaterThan(SADDLE[1] + 0.05);
        }
      }
      expect(crossed).toBe(true);
    }
  });

  test('the hands hold the grips as they lean, and let go getting off', () => {
    for (const steps of [run(true, restPose()), run(false, rideAt({} as Pose, seat))]) {
      for (const s of steps) {
        if (s.at.grip < 1) continue;
        // The left grip, the bike leaning `bike` about its middle.
        const [gx, gy, gz] = gripAt(0, 1);
        const [c, sn] = [Math.cos(s.at.bike), Math.sin(s.at.bike)];
        expect(near(s.hands, [gx * c + gy * sn, gy * c - gx * sn, gz], 0.03)).toBe(true);
      }
    }
  });
});

describe('the rider', () => {
  test('a ride step and its pose together take well under 20 µs', () => {
    const r = createRider(0, 0, 0);
    const input = { ...createInput(), throttle: 1, turn: 0.3, sprint: true };
    const open = { wallOverlap: () => 0, closed: () => 0 };
    const s = state();
    const start = performance.now();
    for (let n = 0; n < 20_000; n++) {
      stepRider(r, STEP, input, open);
      [s.crank, s.steer, s.stand, s.foot, s.lean] = [r.crank, r.steer, r.stand, r.foot, r.lean];
      rideAt(pose, s);
    }
    expect(((performance.now() - start) * 1000) / 20_000).toBeLessThan(20);
    expect(BRACKET[1] - CRANK).toBeGreaterThan(0.1);
  });
});
