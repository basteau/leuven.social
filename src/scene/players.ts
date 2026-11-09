import { Vector3 } from 'three';
import type { Material, MeshBasicMaterial, OrthographicCamera, Scene } from 'three';

import { BIKE, FINE, INDOORS, STANDING, TRAVELLED_WRAP } from '../net/people.ts';
import type { People, Roster } from '../net/people.ts';
import type { Fade } from './character-material.ts';
import {
  CHARACTER_SCALE,
  applyPose,
  characterGeometry,
  createCharacter,
  poseAt,
} from './character.ts';
import type { Character, Outfit, Pose } from './character.ts';
import { createClumper } from './clumps.ts';
import { FEET_Y, createCrowdMesh } from './crowd-mesh.ts';
import type { CrowdMesh } from './crowd-mesh.ts';
import { createGait, nearestOf, stepGait } from './gait.ts';
import type { Gait, PlayerPose } from './gait.ts';
import {
  PEOPLE,
  PITCH,
  RIG_HOLD,
  RIG_LOSE,
  RIG_WIN,
  VIEW_HEIGHT,
  crowdFade,
  figureAlpha,
  figurePixels,
  inGround,
  markShare,
  markerAlpha,
  rigAlpha,
  wantsRig,
} from './lod.ts';
import type { GroundRect } from './lod.ts';
import { drawMarks } from './marks.ts';
import type { MarkFrame, MarkPen } from './marks.ts';
import { BIKES } from './palette.ts';
import { createTag, declutter, moveTag, nameTag, showTag } from './player-tags.ts';
import type { Tag } from './player-tags.ts';
import type { Riders } from './rider.ts';
import { STRIDE_RUN, STRIDE_WALK, runBlend } from './walker.ts';

/**
 * The other players, at every zoom: the same list of people (src/net/people.ts), read three ways,
 * and handed from one to the next as a function of how many pixels a figure takes, so that a zoom
 * is one reversible motion: close in, the 24 nearest in the walker's own full figure and with a
 * name; further out, one instanced figure each; furthest, a marker in the 2D layer over the map.
 * Where each is is the list's to know, moved on each frame a moment behind the network; this
 * layer knows nothing of sockets. Browser-only: the logic is in gait.ts, lod.ts and player-tags.ts.
 */

/** Where the view looks, and how far out it is, for one frame's handing out of who is what. */
export interface PlayersView {
  rect: GroundRect;
  /** The view's height on the ground, and the window's, CSS px. */
  span: number;
  width: number;
  height: number;
  /** Where the avatar is: '' the street, else a room and its floor. */
  place: string;
  floor: number;
}

/** How soon the next frame is worth drawing, for what's drawn of the others to look alive. */
export const IDLE = 0;
/** Nobody but the crowd moves: three frames in a 60 Hz one do. */
export const SLOW = 1;
/** Someone in a full figure moves. */
export const FAST = 2;
export type Cadence = typeof IDLE | typeof SLOW | typeof FAST;

export interface PlayersKit {
  scene: Scene;
  camera: OrthographicCamera;
  /** A full figure's toon material: its own number for how much of it to draw. */
  material(fade: Fade): Material;
  /** The same figure's silhouette where a house hides it, in their shirt. */
  xray(colour: number, fade: Fade): MeshBasicMaterial;
  /** The crowd's two materials, made the first time there is a crowd. */
  crowd(ink: { value: number }): { body: Material; xray: Material };
  /** Where the tags go: an element over the canvas, or none. */
  tags: HTMLElement | null;
  /** The 2D layer the markers are stamped on, over the canvas: or none. */
  marks: HTMLCanvasElement | null;
  reducedMotion: boolean;
  /** The ground as drawn under someone, or the floor of the room they're in (m); null: unseen. */
  floorAt(pose: PlayerPose): number | null;
  /** The bare ground under (x, z) (m), for a marker to stand at the height of the land. */
  groundAt(x: number, z: number): number;
  /** The riders, loaded the first time someone rides. */
  riders(): Promise<Riders>;
  /** At most this many instanced figures. */
  cap: number;
}

export interface Players {
  /** Hands over the list and its news, or none (signed out): everyone goes. */
  use(roster: Roster | null): void;
  /** The list being drawn, for the minimap and the full map. */
  people(): People | null;
  /** Moves the full figures' legs `dt` seconds on; says how soon another frame is worth it. */
  step(dt: number): Cadence;
  /** How soon another frame is worth it, from what the last frame drew. */
  pace(): Cadence;
  /** What this frame draws of each person: figures, crowd, tags, markers. */
  place(view: PlayersView): void;
  /** The list said something changed: how soon a frame is worth it. Markers look after themselves. */
  news(view: PlayersView): Cadence;
  /** How many people are drawn in any way, and the draw calls they take. */
  readonly drawn: number;
  readonly calls: number;
  dispose(): void;
}

/** The pool of full figures: more nearest than this wear the crowd's. */
const MOST = RIG_WIN;
/** How many figures may be dressed in a frame: making geometry takes a while. */
const SWAPS_PER_FRAME = 2;
/** How long one way of drawing someone takes to give way to another, or a door to take them (ms). */
const SWAP_MS = 200;
/** The most one frame moves an ease on (ms): a frame after a long quiet is a frame, not a second. */
const LONGEST_STEP_MS = 50;
/** Their tag sits this far over their feet (m): just over the head, drawn 1.3× life. */
const OVER_HEAD = 2.75;
/** Idle long enough, a figure stands still and needs no more frames (s; the walker's IDLE_SECONDS). */
const IDLE_LIMIT = 7;
/** After the riders failed to load, they are asked for again no sooner than this (ms). */
const RIDERS_RETRY_MS = 30_000;
/** How wide an instanced figure's ink stays, however far out (CSS px). */
const INK_PX = 0.75;
/** How often the markers are stamped again with nobody drawing the map (ms). */
const MARKS_MS = 250;
/** How soon they are stamped again while a clump is forming or dissolving (ms). */
const SETTLING_MS = 60;
/** Moved less than this (m), the height under someone is as last found. */
const SAME_SPOT = 1;
const TAU = Math.PI * 2;
/** The ring of distance from the middle of the view over the cap goes in this many steps. */
const CAP_BUCKETS = 64;
/** How far up a figure, as a share of its height, a marker sits. */
const MARK_AT_BODY = 0.55;

/** One of the pool of full figures and tags, worn by whoever is nearest. */
interface Rig {
  character: Character;
  xray: MeshBasicMaterial;
  fade: Fade;
  pose: Pose;
  gait: Gait;
  at: PlayerPose;
  tag: Tag | null;
  /** Whose it is, or -1 for no one's. */
  owner: number;
  /** How much of them is in this figure, 0 to 1: eased as the figure's taken up or given back. */
  weight: number;
  /** Whether this rig is staying with its owner, not yet on its way back to the pool. */
  wanted: boolean;
  /** When its owner got it (ms). */
  since: number;
  /** Whom it is dressed as now. */
  outfit: Outfit;
  name: string;
  /** Where its tag goes this frame, if it's on screen at all. */
  tagX: number;
  tagY: number;
  tagReady: boolean;
}

function fillPose(p: People, s: number, out: PlayerPose): void {
  out.x = p.x[s]!;
  out.z = p.z[s]!;
  out.heading = p.heading[s]!;
  out.speed = p.speed[s]!;
  out.mode = p.flags[s]! & BIKE ? 'bike' : 'foot';
  const indoors = (p.flags[s]! & INDOORS) !== 0;
  out.place = indoors ? p.place(s) : '';
  out.floor = p.floor(s);
}

function ease(value: number, target: number, dtMs: number): number {
  const step = dtMs / SWAP_MS;
  return value < target ? Math.min(target, value + step) : Math.max(target, value - step);
}

export function createPlayers(kit: PlayersKit): Players {
  const { scene, camera } = kit;
  const reduce = kit.reducedMotion;
  let people: People | null = null;
  let version = -1;
  const rigs: Rig[] = [];
  let riders: Riders | undefined;
  let loadingRiders = false;
  let ridersRetry = 0;
  /** Who each riders' instance is dressed as, so a slot is dressed only when its rider changes. */
  const riderIds: number[] = [];
  const riderLooks: (Outfit | undefined)[] = [];
  const clumper = createClumper();
  let crowd: CrowdMesh | null = null;
  const crowdInk = { value: 0 };
  let drawn = 0;
  let rode = 0;
  let rigged = 0;
  let crowded = 0;
  /** What the crowd asked for last frame: whether it needs another. */
  let crowdMoved = false;
  let lastPlaced = Number.NaN;
  let lastView: PlayersView | null = null;
  /** How much of a full figure shows at last frame's zoom, for whether easing is worth a frame. */
  let lastRigAlpha = 0;
  /** Whether last frame drew any marker, so news is worth stamping them again. */
  let marksWanted = false;
  let marksTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let markPen: (MarkPen & CanvasRenderingContext2D) | null = null;
  let marksDrawn = false;
  /** A nearest person still waits for a figure: the next frame can dress two more. */
  let fitting = false;
  let swapsLeft = 0;

  // Per slot, kept in step with the list's own numbering by `seen` and `follow`.
  let seen = new Int32Array(0);
  /** How many slots `seen` knows of. */
  let known = 0;
  const lastSlot = new Map<number, number>();
  let cacheX = new Float32Array(0);
  let cacheZ = new Float32Array(0);
  let cacheY = new Float32Array(0);
  let phase = new Float32Array(0);
  let walked = new Float32Array(0);
  /** 1 while someone fits under the crowd's cap, 0 when they fall to a marker: eased, to dither. */
  let figure = new Float32Array(0);
  /** 1 while someone is on the view's floor, 0 in another room: eased, for a door to dither. */
  let door = new Float32Array(0);
  /** Whether a door has them, this frame: they're drawn fading where they went in, not where they are. */
  let gone = new Uint8Array(0);
  /** Where someone was last drawn on the view's own floor (m), for the one going through a door. */
  let placedX = new Float32Array(0);
  let placedZ = new Float32Array(0);
  /** Whether someone was in view last frame, for news of them leaving it. */
  let shownHere = new Uint8Array(0);
  /** Which rig, +1, this frame; 0 for none. */
  let rigAt = new Uint8Array(0);
  /** How much of each is drawn as a full figure this frame, 0 to 1. */
  let rigShown = new Float32Array(0);
  /** Who a marker should stand for this frame, as the clumper reads it. */
  let markAlpha = new Float32Array(0);
  // Reused every frame: the loops over people allocate nothing, whoever is in them.
  let here = new Int32Array(0);
  let candidates = new Int32Array(0);
  let points = new Float32Array(0);
  const nearest: number[] = [];
  const buckets = new Uint32Array(CAP_BUCKETS);
  const tagOrder: number[] = [];
  const tagBoxes = new Float32Array(RIG_LOSE * 4);
  const tagKeep = new Uint8Array(RIG_LOSE);
  const head = new Vector3();
  const scratchPose: PlayerPose = {
    x: 0,
    z: 0,
    heading: 0,
    speed: 0,
    mode: 'foot',
    place: '',
    floor: 0,
  };
  const markFrame: MarkFrame & { lift: (x: number, z: number) => number } = {
    a: 0,
    b: 0,
    c: 0,
    d: 0,
    e: 0,
    f: 0,
    lift: () => 0,
  };

  function ensure(length: number): void {
    if (seen.length >= length) return;
    const size = Math.max(length, 64);
    const had = seen.length;
    const widen = <T extends Float32Array | Int32Array | Uint8Array>(a: T, n = size): T => {
      const next = new (a.constructor as new (n: number) => T)(n);
      next.set(a);
      return next;
    };
    seen = widen(seen);
    seen.fill(-1, had);
    cacheX = widen(cacheX);
    cacheZ = widen(cacheZ);
    cacheY = widen(cacheY);
    phase = widen(phase);
    walked = widen(walked);
    figure = widen(figure);
    door = widen(door);
    gone = widen(gone);
    placedX = widen(placedX);
    placedZ = widen(placedZ);
    shownHere = widen(shownHere);
    rigAt = widen(rigAt);
    rigShown = widen(rigShown);
    markAlpha = widen(markAlpha);
    here = new Int32Array(size);
    candidates = new Int32Array(size);
    points = new Float32Array(size * 2);
  }

  /** Someone new in slot `s`: nothing they had before. */
  function resetSlot(p: People, s: number): void {
    cacheY[s] = Number.NaN;
    phase[s] = (p.travelled[s]! / STRIDE_WALK) * TAU;
    walked[s] = p.travelled[s]!;
    figure[s] = 1;
    // Worked out on their first frame: a door is for someone who goes through one in sight.
    door[s] = -1;
    gone[s] = 0;
    rigAt[s] = 0;
    rigShown[s] = 0;
    placedX[s] = p.x[s]!;
    placedZ[s] = p.z[s]!;
    shownHere[s] = 0;
  }

  /** Someone moved from slot `from` to `s`: what was theirs goes with them. */
  function moveSlot(from: number, s: number): void {
    cacheX[s] = cacheX[from]!;
    cacheZ[s] = cacheZ[from]!;
    cacheY[s] = cacheY[from]!;
    phase[s] = phase[from]!;
    walked[s] = walked[from]!;
    figure[s] = figure[from]!;
    door[s] = door[from]!;
    gone[s] = gone[from]!;
    rigAt[s] = rigAt[from]!;
    rigShown[s] = rigShown[from]!;
    placedX[s] = placedX[from]!;
    placedZ[s] = placedZ[from]!;
    shownHere[s] = shownHere[from]!;
  }

  /**
   * Keeps what's per person with the person, as the list packs its slots. Leaving moves the last
   * slot down into the gap, so a slot's only ever taken from one higher: read from the lowest up,
   * nothing is overwritten before it has been read.
   */
  function follow(p: People): void {
    ensure(p.count);
    const { ids, count } = p;
    let same = known === count;
    for (let s = 0; same && s < count; s++) same = seen[s] === ids[s];
    if (same) return;
    lastSlot.clear();
    for (let s = 0; s < known; s++) lastSlot.set(seen[s]!, s);
    for (let s = 0; s < count; s++) {
      if (seen[s] === ids[s]) continue;
      const from = lastSlot.get(ids[s]!) ?? -1;
      seen[s] = ids[s]!;
      if (from > s) moveSlot(from, s);
      else resetSlot(p, s);
    }
    seen.fill(-1, count, Math.max(count, known));
    known = count;
  }

  const dressed = (rig: Rig, outfit: Outfit, shirt: number) => {
    const geometry = characterGeometry(outfit);
    rig.character.mesh.geometry.dispose();
    rig.character.mesh.geometry = geometry;
    rig.character.xray.geometry = geometry;
    rig.xray.color.setHex(shirt);
    rig.outfit = outfit;
  };

  function newRig(outfit: Outfit, name: string): Rig {
    // Everyone's own number: the crossfades are each person's own, not the figures' all at once.
    const fade: Fade = { value: 0 };
    const xray = kit.xray(outfit.shirt, fade);
    const character = createCharacter(kit.material(fade), xray, outfit);
    character.mesh.scale.setScalar(CHARACTER_SCALE);
    character.mesh.visible = false;
    scene.add(character.mesh);
    const rig: Rig = {
      character,
      xray,
      fade,
      pose: {} as Pose,
      gait: createGait(),
      at: { ...scratchPose },
      tag: kit.tags ? createTag(kit.tags, outfit.shirt) : null,
      owner: -1,
      weight: 0,
      wanted: false,
      since: 0,
      outfit,
      name,
      tagX: 0,
      tagY: 0,
      tagReady: false,
    };
    if (rig.tag) nameTag(rig.tag, name, outfit.shirt);
    rigs.push(rig);
    return rig;
  }

  function removeRig(rig: Rig): void {
    scene.remove(rig.character.mesh);
    // Each skinned mesh holds its bones in a texture on the GPU.
    rig.character.mesh.skeleton.dispose();
    rig.character.mesh.geometry.dispose();
    (rig.character.mesh.material as Material).dispose();
    rig.xray.dispose();
    rig.tag?.el.remove();
  }

  /** Back to the pool: whoever wore it is whoever's next. */
  function free(rig: Rig): void {
    rig.owner = -1;
    rig.weight = 0;
    rig.wanted = false;
    rig.character.mesh.visible = false;
    if (rig.tag) showTag(rig.tag, 0, 0);
  }

  /** Puts `s` in a free figure, if the frame can afford dressing it. */
  function fit(p: People, s: number, now: number): void {
    const who = p.who(s);
    if (!who) return;
    let rig = rigs.find((r) => r.owner === -1 && r.outfit === who.outfit);
    if (!rig) {
      if (swapsLeft === 0) return;
      swapsLeft--;
      rig = rigs.find((r) => r.owner === -1);
      if (rig) dressed(rig, who.outfit, who.outfit.shirt);
      else if (rigs.length < MOST) rig = newRig(who.outfit, who.name);
      else return;
    }
    rig.owner = who.id;
    rig.since = now;
    rig.wanted = true;
    rig.weight = 0;
    if (rig.tag) nameTag(rig.tag, who.name, who.outfit.shirt);
    rig.name = who.name;
    // Taken up mid-stride: its legs start from here, not from a stand it never took.
    const g = rig.gait;
    g.heading = p.heading[s]!;
    g.phase = (p.travelled[s]! / STRIDE_WALK) * TAU;
    g.still = 0;
    rigAt[s] = rigs.indexOf(rig) + 1;
  }

  /** Whether every figure there is has someone in it. */
  function allWorn(): boolean {
    for (const rig of rigs) if (rig.owner === -1) return false;
    return true;
  }

  /** With the pool full, the figure furthest down the nearest gives way, if it's had its turn. */
  function makeRoomFor(now: number): void {
    let worst = -1;
    let at = RIG_WIN;
    for (let i = 0; i < rigs.length; i++) {
      const rig = rigs[i]!;
      if (rig.owner === -1 || !rig.wanted || now - rig.since < RIG_HOLD) continue;
      const rank = rigRank[i]!;
      const r = rank === 0 ? RIG_LOSE + 1 : rank;
      if (r > at) [at, worst] = [r, i];
    }
    if (worst >= 0) rigs[worst]!.wanted = false;
  }
  const rigRank = new Int32Array(MOST);

  function loadRiders(): void {
    if (loadingRiders || performance.now() < ridersRetry) return;
    loadingRiders = true;
    kit.riders().then(
      (loaded) => (riders = loaded),
      () => {
        // Tried again when someone next rides, a while from now (a deploy took the chunk away).
        loadingRiders = false;
        ridersRetry = performance.now() + RIDERS_RETRY_MS;
      },
    );
  }

  /** The drawn ground under `s`, looked up afresh only as they move by a metre. */
  function heightOf(p: People, s: number): number | null {
    const x = p.x[s]!;
    const z = p.z[s]!;
    if (Number.isNaN(cacheY[s]!) || Math.hypot(x - cacheX[s]!, z - cacheZ[s]!) >= SAME_SPOT) {
      fillPose(p, s, scratchPose);
      const y = kit.floorAt(scratchPose);
      if (y === null) {
        cacheY[s] = Number.NaN;
        return null;
      }
      cacheX[s] = x;
      cacheZ[s] = z;
      cacheY[s] = y;
    }
    return cacheY[s]!;
  }

  const isHere = (p: People, s: number, view: PlayersView) =>
    !(p.flags[s]! & INDOORS) || (p.place(s) === view.place && p.floor(s) === view.floor);

  /** The rig's owner's person, in `at`, and the frame's share of them; `at` stays put at a door. */
  function placeRig(
    p: People,
    s: number,
    rig: Rig,
    shown: number,
    width: number,
    height: number,
  ): void {
    rig.fade.value = shown;
    if (!gone[s]) fillPose(p, s, rig.at);
    rig.tagReady = false;
    const y = kit.floorAt(rig.at);
    if (y === null) {
      rig.character.mesh.visible = false;
      if (rig.tag) showTag(rig.tag, 0, 0);
      return;
    }
    const onFoot = rig.at.mode === 'foot';
    rig.character.mesh.visible = onFoot;
    if (rig.tag) {
      head.set(rig.at.x, y + OVER_HEAD, rig.at.z).project(camera);
      const [tx, ty] = [((head.x + 1) / 2) * width, ((1 - head.y) / 2) * height];
      const off = tx < -50 || ty < -20 || tx > width + 50 || ty > height + 50;
      if (off) showTag(rig.tag, 0, 0);
      else [rig.tagX, rig.tagY, rig.tagReady] = [tx, ty, true];
    }
    if (!onFoot) {
      if (riders) {
        const who = p.who(s);
        if (riderIds[rode] !== rig.owner || riderLooks[rode] !== who?.outfit) {
          riderIds[rode] = rig.owner;
          riderLooks[rode] = who?.outfit;
          if (who) {
            // Each on a bike of a colour of their own, as the racks hold them.
            riders.dress(rode, { ...who.outfit, frame: BIKES[who.id % BIKES.length]! });
          }
        }
        riders.pose(rode, {
          x: rig.at.x,
          y,
          z: rig.at.z,
          heading: rig.at.heading,
          lean: rig.gait.lean,
          pedal: rig.gait.phase,
          braking: false,
          fade: shown,
        });
        rode++;
      } else loadRiders();
      return;
    }
    rigged++;
    const g = rig.gait;
    applyPose(
      rig.character,
      poseAt(rig.pose, rig.at.speed, g.phase, g.still, !reduce, g.turning, 0, 0, rig.at.heading),
    );
    rig.character.mesh.position.set(rig.at.x, y + FEET_Y, rig.at.z);
    rig.character.mesh.rotation.y = rig.at.heading;
  }

  function hideAll(): void {
    for (const rig of rigs) free(rig);
    [drawn, rode, rigged, crowded] = [0, 0, 0, 0];
    if (riders) riders.count = 0;
    crowd?.finish(0, 0);
    crowdMoved = false;
    fitting = false;
  }

  /** The layer's size on screen, and its buffer's, as the window is. */
  function fitMarks(view: PlayersView): { dpr: number; cleared: boolean } {
    const c = kit.marks!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const [w, h] = [Math.round(view.width * dpr), Math.round(view.height * dpr)];
    let cleared = false;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      cleared = true;
    }
    markPen ??= c.getContext('2d') as CanvasRenderingContext2D;
    return { dpr, cleared };
  }

  /**
   * Stamps the markers: whoever's too small for anything better, and those a cap in the street
   * left without a figure. Over the map, the map is not asked to redraw for any of it.
   */
  function paintMarks(p: People, view: PlayersView, alpha: Float32Array | undefined): boolean {
    if (!kit.marks) return false;
    const { dpr, cleared } = fitMarks(view);
    const pen = markPen!;
    if (marksDrawn && !cleared) pen.clearRect(0, 0, kit.marks.width, kit.marks.height);
    marksDrawn = false;
    const { rect } = view;
    const [hw, hd] = [rect.halfWidth, rect.halfDepth];
    const dx = Math.abs(rect.rightX) * hw + Math.abs(rect.rightZ) * hd;
    const dz = Math.abs(rect.rightZ) * hw + Math.abs(rect.rightX) * hd;
    const pxPerMetre = view.height / view.span;
    const marks = clumper.clump(p, {
      pxPerMetre,
      x0: rect.x - dx,
      z0: rect.z - dz,
      x1: rect.x + dx,
      z1: rect.z + dz,
      place: view.place,
      floor: view.floor,
      ...(alpha && { alpha }),
    });
    if (marks.count === 0) return marks.settling;
    // Where a metre of ground at the height of the view's middle goes on screen, by the camera.
    camera.updateMatrixWorld();
    const ty = kit.groundAt(rect.x, rect.z);
    const project = (x: number, z: number): [number, number] => {
      head.set(x, ty, z).project(camera);
      return [((head.x + 1) / 2) * view.width, ((1 - head.y) / 2) * view.height];
    };
    const [ox, oy] = project(rect.x, rect.z);
    const [xx, xy] = project(rect.x + 1, rect.z);
    const [zx, zy] = project(rect.x, rect.z + 1);
    const f = markFrame;
    [f.a, f.b, f.c, f.d] = [xx - ox, xy - oy, zx - ox, zy - oy];
    f.e = ox - f.a * rect.x - f.c * rect.z;
    f.f = oy - f.b * rect.x - f.d * rect.z;
    const upright = Math.cos(PITCH) * pxPerMetre;
    // Where the middle of a figure would be, so a marker takes over where the eye already is.
    const body = pixelsOf(view) * MARK_AT_BODY;
    f.lift = (x, z) => (kit.groundAt(x, z) - ty) * upright + body;
    pen.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawMarks(pen, marks, f, dpr);
    marksDrawn = marks.count > 0;
    return marks.settling;
  }

  /** The markers over again, with nobody drawing the map: a walk across a far view's few pixels. */
  function repaintMarks(): void {
    marksTimer = 0;
    if (!people || !lastView || !kit.marks) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const p = people;
    const view = lastView;
    const busy = p.sample(performance.now());
    if (p.count === 0 && !marksDrawn) return;
    const alpha = refreshMarkAlpha(p, view);
    const settling = paintMarks(p, view, alpha);
    if (busy || settling) scheduleMarks(settling ? SETTLING_MS : MARKS_MS);
  }

  function scheduleMarks(delay = MARKS_MS): void {
    if (marksTimer || !kit.marks) return;
    marksTimer = setTimeout(repaintMarks, delay);
  }

  /** What each person's marker is worth just now, for a repaint without a frame in it. */
  function refreshMarkAlpha(p: People, view: PlayersView): Float32Array | undefined {
    const P = pixelsOf(view);
    if (P < PEOPLE.figureGone) return undefined;
    const markers = markerAlpha(P);
    follow(p);
    for (let s = 0; s < p.count; s++) {
      // Seen for the first time in between frames: nothing yet of a door or a figure.
      const through = door[s]! < 0 ? 1 : door[s]!;
      markAlpha[s] = markShare(rigShown[s]!, figure[s]!, markers) * through;
    }
    return markAlpha;
  }

  const pixelsOf = (view: PlayersView) => figurePixels(view.height, VIEW_HEIGHT / view.span);

  function pace(): Cadence {
    if (!people) return IDLE;
    if (fitting) return FAST;
    for (const rig of rigs) {
      if (rig.owner === -1) continue;
      if (lastRigAlpha > 0 && rig.weight !== (rig.wanted ? 1 : 0)) return FAST;
      if (rig.fade.value <= 0) continue;
      if (rig.at.speed > STANDING || rig.gait.still < IDLE_LIMIT) return FAST;
    }
    return crowdMoved ? SLOW : IDLE;
  }

  return {
    get drawn() {
      return drawn;
    },
    get calls() {
      return rigged * 2 + (rode ? 3 : 0) + (crowded ? 2 : 0);
    },
    people: () => people,
    use(next) {
      people = next?.people ?? null;
      version = -1;
      lastPlaced = Number.NaN;
      lastView = null;
      seen.fill(-1);
      known = 0;
      hideAll();
      clearTimeout(marksTimer as ReturnType<typeof setTimeout>);
      marksTimer = 0;
      if (kit.marks && markPen && marksDrawn) {
        markPen.clearRect(0, 0, kit.marks.width, kit.marks.height);
      }
      marksDrawn = false;
      riderIds.length = 0;
      riderLooks.length = 0;
    },
    step(dt) {
      if (!people) return IDLE;
      const p = people;
      for (let i = 0; i < rigs.length; i++) {
        const rig = rigs[i]!;
        if (rig.owner === -1) continue;
        const s = p.slotOf(rig.owner);
        // At a door they're drawn where they went in, not yet where the list says.
        if (s < 0 || (lastView && !isHere(p, s, lastView))) continue;
        fillPose(p, s, rig.at);
        stepGait(rig.gait, rig.at, dt);
      }
      return pace();
    },
    pace,
    news(view) {
      if (!people) return IDLE;
      const p = people;
      // Where everyone is now, not at the last frame drawn: nothing else may have sampled since,
      // and someone who left or went through a door isn't in the version.
      p.sample(performance.now());
      follow(p);
      // Whoever's a marker is the markers' to look after: that's the overlay's timer, not a frame.
      if (marksWanted) scheduleMarks();
      const P = pixelsOf(view);
      if (P < PEOPLE.figureGone) return IDLE;
      if (p.version !== version) return SLOW;
      let moving = false;
      for (let s = 0; s < p.count; s++) {
        const inView = inGround(view.rect, p.x[s]!, p.z[s]!) && isHere(p, s, view);
        const was = shownHere[s] === 1;
        if (!inView && !was) continue;
        // Standing, whole and where they were drawn: nothing for a frame to say about them.
        const stood = p.speed[s]! <= STANDING && p.x[s] === placedX[s] && p.z[s] === placedZ[s];
        if (inView === was && stood && p.fade[s] === 1) continue;
        moving = true;
        if (rigAt[s] && P >= PEOPLE.rigGone) return FAST;
      }
      return moving ? SLOW : IDLE;
    },
    place(view) {
      lastView = view;
      const p = people;
      if (!p) return;
      const now = performance.now();
      p.sample(now);
      const dtMs = Number.isNaN(lastPlaced) ? 1000 : Math.min(LONGEST_STEP_MS, now - lastPlaced);
      lastPlaced = now;
      const P = pixelsOf(view);
      version = p.version;
      follow(p);
      const rigsAlpha = rigAlpha(P);
      const figures = figureAlpha(P);
      const markers = markerAlpha(P);
      const { x, z, flags } = p;
      const rect = view.rect;
      // Who's here to be drawn. Nothing but a list of slots: this is every frame, for everybody.
      let nHere = 0;
      for (let s = 0; s < p.count; s++) {
        rigAt[s] = 0;
        rigShown[s] = 0;
        const isIn = isHere(p, s, view);
        door[s] = door[s]! < 0 ? (isIn ? 1 : 0) : ease(door[s]!, isIn ? 1 : 0, dtMs);
        gone[s] = !isIn && door[s]! > 0 ? 1 : 0;
        const inView = isIn && inGround(rect, x[s]!, z[s]!);
        shownHere[s] = inView ? 1 : 0;
        if (isIn) {
          placedX[s] = x[s]!;
          placedZ[s] = z[s]!;
        }
        if (inView || gone[s]) here[nHere++] = s;
      }

      lastRigAlpha = rigsAlpha;
      fitting = false;
      if (P < PEOPLE.figureGone) {
        if (rigs.some((r) => r.owner !== -1)) for (const rig of rigs) free(rig);
        if (riders) riders.count = 0;
        crowd?.finish(0, 0);
        [drawn, rode, rigged, crowded] = [nHere, 0, 0, 0];
        crowdMoved = false;
        marksWanted = true;
        if (paintMarks(p, view, undefined)) scheduleMarks(SETTLING_MS);
        return;
      }

      // Those heard of in full, nearest the view first: who wears a figure.
      let nCandidates = 0;
      const wantRigs = P >= PEOPLE.rigGone - 0.5;
      if (wantRigs) {
        for (let i = 0; i < nHere; i++) {
          const s = here[i]!;
          if (!(flags[s]! & FINE) || gone[s]) continue;
          candidates[nCandidates] = s;
          points[nCandidates * 2] = x[s]!;
          points[nCandidates * 2 + 1] = z[s]!;
          nCandidates++;
        }
      }
      nearestOf(points, nCandidates, rect.x, rect.z, RIG_LOSE, nearest);
      for (let i = 0; i < rigs.length; i++) rigRank[i] = 0;
      // Who keeps a figure, by their rank among the nearest; gone from the list, it's free.
      for (let i = 0; i < rigs.length; i++) {
        const rig = rigs[i]!;
        if (rig.owner === -1) continue;
        const s = p.slotOf(rig.owner);
        if (s < 0 || !(flags[s]! & FINE)) {
          free(rig);
          continue;
        }
        rigAt[s] = i + 1;
      }
      for (let r = 0; r < nearest.length; r++) {
        const s = candidates[nearest[r]!]!;
        const at = rigAt[s]!;
        if (at) rigRank[at - 1] = r + 1;
      }
      for (let i = 0; i < rigs.length; i++) {
        const rig = rigs[i]!;
        if (rig.owner === -1) continue;
        rig.wanted = wantRigs && wantsRig(rigRank[i]!, true, now - rig.since);
      }
      // The nearest 24 get a figure, as there's room: the crowd has them till then.
      swapsLeft = SWAPS_PER_FRAME;
      const tops = Math.min(RIG_WIN, nearest.length);
      for (let r = 0; r < tops; r++) {
        const s = candidates[nearest[r]!]!;
        if (rigAt[s]) continue;
        if (allWorn()) makeRoomFor(now);
        fit(p, s, now);
        if (!rigAt[s] && rigsAlpha > 0) fitting = true;
      }

      // Eased, and drawn: the rigs first, so the crowd knows what is left to it.
      rode = 0;
      rigged = 0;
      for (let i = 0; i < rigs.length; i++) {
        const rig = rigs[i]!;
        if (rig.owner === -1) continue;
        // Nobody can see a figure at this zoom, so there's nothing to ease.
        rig.weight =
          rigsAlpha > 0 ? ease(rig.weight, rig.wanted ? 1 : 0, dtMs) : rig.wanted ? 1 : 0;
        if (rig.weight === 0 && !rig.wanted) {
          free(rig);
          continue;
        }
        const s = p.slotOf(rig.owner);
        if (s < 0) continue;
        rigAt[s] = i + 1;
        const who = p.who(s);
        if (who) {
          if (rig.outfit !== who.outfit && swapsLeft > 0) {
            swapsLeft--;
            dressed(rig, who.outfit, who.outfit.shirt);
            if (rig.tag) nameTag(rig.tag, who.name, who.outfit.shirt);
          }
          if (rig.name !== who.name) {
            rig.name = who.name;
            if (rig.tag) nameTag(rig.tag, who.name, who.outfit.shirt);
          }
        }
        const part = rig.weight * rigsAlpha;
        rigShown[s] = part;
        const shown = part * p.fade[s]! * door[s]!;
        if (shown <= 0) {
          rig.character.mesh.visible = false;
          rig.tagReady = false;
          if (rig.tag) showTag(rig.tag, 0, 0);
          continue;
        }
        placeRig(p, s, rig, shown, view.width, view.height);
      }
      if (riders) riders.count = rode;

      // The tags, by rank: the nearest first, as many as have room.
      let tagCount = 0;
      for (let r = 0; r < nearest.length; r++) {
        const at = rigAt[candidates[nearest[r]!]!]!;
        if (!at) continue;
        const rig = rigs[at - 1]!;
        if (!rig.tag) continue;
        if (!rig.tagReady) {
          showTag(rig.tag, 0, 0);
          continue;
        }
        tagOrder[tagCount] = at - 1;
        tagBoxes[tagCount * 4] = rig.tagX;
        tagBoxes[tagCount * 4 + 1] = rig.tagY;
        tagBoxes[tagCount * 4 + 2] = rig.tag.width;
        tagBoxes[tagCount * 4 + 3] = rig.tag.height;
        tagCount++;
      }
      declutter(tagBoxes, tagCount, tagKeep);
      for (let i = 0; i < tagCount; i++) {
        const rig = rigs[tagOrder[i]!]!;
        moveTag(rig.tag!, tagBoxes[i * 4]!, tagBoxes[i * 4 + 1]!);
        showTag(rig.tag!, tagKeep[i] ? rig.fade.value : 0, RIG_LOSE - i);
      }
      // A figure no longer among the nearest keeps walking, untagged, till it gives way.
      for (let i = 0; i < rigs.length; i++) {
        const rig = rigs[i]!;
        if (rig.owner !== -1 && rigRank[i] === 0 && rig.tag) showTag(rig.tag, 0, 0);
      }

      // Crowd: everyone who isn't all a full figure yet, under the cap, nearest the view first.
      let cutoff = Number.POSITIVE_INFINITY;
      if (nHere > kit.cap && figures > 0) {
        buckets.fill(0);
        const scale = (CAP_BUCKETS - 1) / rect.reach ** 2;
        for (let i = 0; i < nHere; i++) {
          const s = here[i]!;
          const d2 = (x[s]! - rect.x) ** 2 + (z[s]! - rect.z) ** 2;
          buckets[Math.min(CAP_BUCKETS - 1, (d2 * scale) | 0)]!++;
        }
        let sum = 0;
        for (let b = 0; b < CAP_BUCKETS; b++) {
          sum += buckets[b]!;
          if (sum > kit.cap) {
            // Even the middlemost ring over the cap keeps its own, cut off by the count below.
            cutoff = Math.max(1, b) / scale;
            break;
          }
        }
      }
      crowded = 0;
      let moved = false;
      if (figures > 0 && nHere > 0 && !crowd) {
        const materials = kit.crowd(crowdInk);
        crowd = createCrowdMesh({ scene, ...materials, ink: crowdInk }, kit.cap);
      }
      for (let i = 0; i < nHere; i++) {
        const s = here[i]!;
        const going = gone[s] === 1;
        const px = going ? placedX[s]! : x[s]!;
        const pz = going ? placedZ[s]! : z[s]!;
        const d2 = (px - rect.x) ** 2 + (pz - rect.z) ** 2;
        // Past the cap (the middle's ring can't tell them apart), they fall to a marker too.
        const eligible = d2 < cutoff && crowded < kit.cap;
        figure[s] = ease(figure[s]!, eligible ? 1 : 0, dtMs);
        const part = rigShown[s]!;
        const fade = p.fade[s]! * door[s]!;
        // Whatever hasn't settled wants another frame, drawn or not: someone at fade 0 yet is
        // nothing to draw this frame but will be the next.
        if (p.speed[s]! > STANDING || fade !== 1 || figure[s] !== (eligible ? 1 : 0)) moved = true;
        if (figures <= 0 || figure[s]! <= 0 || part >= 0.999 || crowded === kit.cap) continue;
        const shownCrowd = crowdFade(part, figure[s]!, figures, fade);
        if (shownCrowd === 0) continue;
        const y = going ? (Number.isNaN(cacheY[s]!) ? null : cacheY[s]!) : heightOf(p, s);
        if (y === null) continue;
        // The stride taken since last time, turned into the limbs' swing: walking pace or run.
        let dw = p.travelled[s]! - walked[s]!;
        if (dw < -TRAVELLED_WRAP / 2) dw += TRAVELLED_WRAP;
        walked[s] = p.travelled[s]!;
        const speed = p.speed[s]!;
        const stride = STRIDE_WALK + (STRIDE_RUN - STRIDE_WALK) * runBlend(speed);
        phase[s] = (phase[s]! + (dw / stride) * TAU) % TAU;
        const swing = flags[s]! & BIKE ? 0 : Math.min(1, speed / 1.5);
        const who = p.who(s);
        crowd!.place(
          crowded++,
          px,
          y,
          pz,
          p.heading[s]!,
          phase[s]!,
          swing,
          shownCrowd,
          p.colour[s]!,
          who ? who.outfit : null,
        );
      }
      crowdMoved = moved && figures > 0;
      // An outline a pen's width at any distance: past that, the geometry's own hull is enough.
      const pixelMetres = view.span / view.height;
      const inkExtra = Math.max(0, (INK_PX * pixelMetres) / CHARACTER_SCALE - 0.035);
      crowd?.finish(crowded, inkExtra);
      drawn = nHere;

      // The markers: all of them far out, and whoever fell off the crowd's cap, wherever.
      let anyMark = markers > 0;
      for (let i = 0; !anyMark && i < nHere; i++) {
        if (figure[here[i]!]! < 1) anyMark = true;
      }
      marksWanted = anyMark;
      if (anyMark) {
        markAlpha.fill(0, 0, p.count);
        for (let i = 0; i < nHere; i++) {
          const s = here[i]!;
          markAlpha[s] = markShare(rigShown[s]!, figure[s]!, markers) * door[s]!;
        }
        if (paintMarks(p, view, markAlpha)) scheduleMarks(SETTLING_MS);
      } else if (marksDrawn) {
        paintMarks(p, view, markAlpha.fill(0, 0, p.count));
      }
    },
    dispose() {
      for (const rig of rigs) removeRig(rig);
      rigs.length = 0;
      clearTimeout(marksTimer as ReturnType<typeof setTimeout>);
      if (crowd) crowd.dispose();
      riders?.dispose();
    },
  };
}
