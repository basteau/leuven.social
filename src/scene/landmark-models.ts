import type { LandmarkModel, Part } from './landmarks.ts';
import { LANDMARK } from './palette.ts';

/**
 * The hand-fitted hero landmarks, keyed by GRB building id (OIDN). Coordinates are in each
 * footprint's own frame (see landmarks.ts) and heights in metres, read off the DHMV II LiDAR.
 * Parts that form an outer wall stick out ~0.4 m past the footprint, so the base extrusion
 * hides behind them instead of z-fighting.
 */

/** A row of small gabled dormers on one slope of a hall whose ridge runs along v. */
function dormers(u: number, vs: readonly number[], eave: number): Part[] {
  return vs.map((v) => ({
    type: 'hall',
    u,
    v,
    length: 1.6,
    width: 0.7,
    from: eave - 4,
    eave,
    ridge: eave + 1,
  }));
}

/** Stadhuis: the Gothic hall on Grote Markt, a steep roof, four corner and two gable turrets. */
const STADHUIS: LandmarkModel = {
  base: 17,
  wall: LANDMARK.sandstone,
  roof: LANDMARK.slate,
  windows: true,
  parts: [
    {
      type: 'hall',
      u: -24.1,
      v: 8.45,
      across: true,
      length: 18.3,
      width: 6.6,
      eave: 20,
      ridge: 33,
      windows: true,
    },
    ...dormers(-27.6, [-5, 0, 5, 10, 15, 20], 24),
    ...dormers(-20.6, [-5, 0, 5, 10, 15, 20], 24),
    ...dormers(-25.6, [-2.5, 2.5, 7.5, 12.5, 17.5], 28),
    ...dormers(-22.6, [-2.5, 2.5, 7.5, 12.5, 17.5], 28),
    ...[-30.7, -17.5].flatMap((u): Part[] =>
      [-9.85, 26.75].map((v) => ({
        type: 'spire',
        u,
        v,
        radius: 1.3,
        sides: 8,
        top: 23,
        tip: 31,
        roof: LANDMARK.spire,
      })),
    ),
    ...[-9.85, 26.75].map((v): Part => ({
      type: 'spire',
      u: -24.1,
      v,
      radius: 1.5,
      sides: 8,
      from: 18,
      top: 32,
      tip: 45,
      roof: LANDMARK.spire,
    })),
  ],
};

/** Sint-Pieterskerk: nave and apsed choir, transept, a flèche over the crossing, the west work. */
const SINT_PIETERSKERK: LandmarkModel = {
  base: 13.5,
  wall: LANDMARK.limestone,
  roof: LANDMARK.slate,
  windows: false,
  parts: [
    {
      type: 'hall',
      u: -3.5,
      v: -0.5,
      length: 36.5,
      width: 6.2,
      eave: 22,
      ridge: 34,
      hips: [6.2, 0],
    },
    { type: 'hall', u: -3.05, v: 0, across: true, length: 23.4, width: 6.1, eave: 22, ridge: 34 },
    {
      type: 'spire',
      u: -3,
      v: -0.5,
      radius: 1.6,
      sides: 8,
      from: 30,
      top: 37,
      tip: 50,
      roof: LANDMARK.spire,
    },
    // The west tower was never finished: a broad stone block with a squat middle stump.
    { type: 'hall', u: 41.05, v: 0.2, across: true, length: 21.8, width: 9.05, eave: 29 },
    { type: 'spire', u: 41, v: 0, radius: 11, sides: 4, top: 43, tip: 45 },
  ],
};

/** Universiteitsbibliotheek: the long brick front on Ladeuzeplein and its tall carillon tower. */
const UNIVERSITEITSBIBLIOTHEEK: LandmarkModel = {
  base: 17,
  wall: LANDMARK.brick,
  roof: LANDMARK.slate,
  windows: true,
  parts: [
    {
      type: 'hall',
      u: -0.2,
      v: -22.7,
      length: 35.8,
      width: 6.7,
      eave: 17,
      ridge: 26,
      windows: true,
    },
    { type: 'spire', u: 11.4, v: -10.6, radius: 6.65, sides: 4, top: 52, tip: 52 },
    {
      type: 'spire',
      u: 11.4,
      v: -10.6,
      radius: 5.1,
      sides: 4,
      from: 52,
      top: 63,
      tip: 63,
      wall: LANDMARK.trim,
    },
    // Corner pinnacles on the belfry give the tower its crown.
    ...[
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ].map(([a, b]): Part => ({
      type: 'spire',
      u: 11.4 + a! * 3.2,
      v: -10.6 + b! * 3.2,
      radius: 0.8,
      sides: 4,
      from: 63,
      top: 64.5,
      tip: 68,
      wall: LANDMARK.trim,
      roof: LANDMARK.spire,
    })),
    {
      type: 'spire',
      u: 11.4,
      v: -10.6,
      radius: 3.4,
      sides: 8,
      from: 63,
      top: 66,
      tip: 80,
      wall: LANDMARK.trim,
      roof: LANDMARK.spire,
    },
  ],
};

/** Arenbergkasteel: the main wing between two tall corner towers, a stair turret, low wings. */
const ARENBERGKASTEEL: LandmarkModel = {
  base: 9,
  wall: LANDMARK.limestone,
  roof: LANDMARK.slate,
  windows: true,
  parts: [
    {
      type: 'hall',
      u: 31,
      v: 0,
      across: true,
      length: 26.8,
      width: 4.4,
      eave: 15,
      ridge: 21,
      windows: true,
    },
    {
      type: 'hall',
      u: -4.85,
      v: 20.9,
      length: 31.85,
      width: 3.7,
      eave: 10,
      ridge: 14,
      windows: true,
    },
    {
      type: 'hall',
      u: -5.5,
      v: -28.7,
      length: 31.5,
      width: 5.5,
      eave: 11,
      ridge: 15,
      windows: true,
    },
    ...[30.5, -30.5].map((v): Part => ({
      type: 'spire',
      u: 31.6,
      v,
      radius: 6.1,
      sides: 4,
      top: 24,
      tip: 34,
      roof: LANDMARK.spire,
    })),
    { type: 'spire', u: 21.5, v: 8.5, radius: 3, sides: 8, top: 22, tip: 27, roof: LANDMARK.spire },
  ],
};

/** Abdij van Park: the abbey church, its nave and the west tower with a lantern on top. */
const ABDIJ_VAN_PARK: LandmarkModel = {
  base: 12,
  wall: LANDMARK.trim,
  roof: LANDMARK.slate,
  windows: false,
  parts: [
    { type: 'hall', u: -5.7, v: -0.2, length: 25.7, width: 4.9, eave: 14, ridge: 20, hips: [0, 0] },
    { type: 'spire', u: 25, v: -0.5, radius: 6.4, sides: 4, top: 36, tip: 36 },
    {
      type: 'spire',
      u: 25,
      v: -0.5,
      radius: 3.2,
      sides: 8,
      from: 36,
      top: 42,
      tip: 52,
      roof: LANDMARK.spire,
    },
  ],
};

/** Station Leuven: the 1879 hall on Martelarenplein, a gabled middle and two end pavilions. */
const STATION_LEUVEN: LandmarkModel = {
  base: 9,
  wall: LANDMARK.sandstone,
  roof: LANDMARK.slate,
  windows: true,
  parts: [
    {
      type: 'hall',
      u: 0.15,
      v: 0,
      across: true,
      length: 10.5,
      width: 11.3,
      eave: 15,
      ridge: 21,
      windows: true,
    },
    ...[-34.25, 34.3].map((u): Part => ({
      type: 'hall',
      u,
      v: 1.75,
      across: true,
      length: 8,
      width: 7.3,
      eave: 13,
      ridge: 17,
      hips: [3, 3],
      windows: true,
    })),
  ],
};

export const LANDMARK_MODELS: ReadonlyMap<number, LandmarkModel> = new Map([
  [2871416, STADHUIS],
  [2878488, SINT_PIETERSKERK],
  [2871417, UNIVERSITEITSBIBLIOTHEEK],
  [2883895, ARENBERGKASTEEL],
  [5536465, ABDIJ_VAN_PARK],
  [2870209, STATION_LEUVEN],
]);
