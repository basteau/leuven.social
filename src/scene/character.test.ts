import { describe, expect, test } from 'bun:test';
import { MeshBasicMaterial, Vector3 } from 'three';

import {
  BONES,
  PARTS,
  applyPose,
  characterGeometry,
  createCharacter,
  FOREARM,
  SHIN,
  THIGH,
  UPPER_ARM,
  legReach,
  limbIK,
  poseAt,
  restPose,
} from './character.ts';
import { unindexed } from './mesh-builder.ts';
import { IDLE_SECONDS, RUN_SPEED, WALK_SPEED } from './walker.ts';

describe('characterGeometry', () => {
  const g = unindexed(characterGeometry());
  const position = g.getAttribute('position');
  const outlined = PARTS.filter((p) => p.outline !== false).length;

  test('is a box per part plus an outline hull per outlined part, one bone per vertex', () => {
    expect(position.count).toBe((PARTS.length + outlined) * 36 + 18);
    const index = g.getAttribute('skinIndex');
    const weight = g.getAttribute('skinWeight');
    for (let i = 0; i < position.count; i++) {
      expect(index.getX(i)).toBeLessThan(BONES.length);
      expect(weight.getX(i)).toBe(1);
      expect(weight.getY(i)).toBe(0);
    }
  });

  test('stands on the origin, under two metres tall in model units, facing +z', () => {
    g.computeBoundingBox();
    const box = g.boundingBox!;
    expect(box.min.y).toBeCloseTo(-0.035);
    expect(box.max.y).toBeLessThan(2);
    expect(box.max.z).toBeGreaterThan(-box.min.z - 0.15); // nose ahead, backpack behind
  });

  test('hull faces point inward, so only their far sides draw round the silhouette', () => {
    // The top of the head's hull is the highest face of all, and faces down into the hair.
    g.computeBoundingBox();
    const normal = g.getAttribute('normal');
    let top = 0;
    const atTop = (i: number) => position.getY(i) > g.boundingBox!.max.y - 1e-4;
    for (let i = 0; i < position.count; i += 3) {
      if (!atTop(i) || !atTop(i + 1) || !atTop(i + 2)) continue;
      top++;
      expect(normal.getY(i)).toBeCloseTo(-1);
    }
    expect(top).toBe(2);
  });
});

test('the blob shadow is a dithered flat octagon on the root, just above the feet', () => {
  const g = unindexed(characterGeometry());
  const dither = g.getAttribute('dither');
  const position = g.getAttribute('position');
  const index = g.getAttribute('skinIndex');
  const blob = Array.from({ length: dither.count }, (_, i) => i).filter((i) => dither.getX(i));
  expect(blob).toHaveLength(6 * 3);
  for (const i of blob) {
    expect(position.getY(i)).toBeCloseTo(0.02);
    expect(index.getX(i)).toBe(BONES.indexOf('root'));
  }
});

describe('createCharacter and poses', () => {
  const material = new MeshBasicMaterial();
  const character = createCharacter(material, material);

  test('binds a skeleton of named bones, shared by the x-ray twin drawn just before it', () => {
    expect(character.mesh.skeleton.bones.map((b) => b.name)).toEqual([...BONES]);
    expect(character.xray.skeleton).toBe(character.mesh.skeleton);
    expect(character.xray.geometry).toBe(character.mesh.geometry);
    expect(character.xray.renderOrder).toBeLessThan(character.mesh.renderOrder);
    expect(character.mesh.frustumCulled || character.xray.frustumCulled).toBe(false);
  });

  test('standing still is the rest pose once the idle glance is over', () => {
    const pose = poseAt(restPose(), 0, 1.3, IDLE_SECONDS + 1, true);
    for (const [key, value] of Object.entries(restPose())) {
      expect(pose[key as keyof typeof pose]).toBeCloseTo(value);
    }
    const idling = poseAt(restPose(), 0, 0, IDLE_SECONDS / 4, true);
    expect(Math.abs(idling.look)).toBeGreaterThan(0.1);
    expect(poseAt(restPose(), 0, 0, IDLE_SECONDS / 4, false).look).toBe(0);
  });

  test('walking swings legs and arms against each other and bobs with the stride', () => {
    const stride = poseAt(restPose(), WALK_SPEED, Math.PI / 2, 0, true);
    expect(stride.legL).toBeLessThan(-0.3);
    expect(stride.legR).toBeGreaterThan(0.3);
    expect(stride.armL).toBeGreaterThan(0.4);
    expect(stride.armR).toBeCloseTo(-stride.armL);
    expect(Math.sign(stride.legL)).toBe(-Math.sign(stride.armL));
    const passing = poseAt(restPose(), WALK_SPEED, 0, 0, true);
    expect(passing.hips).toBeGreaterThan(stride.hips);
    expect(passing.lean).toBeGreaterThan(0);
  });

  test('the leg swinging through folds its knee; the planted one stays near straight', () => {
    const passing = poseAt(restPose(), WALK_SPEED, 0, 0, true);
    expect(passing.kneeL).toBeGreaterThan(0.5);
    expect(passing.kneeR).toBeLessThan(0.1);
    const later = poseAt(restPose(), WALK_SPEED, Math.PI, 0, true);
    expect(later.kneeR).toBeCloseTo(passing.kneeL);
  });

  test('running strides longer, leans in and bends the elbows', () => {
    const walk = poseAt(restPose(), WALK_SPEED, Math.PI / 2, 0, true);
    const run = poseAt(restPose(), RUN_SPEED, Math.PI / 2, 0, true);
    expect(run.legR - run.legL).toBeGreaterThan(walk.legR - walk.legL);
    expect(run.lean).toBeGreaterThan(walk.lean * 2);
    expect(run.elbowL).toBeLessThan(-1);
    expect(run.elbowR).toBeLessThan(-1);
    expect(walk.elbowL).toBeGreaterThan(-0.5);
    expect(poseAt(restPose(), RUN_SPEED, 0, 0, true).kneeL).toBeGreaterThan(1.2);
  });

  test('banks into a turn, more the faster it goes, within limits', () => {
    const slow = poseAt(restPose(), WALK_SPEED, 0, 0, true, 2);
    const fast = poseAt(restPose(), RUN_SPEED, 0, 0, true, 2);
    expect(slow.bank).toBeLessThan(0);
    expect(fast.bank).toBeLessThan(slow.bank);
    expect(poseAt(restPose(), RUN_SPEED, 0, 0, true, -50).bank).toBeCloseTo(0.3);
  });

  test('the head turns toward where the camera looks, but not round to its back', () => {
    expect(poseAt(restPose(), 0, 0, IDLE_SECONDS + 1, true, 0, 0.6).look).toBeCloseTo(0.6);
    expect(poseAt(restPose(), 0, 0, IDLE_SECONDS + 1, true, 0, 3).look).toBeCloseTo(1.1);
  });

  test('the soles never sink below the ground, walking, running or breathing', () => {
    for (let phase = 0; phase < Math.PI * 2; phase += 0.1) {
      for (const [speed, still] of [
        [RUN_SPEED, 0],
        [(RUN_SPEED + WALK_SPEED) / 2, 0],
        [WALK_SPEED, 0],
        [WALK_SPEED / 2, 0],
        [0, phase],
      ] as const) {
        const pose = poseAt(restPose(), speed, phase, still, true);
        expect(pose.hips - legReach(pose.legL, pose.kneeL)).toBeGreaterThanOrEqual(-1e-9);
        expect(pose.hips - legReach(pose.legR, pose.kneeR)).toBeGreaterThanOrEqual(-1e-9);
        // And one of them is on it, give or take the spring in the step.
        const lowest = Math.max(legReach(pose.legL, pose.kneeL), legReach(pose.legR, pose.kneeR));
        expect(pose.hips - lowest).toBeLessThan(0.04);
      }
    }
  });

  test('applying a pose moves the feet forward and back, and folds the knees', () => {
    const foot = (bone: 'shinL' | 'shinR') => {
      character.mesh.updateMatrixWorld(true);
      return character.bones[bone].localToWorld(new Vector3(0, -0.45, 0));
    };
    applyPose(character, poseAt(restPose(), WALK_SPEED, Math.PI / 2, 0, true));
    expect(foot('shinL').z).toBeGreaterThan(0.2);
    expect(foot('shinR').z).toBeLessThan(-0.2);
    applyPose(character, poseAt(restPose(), RUN_SPEED, 0, 0, true));
    expect(foot('shinL').y).toBeGreaterThan(0.25); // the swinging foot clears the ground
    applyPose(character, restPose());
    expect(foot('shinL').z).toBeCloseTo(0);
    expect(foot('shinL').y).toBeCloseTo(0);
  });
});

// The end of a limb hanging from its root, swung by `root` and bent by `joint` (as bones turn).
const end = (root: number, joint: number, a: number, b: number) => ({
  z: -a * Math.sin(root) - b * Math.sin(root + joint),
  y: -a * Math.cos(root) - b * Math.cos(root + joint),
});

describe('limbIK', () => {
  const limb = { root: 0, joint: 0 };

  test('puts the end of the limb on any target in reach, a knee bent forward', () => {
    for (const [z, y] of [
      [0, -0.8],
      [0.3, -0.6],
      [-0.4, -0.5],
      [0.2, -0.2],
      [0.5, 0.1],
    ] as const) {
      limbIK(limb, z, y, THIGH, SHIN, 1);
      const at = end(limb.root, limb.joint, THIGH, SHIN);
      expect(at.z).toBeCloseTo(z, 6);
      expect(at.y).toBeCloseTo(y, 6);
      expect(limb.joint).toBeGreaterThanOrEqual(0);
    }
  });

  test('bends an elbow the other way, onto the same target', () => {
    limbIK(limb, 0.35, -0.2, UPPER_ARM, FOREARM, -1);
    expect(limb.joint).toBeLessThan(0);
    const at = end(limb.root, limb.joint, UPPER_ARM, FOREARM);
    expect(at.z).toBeCloseTo(0.35, 6);
    expect(at.y).toBeCloseTo(-0.2, 6);
  });

  test('out of reach it points straight at the target; too close it folds up', () => {
    limbIK(limb, 2, -2, THIGH, SHIN, 1);
    expect(limb.joint).toBeCloseTo(0, 2);
    expect(limb.root).toBeCloseTo(-Math.PI / 4, 2);
    limbIK(limb, 0, 0, THIGH, SHIN, 1);
    expect(Number.isFinite(limb.root)).toBe(true);
    expect(limb.joint).toBeGreaterThan(2.9);
  });
});

test('a rolled body keeps its legs plumb and its hips shifted only up and down', () => {
  const material = new MeshBasicMaterial();
  const character = createCharacter(material, material);
  const foot = (bone: 'shinL' | 'shinR') => {
    character.mesh.updateMatrixWorld(true);
    return character.bones[bone].localToWorld(new Vector3(0, -SHIN, 0));
  };
  applyPose(character, { ...restPose(), roll: 0.3, hipsZ: 0.2 });
  const left = foot('shinL');
  const right = foot('shinR');
  expect(left.x).toBeCloseTo(0.1 * Math.cos(0.3), 6);
  expect(left.z).toBeCloseTo(0.2, 6);
  expect(left.y - right.y).toBeCloseTo(0.2 * Math.sin(0.3), 6);
  // The shoulders roll with the body.
  const shoulder = character.bones.armL.getWorldPosition(new Vector3());
  expect(shoulder.x).toBeLessThan(0.27);
});
