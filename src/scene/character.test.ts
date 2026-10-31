import { describe, expect, test } from 'bun:test';
import { MeshBasicMaterial, Vector3 } from 'three';

import {
  BONES,
  PARTS,
  applyPose,
  characterGeometry,
  createCharacter,
  poseAt,
  restPose,
} from './character.ts';
import { IDLE_SECONDS, WALK_SPEED } from './walker.ts';

describe('characterGeometry', () => {
  const g = characterGeometry();
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
  const g = characterGeometry();
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
    expect(stride.leg).toBeLessThan(-0.5);
    expect(stride.arm).toBeGreaterThan(0.5);
    expect(Math.sign(stride.leg)).toBe(-Math.sign(stride.arm));
    const passing = poseAt(restPose(), WALK_SPEED, 0, 0, true);
    expect(passing.hips).toBeGreaterThan(stride.hips);
    expect(passing.lean).toBeGreaterThan(0);
  });

  test('applying a pose moves the feet forward and back', () => {
    const foot = (bone: 'legL' | 'legR') => {
      character.mesh.updateMatrixWorld(true);
      return character.bones[bone].localToWorld(new Vector3(0, -0.8, 0)).z;
    };
    applyPose(character, poseAt(restPose(), WALK_SPEED, Math.PI / 2, 0, true));
    expect(foot('legL')).toBeGreaterThan(0.3);
    expect(foot('legR')).toBeLessThan(-0.3);
    applyPose(character, restPose());
    expect(foot('legL')).toBeCloseTo(0);
  });
});
