import { describe, expect, test } from 'bun:test';
import { MeshBasicMaterial, Vector3 } from 'three';

import { BRACKET, CRANK, SADDLE } from './bike-rig.ts';
import { FOREARM, applyPose, createCharacter, restPose } from './character.ts';
import type { Pose } from './character.ts';
import { createInput, createRider, stepRider } from './rider.ts';
import {
  ANKLE,
  HIP_X,
  SHOULDER,
  SHOWN_STEER,
  blendPose,
  gripAt,
  pedalAt,
  rideAt,
} from './rider-pose.ts';
import type { RideState } from './rider-pose.ts';
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

  test('its hands stay on the grips, the bars straight or turned', () => {
    for (const steer of [-SHOWN_STEER, 0, SHOWN_STEER]) {
      for (const stand of [0, 1]) {
        applyPose(figure, rideAt(pose, state({ steer, stand, crank: 1 })));
        for (const [bone, side] of [
          ['foreL', 1],
          ['foreR', -1],
        ] as const) {
          const [x, y, z] = where(bone, FOREARM);
          const [gx, gy, gz] = gripAt(steer, side);
          expect(Math.hypot(y - gy, z - gz)).toBeLessThan(0.02);
          expect(Math.abs(x - gx)).toBeLessThan(0.07);
        }
        // Elbows a little bent, never locked straight.
        expect(pose.elbowL).toBeLessThan(-0.05);
      }
    }
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

  test('getting on blends from standing, swinging the right leg over the saddle', () => {
    const stood = restPose();
    const sat = rideAt({} as Pose, state());
    const out = {} as Pose;
    blendPose(out, stood, sat, 0);
    for (const key of Object.keys(stood) as (keyof Pose)[])
      expect(out[key]).toBeCloseTo(stood[key]);
    expect(blendPose(out, stood, sat, 1).hips).toBeCloseTo(sat.hips);
    blendPose(out, stood, sat, 0.5);
    expect(out.legR).toBeLessThan(Math.min(stood.legR, sat.legR) - 0.5);
  });

  test('a ride step and its pose together take well under 20 µs', () => {
    const r = createRider(0, 0, 0);
    const input = { ...createInput(), throttle: 1, turn: 0.3, sprint: true };
    const open = { wallOverlap: () => 0, closed: () => 0 };
    const s = state();
    const start = performance.now();
    for (let n = 0; n < 20_000; n++) {
      stepRider(r, STEP, input, open);
      [s.crank, s.steer, s.stand, s.foot] = [r.crank, r.steer, r.stand, r.foot];
      rideAt(pose, s);
    }
    expect(((performance.now() - start) * 1000) / 20_000).toBeLessThan(20);
    expect(BRACKET[1] - CRANK).toBeGreaterThan(0.1);
  });
});
