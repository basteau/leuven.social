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

export interface Players {
  /** Hands over the roster, or none (signed out): everyone goes. */
  use(roster: Roster | null): void;
  /**
   * Draws them for a frame: `shown` whether figures are drawn at this zoom, (`x`, `z`) the view's
   * target, `place` and `floor` where the avatar is. Returns whether anyone is still moving.
   */
  frame(
    now: number,
    dt: number,
    shown: boolean,
    x: number,
    z: number,
    place: string,
    floor: number,
  ): boolean;
  /** How many are drawn this frame. */
  readonly drawn: number;
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

interface Shown {
  entry: RosterEntry;
  character: Character;
  xray: MeshBasicMaterial;
  pose: Pose;
  gait: Gait;
  at: PlayerPose;
  known: boolean;
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
  let drawn = 0;
  const points = new Float32Array(MOST * 64 * 2);
  const nearest: number[] = [];
  const head = new Vector3();

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
      tag,
      tagX: Number.NaN,
      tagY: Number.NaN,
    };
  }

  function remove(s: Shown): void {
    scene.remove(s.character.mesh);
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

  /** Over their head on screen, written only when it moves by a pixel. */
  function placeTag(s: Shown, y: number): void {
    if (!s.tag) return;
    head.set(s.at.x, y + OVER_HEAD, s.at.z).project(camera);
    const [w, h] = [canvas.clientWidth, canvas.clientHeight];
    const [tx, ty] = [((head.x + 1) / 2) * w, ((1 - head.y) / 2) * h];
    if (tx < -50 || ty < -20 || tx > w + 50 || ty > h + 50) return hideTag(s);
    if (s.tag.hidden) s.tag.hidden = false;
    if (Math.abs(tx - s.tagX) < 0.5 && Math.abs(ty - s.tagY) < 0.5) return;
    [s.tagX, s.tagY] = [tx, ty];
    s.tag.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0)`;
  }

  return {
    get drawn() {
      return drawn;
    },
    use(next) {
      roster = next;
      for (const s of shown.values()) remove(s);
      shown.clear();
      list = [];
      version = -1;
      if (riders) riders.count = 0;
      drawn = 0;
    },
    frame(now, dt, figures, x, z, place, floor) {
      if (!roster) return false;
      if (roster.version() !== version) sync();
      let moving = false;
      let count = 0;
      for (const s of list) {
        s.known = roster.pose(s.entry.id, now, s.at);
        if (!s.known) continue;
        stepGait(s.gait, s.at, dt);
        if (s.at.speed > 0 || s.gait.still < IDLE) moving = true;
      }
      // The nearest of those here with the avatar, up to MOST.
      const here: Shown[] = [];
      for (const s of list) {
        if (s.known && figures && together(s.at, place, floor)) here.push(s);
      }
      if (here.length * 2 > points.length) here.length = points.length / 2;
      for (const [i, s] of here.entries()) [points[i * 2], points[i * 2 + 1]] = [s.at.x, s.at.z];
      nearestOf(points, here.length, x, z, MOST, nearest);
      const drawing = new Set(nearest.map((i) => here[i]!));
      let rode = 0;
      for (const s of list) {
        const y = drawing.has(s) ? kit.floorAt(s.at) : null;
        const onFoot = y !== null && s.at.mode === 'foot';
        s.character.mesh.visible = onFoot;
        if (y === null) {
          hideTag(s);
          continue;
        }
        count++;
        placeTag(s, y);
        if (!onFoot) {
          if (!riders) {
            if (!loadingRiders) {
              loadingRiders = true;
              kit.riders().then(
                (loaded) => (riders = loaded),
                () => (loadingRiders = false), // tried again when someone next rides
              );
            }
            continue;
          }
          // Each on a bike of a colour of their own, as the racks hold them.
          const frame = BIKES[s.entry.id % BIKES.length]!;
          riders.dress(rode, { ...s.entry.outfit, frame });
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
      drawn = count;
      return moving;
    },
    dispose() {
      for (const s of shown.values()) remove(s);
      shown.clear();
      riders?.dispose();
    },
  };
}
