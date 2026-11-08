import {
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearSRGBColorSpace,
  Vector3,
} from 'three';
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
import { MeshBuilder } from './mesh-builder.ts';
import { BIKES } from './palette.ts';
import type { Riders } from './rider.ts';

/**
 * The other players in the scene: each near the view as the walker's own figure in their own
 * clothes, skin and hair, walking, running and idling as the avatar does, or riding as its rider
 * does; their names over their heads, as tags in the page. Only the `MOST` nearest the view are
 * drawn so, two draw calls each (the figure and its x-ray), and the riders three in all. A crowd
 * beyond them is one more draw call, an instance each of a few prisms in their shirts' colour.
 * The rigs and tags are a pool of `MOST`: being on the roster costs a few numbers, nothing on the
 * GPU or in the page.
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
  /** Says where the view looks, as it changes: who is on the roster depends on it. */
  look(x: number, z: number): void;
  /** Says the full map opened or shut, which asks for everyone on the map, as dots. */
  fullMap(on: boolean): void;
  /** Everyone on the map as last told, while the full map is open. */
  dots(): readonly RosterDot[];
}

/** Someone on the full map, whether they are on the roster or not. */
export interface RosterDot {
  id: number;
  x: number;
  z: number;
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
  /** The terrain under (x, z) (m): near enough for a crowd's far figures, and cheap. */
  groundAt(x: number, z: number): number;
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
  /** How many are drawn, and the draw calls they take (two a figure, three for all riders, one for the crowd). */
  readonly drawn: number;
  readonly calls: number;
  dispose(): void;
}

/** At most this many are drawn at once, the nearest the view. */
const MOST = 24;
/** Feet this far over the ground as drawn, as the avatar's (m). */
const FEET_Y = 0.04;
/** At most this many more are drawn as the crowd's simple figures. */
const CROWD = 240;
/** The rigs dressed or made in one frame, as making a figure's geometry takes a while. */
const SWAPS_PER_FRAME = 3;
/** Their tag sits this far over their feet (m): just over the head, drawn 1.3× life. */
const OVER_HEAD = 2.75;
/** Idle long enough, a figure stands still and needs no more frames (s; the walker's IDLE_SECONDS). */
const IDLE = 7;
/** After the riders failed to load, they are asked for again no sooner than this (ms). */
const RIDERS_RETRY_MS = 30_000;

/** One of the pool of full figures and tags, worn by whoever is nearest. */
interface Rig {
  character: Character;
  xray: MeshBasicMaterial;
  pose: Pose;
  tag: HTMLElement | null;
  /** The tag's last place on screen, to write it only when it moves. */
  tagX: number;
  tagY: number;
  owner: Shown | null;
  /** Whom it is dressed as now. */
  outfit: Outfit;
}

/** Someone on the roster: a few numbers. */
interface Shown {
  entry: RosterEntry;
  gait: Gait;
  at: PlayerPose;
  known: boolean;
  /** Among the nearest, in the last `place`. */
  drawing: boolean;
  rig: Rig | null;
  /** Drawn as one of the crowd in the last `place`. */
  crowded: boolean;
}

/** A figure at a glance: a body, a head and a darker foot, in a few prisms. */
function crowdGeometry() {
  const mesh = new MeshBuilder();
  const SIDES = 6;
  const ring = (radius: number, y: number) =>
    Array.from({ length: SIDES }, (_, i): [number, number, number] => {
      const a = (i / SIDES) * Math.PI * 2;
      return [Math.sin(a) * radius, y, Math.cos(a) * radius];
    });
  const band = (lo: [number, number], hi: [number, number], color: number) => {
    const a = ring(lo[0], lo[1]);
    const b = ring(hi[0], hi[1]);
    for (let i = 0; i < SIDES; i++) {
      const j = (i + 1) % SIDES;
      const out: [number, number, number] = [a[i]![0] + a[j]![0], 0, a[i]![2] + a[j]![2]];
      mesh.quad(a[i]!, a[j]!, b[j]!, b[i]!, color, out);
    }
  };
  // In the units of the figure: it stands 1.45 m, drawn CHARACTER_SCALE × life like the others.
  const CLOTHES = 0xffffff;
  const LEGS = 0x8a8a8a;
  const SKIN = 0xfff0e0;
  band([0.12, 0], [0.16, 0.65], LEGS);
  band([0.16, 0.65], [0.2, 1.15], CLOTHES);
  band([0.2, 1.15], [0.1, 1.28], CLOTHES);
  band([0.14, 1.26], [0.14, 1.5], SKIN);
  const top = ring(0.14, 1.5);
  for (let i = 1; i < SIDES - 1; i++) {
    mesh.triangle(top[0]!, top[i]!, top[i + 1]!, SKIN, [0, 1, 0]);
  }
  return mesh.build({ keep: true });
}

const hex = (colour: number) => `#${colour.toString(16).padStart(6, '0')}`;

export function createPlayers(kit: PlayersKit): Players {
  const { scene, camera, canvas } = kit;
  let roster: Roster | null = null;
  let version = -1;
  const shown = new Map<number, Shown>();
  let list: Shown[] = [];
  const rigs: Rig[] = [];
  let riders: Riders | undefined;
  let loadingRiders = false;
  let ridersRetry = 0;
  /** Who each riders' instance is dressed as, so a slot is dressed only when its rider changes. */
  const slots: (RosterEntry | undefined)[] = [];
  let drawn = 0;
  let rode = 0;
  let rigged = 0;
  let crowded = 0;
  // Reused from frame to frame: nothing is allocated per frame.
  let points = new Float32Array(64 * 2);
  const here: Shown[] = [];
  const nearest: number[] = [];
  const head = new Vector3();
  const colour = new Color();
  /** Who wears each of the crowd's instances, so its colour is written only when that changes. */
  const crowdOwners: (RosterEntry | undefined)[] = [];
  let crowdMesh: InstancedMesh | null = null;
  const isHere = (s: Shown, view: PlayersView) =>
    s.known && view.figures && together(s.at, view.place, view.floor);

  /** The crowd's one mesh, made the first time there is a crowd. */
  function crowdOf(): InstancedMesh {
    if (crowdMesh) return crowdMesh;
    crowdMesh = new InstancedMesh(crowdGeometry(), kit.body, CROWD);
    crowdMesh.instanceColor = new InstancedBufferAttribute(new Float32Array(CROWD * 3), 3);
    crowdMesh.frustumCulled = false;
    crowdMesh.receiveShadow = true;
    crowdMesh.count = 0;
    scene.add(crowdMesh);
    return crowdMesh;
  }

  function dress(rig: Rig, outfit: Outfit): void {
    const geometry = characterGeometry(outfit);
    rig.character.mesh.geometry.dispose();
    rig.character.mesh.geometry = geometry;
    rig.character.xray.geometry = geometry;
    rig.xray.color.setHex(outfit.shirt);
    rig.outfit = outfit;
    rig.tag?.style.setProperty('--shirt', hex(outfit.shirt));
  }

  function newRig(outfit: Outfit): Rig {
    // The silhouette behind a house in their own shirt, so you can tell who's there.
    const xray = kit.xray(outfit.shirt);
    const character = createCharacter(kit.body, xray, outfit);
    character.mesh.scale.setScalar(CHARACTER_SCALE);
    character.mesh.visible = false;
    scene.add(character.mesh);
    let tag: HTMLElement | null = null;
    if (kit.tags) {
      tag = document.createElement('div');
      tag.className = 'player-tag';
      tag.hidden = true;
      tag.style.setProperty('--shirt', hex(outfit.shirt));
      kit.tags.append(tag);
    }
    const rig: Rig = {
      character,
      xray,
      pose: {} as Pose,
      tag,
      tagX: Number.NaN,
      tagY: Number.NaN,
      owner: null,
      outfit,
    };
    rigs.push(rig);
    return rig;
  }

  function removeRig(rig: Rig): void {
    scene.remove(rig.character.mesh);
    // Each skinned mesh holds its bones in a texture on the GPU.
    rig.character.mesh.skeleton.dispose();
    rig.character.mesh.geometry.dispose();
    rig.xray.dispose();
    rig.tag?.remove();
  }

  /** Takes a figure back from whoever wore it. */
  function release(rig: Rig): void {
    if (rig.owner) rig.owner.rig = null;
    rig.owner = null;
    rig.character.mesh.visible = false;
    hideTag(rig);
  }

  /** Puts `s` in a figure, if one is free and the frame can afford dressing it. */
  function fit(s: Shown, swaps: { left: number }): void {
    let rig = rigs.find((r) => !r.owner && r.outfit === s.entry.outfit);
    if (!rig) {
      if (swaps.left === 0) return;
      swaps.left--;
      rig = rigs.find((r) => !r.owner);
      if (rig) dress(rig, s.entry.outfit);
      else if (rigs.length < MOST) rig = newRig(s.entry.outfit);
      else return;
    }
    rig.owner = s;
    s.rig = rig;
    if (rig.tag) rig.tag.textContent = s.entry.name;
    rig.tagX = Number.NaN;
    // Taken up mid-stride: its legs start from here, not from a turn it never made.
    s.gait.heading = s.at.heading;
  }

  /** Brings the list in line with the roster: newcomers, leavers, new clothes. */
  function sync(): void {
    if (!roster) return;
    version = roster.version();
    const seen = new Set<number>();
    for (const entry of roster.entries()) {
      seen.add(entry.id);
      const s = shown.get(entry.id);
      if (!s) {
        shown.set(entry.id, {
          entry,
          gait: createGait(),
          at: { x: 0, z: 0, heading: 0, speed: 0, mode: 'foot', place: '', floor: 0 },
          known: false,
          drawing: false,
          rig: null,
          crowded: false,
        });
      } else {
        const rig = s.rig;
        if (rig && rig.outfit !== entry.outfit) dress(rig, entry.outfit);
        if (rig?.tag && s.entry.name !== entry.name) rig.tag.textContent = entry.name;
        s.entry = entry;
      }
    }
    for (const [id, s] of shown) {
      if (seen.has(id)) continue;
      if (s.rig) release(s.rig);
      shown.delete(id);
    }
    list = [...shown.values()];
  }

  function hideTag(rig: Rig): void {
    if (rig.tag && !rig.tag.hidden) rig.tag.hidden = true;
    rig.tagX = Number.NaN;
  }

  /** Over their head on screen (`w` × `h` CSS px), written only when it moves by a pixel. */
  function placeTag(rig: Rig, at: PlayerPose, y: number, w: number, h: number): void {
    if (!rig.tag) return;
    head.set(at.x, y + OVER_HEAD, at.z).project(camera);
    const [tx, ty] = [((head.x + 1) / 2) * w, ((1 - head.y) / 2) * h];
    if (tx < -50 || ty < -20 || tx > w + 50 || ty > h + 50) return hideTag(rig);
    if (rig.tag.hidden) rig.tag.hidden = false;
    if (Math.abs(tx - rig.tagX) < 0.5 && Math.abs(ty - rig.tagY) < 0.5) return;
    [rig.tagX, rig.tagY] = [tx, ty];
    rig.tag.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0)`;
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

  /** Writes one of the crowd's instances where `s` stands, turned its way. */
  function placeCrowd(mesh: InstancedMesh, i: number, s: Shown, y: number): void {
    const { array } = mesh.instanceMatrix;
    const [sin, cos] = [Math.sin(s.at.heading), Math.cos(s.at.heading)];
    const e = i * 16;
    // Heading about +y, scale, and the feet on the ground.
    array[e] = cos * CHARACTER_SCALE;
    array[e + 1] = 0;
    array[e + 2] = -sin * CHARACTER_SCALE;
    array[e + 3] = 0;
    array[e + 4] = 0;
    array[e + 5] = CHARACTER_SCALE;
    array[e + 6] = 0;
    array[e + 7] = 0;
    array[e + 8] = sin * CHARACTER_SCALE;
    array[e + 9] = 0;
    array[e + 10] = cos * CHARACTER_SCALE;
    array[e + 11] = 0;
    array[e + 12] = s.at.x;
    array[e + 13] = y + FEET_Y;
    array[e + 14] = s.at.z;
    array[e + 15] = 1;
    if (crowdOwners[i] !== s.entry) {
      crowdOwners[i] = s.entry;
      // As written: the figures' shader turns their colours linear after the tint is applied.
      mesh.setColorAt(i, colour.setHex(s.entry.outfit.shirt, LinearSRGBColorSpace));
      mesh.instanceColor!.needsUpdate = true;
    }
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
      return rigged * 2 + (rode ? 3 : 0) + (crowded ? 1 : 0);
    },
    use(next) {
      roster = next;
      for (const rig of rigs) release(rig);
      shown.clear();
      list = [];
      version = -1;
      if (riders) riders.count = 0;
      if (crowdMesh) crowdMesh.count = 0;
      slots.length = 0;
      [drawn, rode, rigged, crowded] = [0, 0, 0, 0];
    },
    step(now, dt) {
      if (!roster) return false;
      if (roster.version() !== version) sync();
      let moving = false;
      for (const s of list) {
        s.known = roster.pose(s.entry.id, now, s.at);
        if (!s.known) continue;
        // Only a figure with legs has any use for a gait.
        if (s.rig) stepGait(s.gait, s.at, dt);
        if (s.drawing && (s.at.speed > 0 || s.gait.still < IDLE)) moving = true;
        else if (s.crowded && s.at.speed > 0) moving = true;
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
      roster?.look(view.x, view.z);
      [drawn, rode, rigged, crowded] = [0, 0, 0, 0];
      // The nearest of those here with the avatar, up to MOST.
      here.length = 0;
      for (const s of list) {
        s.drawing = false;
        s.crowded = false;
        if (isHere(s, view) && Math.hypot(s.at.x - view.x, s.at.z - view.z) < view.reach) {
          here.push(s);
        }
      }
      if (points.length < here.length * 2) points = new Float32Array(here.length * 4);
      for (let i = 0; i < here.length; i++) {
        [points[i * 2], points[i * 2 + 1]] = [here[i]!.at.x, here[i]!.at.z];
      }
      for (const i of nearestOf(points, here.length, view.x, view.z, MOST, nearest)) {
        here[i]!.drawing = true;
      }
      // Whoever has dropped out of the nearest gives up their figure for those who came in.
      for (const rig of rigs) {
        if (rig.owner && !rig.owner.drawing) release(rig);
      }
      const swaps = { left: SWAPS_PER_FRAME };
      // The canvas's size, read once, before any tag is written.
      const [w, h] = [canvas.clientWidth, canvas.clientHeight];
      for (const i of nearest) {
        const s = here[i]!;
        if (!s.rig) fit(s, swaps);
        const y = kit.floorAt(s.at);
        const rig = s.rig;
        s.drawing = y !== null;
        if (rig) rig.character.mesh.visible = false;
        if (y === null) {
          if (rig) hideTag(rig);
          continue;
        }
        if (!rig) continue; // the crowd draws it till a figure is free
        const onFoot = s.at.mode === 'foot';
        rig.character.mesh.visible = onFoot;
        drawn++;
        placeTag(rig, s.at, y, w, h);
        if (!onFoot) {
          ride(s, y);
          continue;
        }
        rigged++;
        const g = s.gait;
        applyPose(
          rig.character,
          poseAt(
            rig.pose,
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
        rig.character.mesh.position.set(s.at.x, y + FEET_Y, s.at.z);
        rig.character.mesh.rotation.y = s.at.heading;
      }
      if (riders) riders.count = rode;

      // Everyone else in view, in one draw call.
      for (const s of here) {
        if ((s.drawing && s.rig) || crowded === CROWD) continue;
        const y = s.at.place ? kit.floorAt(s.at) : kit.groundAt(s.at.x, s.at.z);
        if (y === null) continue;
        placeCrowd(crowdOf(), crowded++, s, y);
        s.crowded = true;
        drawn++;
      }
      if (crowdMesh) {
        crowdMesh.count = crowded;
        crowdMesh.visible = crowded > 0;
        if (crowded) crowdMesh.instanceMatrix.needsUpdate = true;
      }
    },
    dispose() {
      for (const rig of rigs) removeRig(rig);
      rigs.length = 0;
      shown.clear();
      if (crowdMesh) {
        scene.remove(crowdMesh);
        crowdMesh.geometry.dispose();
        crowdMesh.dispose();
      }
      riders?.dispose();
    },
  };
}
