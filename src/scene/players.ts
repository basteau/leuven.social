import { Vector3 } from 'three';
import type { Material, MeshBasicMaterial, OrthographicCamera, Scene } from 'three';

import {
  CHARACTER_SCALE,
  applyPose,
  characterGeometry,
  createCharacter,
  poseAt,
} from './character.ts';
import type { Character, Outfit, Pose } from './character.ts';
import { createGait, nearestOf, stepGait, together } from './crowd.ts';
import type { Gait, PlayerPose } from './crowd.ts';
import { BIKES } from './palette.ts';
import type { Riders } from './rider.ts';

/**
 * The other players in the scene: each near the view as the walker's own figure in their own
 * clothes, skin and hair, walking, running and idling as the avatar does, or riding as its rider
 * does; their names over their heads, as tags in the page. Only the `MOST` nearest the view are
 * drawn, two draw calls each (the figure and its x-ray), and the riders three in all.
 *
 * Where they are comes from a `Roster` the app keeps from the network, sampled each frame a
 * moment behind it so they glide; this layer knows nothing of sockets. Browser-only: the logic
 * is in crowd.ts.
 */

/** Someone on the map: who they are and how they look. */
export interface RosterEntry {
  id: number;
  name: string;
  outfit: Outfit;
}

/** The other players, as the app knows them. */
export interface Roster {
  /** Changes whenever someone joins, leaves or changes how they look. */
  version(): number;
  entries(): readonly RosterEntry[];
  /** Writes where `id` is drawn at `now` (ms, `performance.now()`) into `out`; false if unknown. */
  pose(id: number, now: number, out: PlayerPose): boolean;
  /** Calls `news` whenever anything changes or moves, so the map draws again; returns an unsubscribe. */
  listen(news: () => void): () => void;
}

export interface PlayersKit {
  scene: Scene;
  camera: OrthographicCamera;
  canvas: HTMLCanvasElement;
  /** The figures' toon material, shared with the avatar's. */
  body: Material;
  /** A silhouette material for where a house hides someone, in their shirt's colour. */
  xray(color: number): MeshBasicMaterial;
  /** Where the tags go: an element over the canvas, or none. */
  tags: HTMLElement | null;
  reducedMotion: boolean;
  /** The ground as drawn under (x, z) in the street, or the floor of a room (m); null: unseen. */
  floorAt(pose: PlayerPose): number | null;
  /** The riders, loaded the first time someone rides. */
  riders(): Promise<Riders>;
}

/** Where the map looks from, for which of the others to draw. */
export interface PlayersView {
  /** Whether figures are drawn at this zoom at all. */
  figures: boolean;
  /** The view's target (m), whose nearest are drawn, and how far from it the view reaches. */
  x: number;
  z: number;
  reach: number;
  /** Where the avatar is: '' the street, else a room and its floor. */
  place: string;
  floor: number;
}

export interface Players {
  /** Hands over the roster, or none (signed out): everyone goes. */
  use(roster: Roster | null): void;
  /**
   * Moves everyone on to `now`: where the roster says they are, their legs `dt` seconds on.
   * Returns whether any of those drawn still moves (or idles), and needs another frame.
   */
  step(now: number, dt: number): boolean;
  /** Draws the nearest of them for the view: figures, riders and tags. Each frame drawn. */
  place(view: PlayersView): void;
  /** Whether anyone the view would draw is out there at `now`: news worth a frame. */
  near(now: number, view: PlayersView): boolean;
  /** How many are drawn, and the draw calls they take (two a figure, three for all riders). */
  readonly drawn: number;
  readonly calls: number;
  dispose(): void;
}

/** At most this many are drawn at once, the nearest the view. */
const MOST = 24;
/** Feet this far over the ground as drawn, as the avatar's (m). */
const FEET_Y = 0.04;
/** Their tag sits this far over their feet (m): just over the head, drawn 1.3× life. */
const OVER_HEAD = 2.75;
/** Idle long enough, a figure stands still and needs no more frames (s; the walker's IDLE_SECONDS). */
const IDLE = 7;
/** After the riders failed to load, they are asked for again no sooner than this (ms). */
const RIDERS_RETRY_MS = 30_000;

interface Shown {
  entry: RosterEntry;
  character: Character;
  xray: MeshBasicMaterial;
  pose: Pose;
  gait: Gait;
  at: PlayerPose;
  known: boolean;
  /** Drawn in the last `place`. */
  drawing: boolean;
  tag: HTMLElement | null;
  /** The tag's last place on screen, to write it only when it moves. */
  tagX: number;
  tagY: number;
}

const hex = (colour: number) => `#${colour.toString(16).padStart(6, '0')}`;

export function createPlayers(kit: PlayersKit): Players {
  const { scene, camera, canvas } = kit;
  let roster: Roster | null = null;
  let version = -1;
  const shown = new Map<number, Shown>();
  let list: Shown[] = [];
  let riders: Riders | undefined;
  let loadingRiders = false;
  let ridersRetry = 0;
  /** Who each riders' instance is dressed as, so a slot is dressed only when its rider changes. */
  const slots: (RosterEntry | undefined)[] = [];
  let drawn = 0;
  let rode = 0;
  // Reused from frame to frame: nothing is allocated per frame.
  let points = new Float32Array(64 * 2);
  const here: Shown[] = [];
  const nearest: number[] = [];
  const head = new Vector3();
  const isHere = (s: Shown, view: PlayersView) =>
    s.known && view.figures && together(s.at, view.place, view.floor);

  function dress(s: Shown, outfit: Outfit): void {
    const geometry = characterGeometry(outfit);
    s.character.mesh.geometry.dispose();
    s.character.mesh.geometry = geometry;
    s.character.xray.geometry = geometry;
    s.xray.color.setHex(outfit.shirt);
    s.tag?.style.setProperty('--shirt', hex(outfit.shirt));
  }

  function add(entry: RosterEntry): Shown {
    // The silhouette behind a house in their own shirt, so you can tell who's there.
    const xray = kit.xray(entry.outfit.shirt);
    const character = createCharacter(kit.body, xray, entry.outfit);
    character.mesh.scale.setScalar(CHARACTER_SCALE);
    character.mesh.visible = false;
    scene.add(character.mesh);
    let tag: HTMLElement | null = null;
    if (kit.tags) {
      tag = document.createElement('div');
      tag.className = 'player-tag';
      tag.textContent = entry.name;
      tag.hidden = true;
      tag.style.setProperty('--shirt', hex(entry.outfit.shirt));
      kit.tags.append(tag);
    }
    const at: PlayerPose = { x: 0, z: 0, heading: 0, speed: 0, mode: 'foot', place: '', floor: 0 };
    return {
      entry,
      character,
      xray,
      pose: {} as Pose,
      gait: createGait(),
      at,
      known: false,
      drawing: false,
      tag,
      tagX: Number.NaN,
      tagY: Number.NaN,
    };
  }

  function remove(s: Shown): void {
    scene.remove(s.character.mesh);
    // Each skinned mesh holds its bones in a texture on the GPU.
    s.character.mesh.skeleton.dispose();
    s.character.mesh.geometry.dispose();
    s.xray.dispose();
    s.tag?.remove();
  }

  /** Brings the figures in line with the roster: newcomers, leavers, new clothes. */
  function sync(): void {
    if (!roster) return;
    version = roster.version();
    const seen = new Set<number>();
    for (const entry of roster.entries()) {
      seen.add(entry.id);
      const s = shown.get(entry.id);
      if (!s) shown.set(entry.id, add(entry));
      else {
        if (s.entry.outfit !== entry.outfit) dress(s, entry.outfit);
        if (s.tag && s.entry.name !== entry.name) s.tag.textContent = entry.name;
        s.entry = entry;
      }
    }
    for (const [id, s] of shown) {
      if (seen.has(id)) continue;
      remove(s);
      shown.delete(id);
    }
    list = [...shown.values()];
  }

  function hideTag(s: Shown): void {
    if (s.tag && !s.tag.hidden) s.tag.hidden = true;
    s.tagX = Number.NaN;
  }

  /** Over their head on screen (`w` × `h` CSS px), written only when it moves by a pixel. */
  function placeTag(s: Shown, y: number, w: number, h: number): void {
    if (!s.tag) return;
    head.set(s.at.x, y + OVER_HEAD, s.at.z).project(camera);
    const [tx, ty] = [((head.x + 1) / 2) * w, ((1 - head.y) / 2) * h];
    if (tx < -50 || ty < -20 || tx > w + 50 || ty > h + 50) return hideTag(s);
    if (s.tag.hidden) s.tag.hidden = false;
    if (Math.abs(tx - s.tagX) < 0.5 && Math.abs(ty - s.tagY) < 0.5) return;
    [s.tagX, s.tagY] = [tx, ty];
    s.tag.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0)`;
  }

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

  /** Draws a rider in the riders' next slot, dressing the slot only when its rider changed. */
  function ride(s: Shown, y: number): void {
    if (!riders) return loadRiders();
    if (slots[rode] !== s.entry) {
      slots[rode] = s.entry;
      // Each on a bike of a colour of their own, as the racks hold them.
      riders.dress(rode, { ...s.entry.outfit, frame: BIKES[s.entry.id % BIKES.length]! });
    }
    riders.pose(rode, {
      x: s.at.x,
      y,
      z: s.at.z,
      heading: s.at.heading,
      lean: s.gait.lean,
      pedal: s.gait.phase,
      braking: false,
    });
    rode++;
  }

  return {
    get drawn() {
      return drawn;
    },
    get calls() {
      return drawn * 2 - rode * 2 + (rode ? 3 : 0);
    },
    use(next) {
      roster = next;
      for (const s of shown.values()) remove(s);
      shown.clear();
      list = [];
      version = -1;
      if (riders) riders.count = 0;
      slots.length = 0;
      [drawn, rode] = [0, 0];
    },
    step(now, dt) {
      if (!roster) return false;
      if (roster.version() !== version) sync();
      let moving = false;
      for (const s of list) {
        s.known = roster.pose(s.entry.id, now, s.at);
        if (!s.known) continue;
        stepGait(s.gait, s.at, dt);
        if (s.drawing && (s.at.speed > 0 || s.gait.still < IDLE)) moving = true;
      }
      return moving;
    },
    near(now, view) {
      if (!roster || !view.figures) return false;
      if (roster.version() !== version) return true;
      for (const s of list) {
        s.known = roster.pose(s.entry.id, now, s.at);
        const d = Math.hypot(s.at.x - view.x, s.at.z - view.z);
        if (isHere(s, view) && d < view.reach) return true;
      }
      return false;
    },
    place(view) {
      [drawn, rode] = [0, 0];
      // The nearest of those here with the avatar, up to MOST.
      here.length = 0;
      for (const s of list) {
        s.drawing = false;
        if (isHere(s, view)) here.push(s);
      }
      if (points.length < here.length * 2) points = new Float32Array(here.length * 4);
      for (let i = 0; i < here.length; i++) {
        [points[i * 2], points[i * 2 + 1]] = [here[i]!.at.x, here[i]!.at.z];
      }
      for (const i of nearestOf(points, here.length, view.x, view.z, MOST, nearest)) {
        here[i]!.drawing = true;
      }
      // The canvas's size, read once, before any tag is written.
      const [w, h] = [canvas.clientWidth, canvas.clientHeight];
      for (const s of list) {
        const y = s.drawing ? kit.floorAt(s.at) : null;
        s.drawing = y !== null;
        const onFoot = y !== null && s.at.mode === 'foot';
        s.character.mesh.visible = onFoot;
        if (y === null) {
          hideTag(s);
          continue;
        }
        drawn++;
        placeTag(s, y, w, h);
        if (!onFoot) {
          ride(s, y);
          continue;
        }
        const g = s.gait;
        applyPose(
          s.character,
          poseAt(
            s.pose,
            s.at.speed,
            g.phase,
            g.still,
            !kit.reducedMotion,
            g.turning,
            0,
            0,
            s.at.heading,
          ),
        );
        s.character.mesh.position.set(s.at.x, y + FEET_Y, s.at.z);
        s.character.mesh.rotation.y = s.at.heading;
      }
      if (riders) riders.count = rode;
    },
    dispose() {
      for (const s of shown.values()) remove(s);
      shown.clear();
      riders?.dispose();
    },
  };
}
