import { describe, expect, test } from 'bun:test';
import { MeshBasicMaterial, Vector3 } from 'three';

import {
  BONES,
  OUTLINE_WIDTH,
  figure,
  grown,
  applyPose,
  characterGeometry,
  createCharacter,
  FOREARM,
  SHIN,
  THIGH,
  UPPER_ARM,
  CHARACTER_SCALE,
  limbIK,
  poseAt,
  restPose,
} from './character.ts';
import { unindexed } from './mesh-builder.ts';
import { WALKER } from './palette.ts';
import { IDLE_SECONDS, RUN_SPEED, STEP, WALK_SPEED, createWalker, stepWalker } from './walker.ts';

/** The sole's heel, ball and toe tip, from the ankle (z forward, y up; model metres). */
const SOLE = [
  [-0.105, -0.09],
  [0.12, -0.09],
  [0.2, -0.05],
] as const;

/** A palette colour as the normalised bytes the geometry stores. */
const bytes = (hex: number) => [hex >> 16, (hex >> 8) & 255, hex & 255].map((c) => c / 255);

describe('characterGeometry', () => {
  const g = unindexed(characterGeometry());
  const position = g.getAttribute('position');

  test('stays within 750 triangles, one bone to a vertex', () => {
    expect(position.count / 3).toBeLessThanOrEqual(750);
    const index = g.getAttribute('skinIndex');
    const weight = g.getAttribute('skinWeight');
    for (let i = 0; i < position.count; i++) {
      expect(index.getX(i)).toBeLessThan(BONES.length);
      expect(weight.getX(i)).toBe(1);
      expect(weight.getY(i)).toBe(0);
    }
  });

  test('keeps its arrays after the GPU has them, for skinned bounds and a lost context', () => {
    const geometry = characterGeometry();
    for (const a of [geometry.index!, ...Object.values(geometry.attributes)]) {
      const buffer = 'data' in a ? a.data : a;
      buffer.onUploadCallback();
      expect(buffer.array).not.toBeNull();
    }
  });

  test('stands on the origin, under two metres tall in model units, facing +z', () => {
    g.computeBoundingBox();
    const box = g.boundingBox!;
    expect(box.min.y).toBeCloseTo(-OUTLINE_WIDTH);
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
    expect(top).toBe(6); // an octagon
  });

  test('a hull moves every side of a part out by the outline width', () => {
    const thigh = figure(WALKER)[0]!;
    const [bottom, top] = grown(thigh.rings, OUTLINE_WIDTH);
    const xs = bottom!.map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(0.035 - OUTLINE_WIDTH);
    expect(Math.max(...xs)).toBeCloseTo(0.165 + OUTLINE_WIDTH);
    expect(bottom![0]![1]).toBeCloseTo(0.47 - OUTLINE_WIDTH);
    expect(top![0]![1]).toBeCloseTo(0.84 + OUTLINE_WIDTH);
  });

  test('every part but the smallest sits well inside its hull', () => {
    const solids = figure(WALKER);
    const outlined = solids.filter((s) => s.hull !== false);
    expect(outlined.length).toBeGreaterThan(solids.length / 2);
    for (const solid of outlined) {
      const hull = grown(solid.hull || solid.rings, OUTLINE_WIDTH).flat();
      for (const axis of [0, 1, 2]) {
        const [lo, hi] = [
          Math.min(...hull.map((p) => p[axis]!)),
          Math.max(...hull.map((p) => p[axis]!)),
        ];
        for (const p of solid.rings.flat()) {
          expect(p[axis]! - lo).toBeGreaterThan(0.015);
          expect(hi - p[axis]!).toBeGreaterThan(0.015);
        }
      }
    }
  });

  test('dresses the walker in its outfit, the coat always the accent blue', () => {
    const outfit = { scarf: 0xc4553c, bag: 0x6e7a3c, hair: 0xd8b060, trousers: 0x48597a };
    const colours = unindexed(characterGeometry(outfit)).getAttribute('color');
    const has = (hex: number) =>
      Array.from({ length: colours.count }, (_, i) => i).some((i) =>
        bytes(hex).every((c, k) => Math.abs(colours.getComponent(i, k) - c) < 1e-6),
      );
    for (const hex of [outfit.scarf, outfit.bag, outfit.hair, outfit.trousers, WALKER.coat]) {
      expect(has(hex)).toBe(true);
    }
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
  const point = new Vector3();
  /** The heel, ball and toe tip of a foot, in the world (metres). */
  const sole = (side: 'L' | 'R') => {
    character.mesh.updateMatrixWorld(true);
    return SOLE.map(([z, y]) =>
      character.bones[`foot${side}`].localToWorld(point.set(0, y, z)).clone(),
    );
  };
  const lowest = (side: 'L' | 'R') => Math.min(...sole(side).map((p) => p.y));

  test('binds a skeleton of named bones, shared by the x-ray twin drawn just before it', () => {
    expect(character.mesh.skeleton.bones.map((b) => b.name)).toEqual([...BONES]);
    expect(character.xray.skeleton).toBe(character.mesh.skeleton);
    expect(character.xray.geometry).toBe(character.mesh.geometry);
    expect(character.xray.renderOrder).toBeLessThan(character.mesh.renderOrder);
    expect(character.mesh.frustumCulled || character.xray.frustumCulled).toBe(false);
  });

  test('stands on flat feet, under its hips, once the idle glance is over', () => {
    const pose = poseAt(restPose(), 0, 1.3, IDLE_SECONDS + 1, true);
    for (const [key, value] of Object.entries(restPose())) {
      expect(pose[key as keyof typeof pose]).toBeCloseTo(value);
    }
    applyPose(character, pose);
    for (const side of ['L', 'R'] as const) {
      const [heel, ball, toe] = sole(side);
      expect(heel!.y).toBeCloseTo(0, 3);
      expect(ball!.y).toBeCloseTo(0, 3);
      expect(toe!.y).toBeGreaterThan(0.02); // the toe springs up
    }
    const idling = poseAt(restPose(), 0, 0, IDLE_SECONDS / 4, true);
    expect(Math.abs(idling.look)).toBeGreaterThan(0.1);
    expect(poseAt(restPose(), 0, 0, IDLE_SECONDS / 4, false).look).toBe(0);
  });

  test('walking swings each thigh about 0.6 rad, against the arm on its side', () => {
    let [forward, back] = [0, 0];
    for (let phase = 0; phase < Math.PI * 2; phase += 0.05) {
      const pose = poseAt(restPose(), WALK_SPEED, phase, 0, true);
      [forward, back] = [Math.min(forward, pose.legL), Math.max(back, pose.legL)];
    }
    expect(-forward).toBeGreaterThan(0.5);
    expect(-forward).toBeLessThan(0.95);
    expect(back).toBeGreaterThan(0.4);
    // The left foot lands at a quarter cycle, ahead, with the left arm back.
    const landing = poseAt(restPose(), WALK_SPEED, Math.PI / 2, 0, true);
    expect(landing.legL).toBeLessThan(-0.3);
    expect(landing.legR).toBeGreaterThan(0.3);
    expect(landing.armL).toBeGreaterThan(0.4);
    expect(landing.armR).toBeCloseTo(-landing.armL);
  });

  test('a walk bobs, highest over the planted foot; a run is lower and leans in further', () => {
    const passing = poseAt(restPose(), WALK_SPEED, 0, 0, true);
    const landing = poseAt(restPose(), WALK_SPEED, Math.PI / 2, 0, true);
    expect(passing.hips).toBeGreaterThan(landing.hips + 0.03);
    expect(passing.kneeL).toBeGreaterThan(0.5); // the leg swinging through folds its knee
    const run = poseAt(restPose(), RUN_SPEED, Math.PI / 2, 0, true);
    expect(run.hips).toBeLessThan(landing.hips);
    expect(run.lean).toBeGreaterThan(landing.lean * 2);
    expect(run.elbowL).toBeLessThan(-1);
    expect(run.elbowR).toBeLessThan(-1);
    expect(landing.elbowL).toBeGreaterThan(-0.6);
  });

  test('the soles never sink below the ground, walking, running, turning or breathing', () => {
    for (let phase = 0; phase < Math.PI * 2; phase += 0.05) {
      for (const [speed, still, turning] of [
        [RUN_SPEED, 0, 0],
        [(RUN_SPEED + WALK_SPEED) / 2, 0, 0],
        [WALK_SPEED, 0, 0],
        [WALK_SPEED / 3, 0, 0],
        [0.3, 0, 3],
        [0, phase, 0],
        [0, 1, 4],
      ] as const) {
        applyPose(character, poseAt(restPose(), speed, phase, still, true, turning, 0, 0, phase));
        const [left, right] = [lowest('L'), lowest('R')];
        expect(Math.min(left, right)).toBeGreaterThan(-2e-3);
        // Walking or standing straight, a foot is always down.
        if (speed <= WALK_SPEED && !turning) expect(Math.min(left, right)).toBeLessThan(5e-3);
      }
    }
  });

  test('running has a moment with both feet off the ground at every step', () => {
    let airborne = 0;
    for (let phase = 0; phase < Math.PI * 2; phase += Math.PI / 64) {
      applyPose(character, poseAt(restPose(), RUN_SPEED, phase, 0, true));
      if (Math.min(lowest('L'), lowest('R')) > 0.01) airborne++;
    }
    expect(airborne / 128).toBeGreaterThan(0.2);
    expect(airborne / 128).toBeLessThan(0.6);
  });

  /**
   * The furthest a planted foot slides while it is down (m), walking straight across open
   * ground: the real walker at 120 Hz, the real skeleton, the ball of each foot in the world.
   */
  function slip(run: boolean): { worst: number; steps: number; speed: number } {
    const open = { wallOverlap: () => 0, closed: () => 0 };
    const walker = createWalker(0, 0, 0);
    const pose = restPose();
    const planted = new Map<string, Vector3>();
    const [z, y] = SOLE[1];
    let [worst, steps] = [0, 0];
    for (let t = 0; t < 4; t += STEP) {
      stepWalker(walker, STEP, 0, 1, open, run);
      poseAt(pose, walker.speed, walker.phase, walker.still, true, 0, 0, walker.accel);
      applyPose(character, pose);
      character.mesh.position.set(walker.x, 0, walker.z);
      character.mesh.scale.setScalar(CHARACTER_SCALE);
      character.mesh.updateMatrixWorld(true);
      if (t < 1.5) continue; // up to speed
      for (const side of ['L', 'R'] as const) {
        const ball = character.bones[`foot${side}`].localToWorld(point.set(0, y, z));
        const from = planted.get(side);
        if (ball.y > 1e-3) {
          if (from) steps++;
          planted.delete(side);
        } else if (from) worst = Math.max(worst, Math.hypot(ball.x - from.x, ball.z - from.z));
        else planted.set(side, ball.clone());
      }
    }
    character.mesh.position.set(0, 0, 0);
    character.mesh.scale.setScalar(1);
    return { worst, steps, speed: walker.speed };
  }

  test('a planted foot stays where it landed, walking and running', () => {
    const walk = slip(false);
    expect(walk.speed).toBeCloseTo(WALK_SPEED);
    expect(walk.steps).toBeGreaterThan(5);
    expect(walk.worst).toBeLessThan(0.1);
    const run = slip(true);
    expect(run.speed).toBeCloseTo(RUN_SPEED);
    expect(run.steps).toBeGreaterThan(7);
    expect(run.worst).toBeLessThan(0.1);
  });

  test('setting off leans in with the hips ahead; stopping leans back, then stands up straight', () => {
    const cruising = poseAt(restPose(), 2, 1, 0, true);
    const starting = poseAt(restPose(), 2, 1, 0, true, 0, 0, 15);
    const stopping = poseAt(restPose(), 2, 1, 0, true, 0, 0, -30);
    expect(starting.lean).toBeGreaterThan(cruising.lean + 0.1);
    expect(starting.hipsZ).toBeGreaterThan(0.03);
    expect(stopping.lean).toBeLessThan(cruising.lean - 0.15);
    expect(stopping.hipsZ).toBeLessThan(-0.03);
    // Without the idle motion (reduced motion), none of it.
    expect(poseAt(restPose(), 2, 1, 0, false, 0, 0, 15).lean).toBeCloseTo(cruising.lean);
    // Stopped, the walker stands straight, its scarf tail hanging back down.
    const stopped = poseAt(restPose(), 0, 1, 0, true, 0, 0, -30);
    expect(stopped.lean).toBe(0);
    expect(stopped.hipsZ).toBe(0);
    expect(stopped.scarf).toBeLessThan(starting.scarf);
  });

  test('turning on the spot, it steps from foot to foot as it comes round', () => {
    const lifted = new Set<string>();
    for (let heading = 0; heading < Math.PI / 2; heading += 0.05) {
      applyPose(character, poseAt(restPose(), 0, 0, 0.5, true, 4, 0, 0, heading));
      if (lowest('L') > 0.04) lifted.add('L');
      if (lowest('R') > 0.04) lifted.add('R');
      expect(Math.min(lowest('L'), lowest('R'))).toBeLessThan(2e-3);
    }
    expect([...lifted].toSorted()).toEqual(['L', 'R']);
    applyPose(character, poseAt(restPose(), 0, 0, 0.5, true, 0, 0, 0, 1));
    expect(Math.max(lowest('L'), lowest('R'))).toBeLessThan(2e-3);
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
});

const end = (root: number, joint: number, a: number, b: number) => ({
  z: -a * Math.sin(root) - b * Math.sin(root + joint),
  y: -a * Math.cos(root) - b * Math.cos(root + joint),
});

describe('limbIK', () => {
  const limb = { root: 0, joint: 0 };

  test('puts the end of the limb on any target in reach, a knee bent forward', () => {
    for (const [z, y] of [
      [0, -0.72],
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
