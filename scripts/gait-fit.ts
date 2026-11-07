/**
 * Fits the walker's gait to harmonics for the traffic's figures: samples `poseAt` over a cycle
 * and prints each joint as its mean and three cosine and sine pairs, which `GAIT` in src/scene/vehicles.ts
 * carries (the thigh, knee and foot; the arms and hips are read off the ranges printed too).
 * Run it again after changing the gait, and paste the numbers. The pedalling (`GAIT.ride`) was
 * fitted the same way to the rider's pose, which went with the chase camera's riding: it stays
 * as data.
 *
 *   bun scripts/gait-fit.ts
 */
import { poseAt, restPose } from '../src/scene/character.ts';
import { WALK_SPEED } from '../src/scene/walker.ts';
const N = 64;
function fit(samples: number[], harmonics: number) {
  const out: number[] = [];
  let a0 = 0;
  for (const v of samples) a0 += v;
  out.push(a0 / N);
  for (let k = 1; k <= harmonics; k++) {
    let a = 0,
      b = 0;
    samples.forEach((v, i) => {
      const t = (2 * Math.PI * i) / N;
      a += v * Math.cos(k * t);
      b += v * Math.sin(k * t);
    });
    out.push((2 * a) / N, (2 * b) / N);
  }
  return out.map((x) => +x.toFixed(3));
}
const keys = [
  'hips',
  'hipsZ',
  'legL',
  'kneeL',
  'footL',
  'armL',
  'elbowL',
  'lean',
  'twist',
  'roll',
  'nod',
] as const;
for (const [name, sample] of [
  [
    'walk',
    (t: number) => {
      const p = restPose();
      return poseAt(p, WALK_SPEED, t, 10, false);
    },
  ],
] as const) {
  console.log('==', name);
  const series: Record<string, number[]> = {};
  for (let i = 0; i < N; i++) {
    const pose = sample((2 * Math.PI * i) / N);
    for (const k of keys) (series[k] ??= []).push(pose[k]);
  }
  for (const k of keys)
    console.log(
      k.padEnd(7),
      JSON.stringify(fit(series[k]!, 3)),
      'range',
      Math.min(...series[k]!).toFixed(3),
      Math.max(...series[k]!).toFixed(3),
    );
  const p = sample(0);
  console.log(
    'spread',
    p.spreadL,
    'splay',
    p.splayL,
    'armR',
    p.armR,
    'elbowR',
    p.elbowR,
    'legR',
    p.legR,
    'kneeR',
    p.kneeR,
  );
  // Is the right leg the left shifted by half a cycle?
  const a = sample(0),
    b = sample(Math.PI);
  console.log(
    'legL(0)',
    a.legL.toFixed(3),
    'legR(pi)',
    b.legR.toFixed(3),
    'kneeL(0)',
    a.kneeL.toFixed(3),
    'kneeR(pi)',
    b.kneeR.toFixed(3),
    'armL(0)',
    a.armL.toFixed(3),
    'armR(pi)',
    b.armR.toFixed(3),
  );
}
