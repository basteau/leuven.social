import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshDepthMaterial,
  MeshToonMaterial,
  RGBADepthPacking,
  Vector3,
  WebGLRenderTarget,
} from 'three';
import type { Material, OrthographicCamera, Scene, Texture, WebGLRenderer } from 'three';

import { createWalkSounds } from '../audio/walking.ts';
import { LANDMARK_FOOTPRINTS } from '../data/area.ts';
import { inRing } from '../data/cell-grid.ts';
import type { City } from '../data/city.ts';
import { DOOR_HALF } from '../data/room-grid.ts';
import type { Room } from '../data/rooms.ts';
import type { Presence } from '../data/presence.ts';
import { ROUTE_REACH, Router, TAP_REACH, legsToward } from '../data/route.ts';
import type { Terrain } from '../data/terrain.ts';
import { WalkGrid } from '../data/walkable.ts';
import { avatarState, createAvatar, stepAvatar } from './avatar.ts';
import type { Avatar, AvatarState } from './avatar.ts';
import type { Bikes, RideAction, RideState } from './bikes.ts';
import { XRAY_LOOK, createCharacterMaterial, createXrayMaterial } from './character-material.ts';
import type { Fade } from './character-material.ts';
import {
  CHARACTER_SCALE,
  applyPose,
  characterGeometry,
  createCharacter,
  poseAt,
  restPose,
} from './character.ts';
import type { Outfit } from './character.ts';
import type { PlayerPose } from './crowd.ts';
import { loose } from './collide.ts';
import { BAYER } from './facade-material.ts';
import { LEAD, recentre, screenSteer } from './follow.ts';
import { loadInteriors } from './interiors.ts';
import type { Interiors } from './interiors.ts';
import type { Detail } from './lod.ts';
import { MAX_ZOOM, PUFF_LAYER } from './lod.ts';
import type { MapControls } from './map-controls.ts';
import { markerDrop, markerGeometry, markerRadius } from './marker.ts';
import { MeshBuilder, linearVertexColors } from './mesh-builder.ts';
import type { LineBuilder } from './mesh-builder.ts';
import { clock, decay, ticks } from './motion.ts';
import { OUTLINE, WALKER } from './palette.ts';
import { nearestParked } from './parked.ts';
import { meant, nearestShown, unpackDepth } from './pick.ts';
import type { MeantTests } from './pick.ts';
import { createPlayers } from './players.ts';
import type { PlayersView, Roster } from './players.ts';
import { passedVertices, routeMarker } from './route-marker.ts';
import type { RouteMarker } from './route-marker.ts';
import { walkSolids } from './solids.ts';
import { STEP, followRoute, runBlend } from './walker.ts';

/**
 * The avatar in the scene: its figure, its route hint, a refused spot's marker, the camera
 * keeping it in view, its bikes and the rooms it walks into. A chunk of its own, loaded once the
 * first frame is drawn; the avatar it draws is on Grote Markt from the start.
 *
 * One way to move, on foot or on a bike: W A S D by the screen (Shift runs or sprints), or a tap
 * on the ground within ROUTE_REACH, which walks or rides it there along a route. The one thing
 * that puts it anywhere at once is a building's door: beside a building with a room inside, from
 * any side, Enter takes it in, and Enter again back out to its door. The camera is pinned to it,
 * gliding after it, until the person drags the map; then the view is theirs until Space (or
 * W A S D, or the edge diamond) brings it back. Animates only while something moves; otherwise
 * the viewer renders on demand. The logic is pure and tested elsewhere (avatar.ts, follow.ts,
 * walker.ts, the grids and routes); this is the glue.
 */

/** How many places round a tap's spot are tried before it's refused. */
const TRIES = 8;
/** A tap this far off (m) that no route reaches is a long way round: too far, not nowhere. */
const DETOUR = 80;
/** A spot picked on the full map goes to the street within this of it (m). */
const NAVIGATE_SNAP = 30;
/** A walk across town is at most this many legs, and a leg ends within this of its end (m). */
const MAX_LEGS = 40;
const LEG_ARRIVED = 4;
/** A tap that touches the avatar within this of its feet (m) stops it where it is. */
const ON_AVATAR = 1;
/**
 * The square read back round a tap: this many pixels a side, this many CSS px apart, so it
 * reaches 320 px each way: from the middle of the Dijle to its quays, from the roof of the
 * Stadhuis to the Markt in front of it.
 */
const PICK_SIDE = 81;
const PICK_STEP = 8;
/** How far from a tap on a building (m) the places beside it are looked for. */
const BESIDE_REACH = 60;
/** A surface less than this over the ground (m) is the ground: kerbs, steps, water, cobbles. */
const ON_GROUND = 0.4;
/** Everyone starts on Grote Markt within this of its middle (m), so nobody stands on anyone. */
const SPAWN_SPREAD = 9;
/** A place chosen from the menu brings the camera at least this close (zoom). */
const PLACE_ZOOM = 8;
/** A refused spot: its greyed marker shakes and goes over this long (s). */
const NOPE = 0.55;
/** Under this much view (m), the marker is hidden by what stands in front of it. */
const NEAR_SPAN = 30;
/** Feet this far over the ground as drawn, so their ink never dips into the street (m). */
const FEET_Y = 0.04;
/** A kerb's step up or down is eased over this half-life (s), not taken in one frame. */
const KERB_EASE = 0.04;
/** Within this of a parked bike (m), the bikes' chunk downloads, ready for F. */
const RIDE_NEAR = 25;
/** Zoom eases to a place's with this half-life (s). */
const ZOOM_EASE = 0.12;
/** Inside a room the camera keeps between these zooms: the room fills the view, not a speck. */
const ROOM_ZOOM = [8, 20] as const;
/** Within this of a landmark (m), with the figure in view, the rooms' data loads. */
const ROOMS_NEAR = 160;
/** Within this of a door (m), close to the street, a room is built while the page is idle. */
const PREWARM_NEAR = 60;
/** Out through the door, a step this far past the footprint's edge (m). */
const EDGE = 0.3;
/** Within this of a building with a room inside (m), from any side, Enter takes you in. */
const PERIMETER = 5;
/** Going in, you stand this far in from the door; coming out, this far out from it (m). */
const INSIDE = 3;
const OUTSIDE = 2;
/**
 * After the rooms or the bikes failed to load, they are tried again no sooner than this (ms): a
 * chunk gone with a deploy since the page opened would otherwise be asked for every frame.
 */
const RETRY_MS = 30_000;

const noop = () => {};

/** requestIdleCallback where there is one (not in Safari), else a moment later. */
const idle = (run: () => void): number =>
  'requestIdleCallback' in globalThis
    ? requestIdleCallback(run, { timeout: 1000 })
    : (setTimeout(run, 50) as unknown as number);
const cancelIdle = (handle: number) =>
  'cancelIdleCallback' in globalThis ? cancelIdleCallback(handle) : clearTimeout(handle);

/** Why a tap sent the avatar nowhere: no ground to stand on there, or too far to go. */
export type Refusal = 'closed' | 'far';

export interface AvatarHost {
  scene: Scene;
  /** The renderer, for reading back what a tap touched. */
  renderer: WebGLRenderer;
  camera: OrthographicCamera;
  controls: MapControls;
  canvas: HTMLCanvasElement;
  city: City;
  terrain: Terrain;
  /** The ground as drawn where the avatar stands: the terrain and the layer on it. */
  groundAt(x: number, z: number): number;
  gradientMap: Texture;
  /** How far into the night it is (the facade material's uniform), for the bike's lamps. */
  night: { value: number };
  reducedMotion: boolean;
  /** The camera's yaw, which W A S D steer by. */
  yaw(): number;
  /** Re-aims the camera at the controls' target. */
  placeCamera(): void;
  /** Draws a frame now. */
  /** Draws a frame; `continued` when the last frame's loop asked for this one. */
  render(continued: boolean): void;
  /** What casts shadows changed: a rack bike taken or put back. */
  shadowsChanged(): void;
  /** A tap the avatar can't go to, and why. */
  onBlocked?(why: Refusal): void;
  /** A bike near enough to ride, riding, or neither. */
  onRide?(state: RideState): void;
  /** How far out this window may zoom, back in the street. */
  farthestZoom(): number;
  /** A route to a picked spot began (its end, m) or ended (null). A bike's own short ones don't count. */
  onRoute?(target: readonly [number, number] | null): void;
  /** The site's base URL, where rooms.json is served. */
  base: string;
  /** The city's material and ink, which the rooms are drawn in. */
  material: Material;
  ink: Material;
  /** Draws a landmark as nothing in its cell while its room is open (null: none). */
  hideLandmark(id: number | null): void;
  /** Writes a landmark's walls, cut down to `top`, into a room's builders. */
  openWalls(id: number, top: number, mesh: MeshBuilder, lines: LineBuilder): boolean;
  /** The avatar went into a room, onto another floor, or back out to the street (null). */
  onPlace?(place: { room: string; floor: string } | null): void;
  /** The rooms couldn't load: a sentence saying so. Their doors stay shut. */
  onRoomsUnavailable?(message: string): void;
  /** A building you can go into is beside you (`inside` false), you're in one, or neither. */
  onDoor?(door: { room: string; inside: boolean } | null): void;
  /** Where the other players' name tags go: an element over the canvas, or none. */
  tags: HTMLElement | null;
  /** Where the avatar is and what it's doing, whenever that changes: for the other players. */
  onMove?(state: PlayerPose): void;
}

/** A room as the menu lists it: where its door is, to look at. */
export interface RoomPlace {
  id: string;
  name: string;
  x: number;
  z: number;
}

export interface AvatarLayer {
  /** Whether a frame of its own is on its way, so the viewer needn't draw one. */
  readonly animating: boolean;
  readonly state: AvatarState;
  /** Where its feet are drawn this frame (m), for the dither in front of it and its diamond. */
  readonly feet: readonly [number, number, number];
  /** Walks toward a direction on screen while held: right and up, each from -1 to 1. */
  steer(right: number, up: number): void;
  /** Runs (or sprints on a bike) while on. */
  run(on: boolean): void;
  /** A tap on the map at client coordinates: walk or ride there, if it's within reach. */
  tap(clientX: number, clientY: number): void;
  /** Walks or rides to a spot (m) along a route, as a tap does, and pins the camera again. */
  goTo(x: number, z: number): void;
  /** Lets go of the route being walked to a picked spot, if any. */
  cancelRoute(): void;
  /** The full map opened or shut, so the others are told of as dots while it is open. */
  fullMap(on: boolean): void;
  /** You, then the other players, as the full map draws them. */
  presences(): Presence[];
  /** Takes the camera to a spot (m), down to the street, leaving the avatar where it is. */
  lookAt(x: number, z: number): void;
  /** Pins the camera to the avatar again, gliding back to it. */
  recentre(): void;
  /** Pins the camera to the avatar and comes down to the street, if it's further out. */
  comeDown(): void;
  /** The map was dragged: the view is the person's now. */
  letGo(): void;
  /** Gets on or off the nearest bike, or rings its bell. */
  ride(action: RideAction): void;
  /** Goes into the building beside the avatar, or out of the one it's in. */
  door(): void;
  /** The rooms there are, once their data has loaded (it loads now if it hasn't). */
  rooms(): Promise<RoomPlace[]>;
  /** What's worth drawing at the view's span, each frame the viewer draws. */
  detail(detail: Detail, span: number): void;
  /** The other players to draw, or none. */
  others(roster: Roster | null): void;
  /** Dresses the avatar: its clothes, skin and hair. */
  dress(outfit: Outfit): void;
  /** Puts the avatar back where it was last time (m), on the open ground nearest, facing `heading`. */
  placeAt(x: number, z: number, heading: number): void;
  /** The draw calls the figures take this frame: the avatar's and the other players'. */
  readonly calls: number;
  dispose(): void;
}

/** The palette's sRGB vertex colours, made linear, on an unlit material. */
function colours(material: MeshBasicMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = linearVertexColors(shader.vertexShader);
  };
}

export function createAvatarLayer(host: AvatarHost): AvatarLayer {
  const { scene, camera, controls, canvas, terrain, reducedMotion } = host;
  const ground = (x: number, z: number) => terrain.height(x, z);

  // Trunks, benches and lamp posts stand in the way as drawn (src/scene/solids.ts).
  const grid = new WalkGrid(host.city, walkSolids(host.city));
  const router = new Router(grid);
  // On Grote Markt, a few steps from the middle: everyone starts there, not all on one spot.
  const middle = grid.nearest(0, 0, 60, true) ?? [0, 0];
  const spots = grid.around(middle[0], middle[1], SPAWN_SPREAD, 12);
  const start = spots[Math.floor(Math.random() * spots.length)] ?? middle;
  const avatar: Avatar = createAvatar(start[0], start[1], Math.PI);
  // The camera keeps the avatar in the middle from the start.
  controls.pinned = true;

  const fade: Fade = { value: 1 };
  const body = createCharacterMaterial(host.gradientMap, fade);
  let outfit: Outfit = WALKER;
  const xray = createXrayMaterial(fade, outfit.shirt);
  const character = createCharacter(body, xray, outfit);
  character.mesh.scale.setScalar(CHARACTER_SCALE);
  character.mesh.visible = false;
  scene.add(character.mesh);
  const pose = restPose();

  // The route hint, half see-through, as chalk on the street.
  const hint = new Mesh(
    undefined,
    new MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    }),
  );
  colours(hint.material);
  hint.frustumCulled = false;
  hint.visible = false;
  scene.add(hint);
  let marker: RouteMarker | undefined;

  // A refused spot's marker, greyed, shaking its head: one unlit draw call while it plays.
  const refusal = new Mesh(
    markerGeometry(),
    new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false }),
  );
  colours(refusal.material);
  refusal.material.color.setHex(0xa8a39c);
  refusal.frustumCulled = false;
  refusal.visible = false;
  refusal.renderOrder = 3;
  scene.add(refusal);

  const sounds = createWalkSounds();
  const sim = clock(STEP);
  let [prevX, prevZ, prevHeading, prevPhase] = [0, 0, 0, 0];
  const remember = () => {
    const w = avatar.walker;
    [prevX, prevZ, prevHeading, prevPhase] = [w.x, w.z, w.heading, w.phase];
  };
  remember();
  let kerb = 0;
  let onFeet = false;
  const feet: [number, number, number] = [0, 0, 0];

  let keyRight = 0;
  let keyUp = 0;
  let running = false;
  let frame = 0;
  let last = 0;
  /** What the last simulation step said: still moving, turning or idling. */
  let stirring = false;
  /** Whether a tick is under way: its own frame, so the viewer draws none on top of it. */
  let ticking = false;
  /** The last frame asked for this one: a loop, not a one-off wake. */
  let looping = false;
  /** Set once the layer is disposed: a download that lands later does nothing. */
  let disposed = false;
  /**
   * Counts what the person asked for last (a tap, keys, a bike), so an answer that arrives after
   * something newer was asked for is dropped.
   */
  let asked = 0;
  /** A spot the camera glides to while it isn't pinned (a place from the menu), or null. */
  let focus: { x: number; z: number } | null = null;
  /** Whether the camera's target is still on its way. */
  let gliding = false;
  /** A zoom the camera eases to (a place, a room), or NaN. */
  let zoomGoal = Number.NaN;
  /** The camera's target as it glides, and where it glides to, reused each frame. */
  const goal = { x: 0, z: 0 };
  const aim = { x: 0, z: 0 };
  /** What the view's span allows, and the span. */
  let shown: Detail['avatar'] = 'none';
  let span = 560;
  /** Whether the view is close enough to build rooms near the avatar ahead of a visit. */
  let prewarm = false;
  /** A refused spot: how long since its greyed marker dropped (s), and where. */
  let nope = Number.NaN;
  const nopeAt: [number, number] = [0, 0];

  // The bikes are a chunk of their own, downloaded near a rack (or on F).
  let bikes: Bikes | undefined;
  let loadingBikes: Promise<Bikes> | undefined;
  let bikesRetry = 0;
  let ride: RideState = '';
  let shownSpeed = Number.NaN;
  const loadBikes = () => {
    loadingBikes ??= import('./bikes.ts').then(({ createBikes }) => {
      if (disposed) throw new Error('The map closed while the bikes loaded.');
      bikes = createBikes({
        three: {
          BackSide,
          BufferAttribute,
          BufferGeometry,
          InstancedBufferAttribute,
          InstancedMesh,
          Matrix4,
          Mesh,
          MeshBasicMaterial,
          MeshToonMaterial,
        },
        MeshBuilder,
        linearVertexColors,
        bayer: BAYER,
        gradientMap: host.gradientMap,
        night: host.night,
        ink: OUTLINE,
        xray: XRAY_LOOK,
        scene,
        canvas,
        body,
        floor: host.groundAt,
        shadowsChanged: host.shadowsChanged,
      });
      bikes.show(true);
      bikes.dress(outfit);
      wake();
      return bikes;
    });
    // A failed download is tried again near a rack a while from now, or at once on F.
    loadingBikes.catch(() => {
      loadingBikes = undefined;
      bikesRetry = performance.now() + RETRY_MS;
    });
    return loadingBikes;
  };

  // The rooms: their code rides in this chunk (a chunk loaded from a chunk would split three.js
  // off the engine); only their data waits, loaded near a landmark.
  let interiors: Interiors | undefined;
  let loadingInteriors: Promise<Interiors> | undefined;
  let roomsRetry = 0;
  /** The room the avatar is in, or null in the street. */
  let room: Room | null = null;
  const landmarks = LANDMARK_FOOTPRINTS.flatMap((id) => {
    const b = host.city.buildings.find((x) => x.id === id);
    if (!b) return [];
    let [sx, sz] = [0, 0];
    for (let i = 0; i < b.ring.length; i += 2) [sx, sz] = [sx + b.ring[i]!, sz + b.ring[i + 1]!];
    return [[(sx * 2) / b.ring.length, (sz * 2) / b.ring.length] as const];
  });
  const loadRooms = () => {
    loadingInteriors ??= loadInteriors(
      {
        scene,
        material: host.material,
        ink: host.ink,
        city: host.city,
        groundAt: host.groundAt,
        openWalls: host.openWalls,
        shadowsChanged: host.shadowsChanged,
      },
      host.base,
    ).then(
      (loaded) => {
        if (disposed) throw new Error('The map closed while the rooms loaded.');
        interiors = loaded;
        wake();
        return loaded;
      },
      (error: unknown) => {
        // Said once; tried again on a later approach, a while from now.
        loadingInteriors = undefined;
        roomsRetry = performance.now() + RETRY_MS;
        if (!disposed) {
          host.onRoomsUnavailable?.(
            error instanceof Error ? error.message : 'The insides of the buildings couldn’t load.',
          );
        }
        throw error;
      },
    );
    return loadingInteriors;
  };
  /** The ground underfoot: the street's, or the room's floor. */
  const underfoot = () => (room && interiors ? interiors.grid(room, avatar.floor) : grid);

  // The other players, drawn as the avatar is, round where the view looks (players.ts).
  const riderKit = {
    three: {
      BackSide,
      InstancedBufferAttribute,
      InstancedMesh,
      Matrix4,
      MeshBasicMaterial,
      MeshToonMaterial,
    },
    MeshBuilder,
    linearVertexColors,
    bayer: BAYER,
    gradientMap: host.gradientMap,
    night: host.night,
    ink: OUTLINE,
    xray: XRAY_LOOK,
  };
  const players = createPlayers({
    scene,
    camera,
    canvas,
    body,
    xray: (color) => createXrayMaterial(fade, color),
    tags: host.tags,
    reducedMotion,
    floorAt(at) {
      if (!at.place) return host.groundAt(at.x, at.z);
      const inside = interiors?.byId(at.place);
      return inside && interiors ? interiors.standing(inside, at.floor, at.x, at.z).y : null;
    },
    groundAt: ground,
    riders: () =>
      import('./rider.ts').then(({ createRiders }) => {
        if (disposed) throw new Error('The map closed while the riders loaded.');
        return createRiders(riderKit, scene, 24);
      }),
  });
  let unlisten: () => void = noop;
  const othersView: PlayersView = { figures: false, x: 0, z: 0, reach: 0, place: '', floor: 0 };
  /** Where the view looks, for which of the others to draw. */
  function playersView(figures = shown === 'figure'): PlayersView {
    const t = controls.target;
    return Object.assign(othersView, {
      figures,
      x: t.x,
      z: t.z,
      // A half diagonal of the widest screens.
      reach: span,
      place: room?.id ?? '',
      floor: avatar.floor,
    });
  }

  function publishPlace(): void {
    canvas.dataset.place = room?.id ?? '';
    canvas.dataset.floor = String(avatar.floor);
    const floor = room?.floors.find((f) => f.level === avatar.floor);
    host.onPlace?.(room && floor ? { room: room.name, floor: floor.name } : null);
  }
  /** Into a room through its door: its roof lifts, its floors show, the camera comes closer. */
  function enter(into: Room): void {
    room = into;
    avatar.place = into.id;
    avatar.floor = 0;
    host.hideLandmark(into.oidn);
    interiors?.show(into, 0);
    [controls.minZoom, controls.maxZoom] = ROOM_ZOOM;
    const zoom = Math.min(ROOM_ZOOM[1], Math.max(ROOM_ZOOM[0], camera.zoom));
    if (zoom !== camera.zoom) zoomGoal = zoom;
    publishPlace();
  }
  function leave(): void {
    room = null;
    avatar.place = null;
    avatar.floor = 0;
    host.hideLandmark(null);
    interiors?.show(null, 0);
    [controls.minZoom, controls.maxZoom] = [host.farthestZoom(), MAX_ZOOM];
    publishPlace();
    publishDoor();
    // Walked out for a tap outside: on to it, unless the keys took over on the way.
    const next = onward;
    onward = null;
    if (next && avatar.walker.route) headFor(...next);
  }
  /**
   * Out through the door a step past the footprint's edge (the room's grid keeps its threshold
   * open), up or down a floor halfway up a stair. Once a step, so each changes exactly once.
   */
  function crossings(): void {
    if (!interiors || !room) return;
    const w = avatar.walker;
    const { door } = room;
    const into = (w.x - door.x) * Math.sin(door.facing) + (w.z - door.z) * Math.cos(door.facing);
    const atDoor = Math.hypot(w.x - door.x, w.z - door.z) <= DOOR_HALF + 1;
    if (!inRing(interiors.footprint(room), w.x, w.z) && (!atDoor || into < -EDGE)) {
      leave();
      return;
    }
    const at = interiors.standing(room, avatar.floor, w.x, w.z);
    if (at.level !== avatar.floor) {
      avatar.floor = at.level;
      interiors.show(room, at.level);
      publishPlace();
    }
  }
  /** The building beside the avatar it could go into, if any. */
  let beside: Room | null = null;
  function publishDoor(): void {
    const at = room ?? beside;
    canvas.dataset.door = at?.id ?? '';
    host.onDoor?.(at ? { room: at.name, inside: room !== null } : null);
  }
  /** Puts the avatar at a spot at once, facing `heading`: only ever through a building's door. */
  function teleport(x: number, z: number, heading: number): void {
    clearRoute();
    const w = avatar.walker;
    [w.x, w.z, w.heading, w.speed, w.accel, w.surge, w.turning] = [x, z, heading, 0, 0, 0, 0];
    w.route = null;
    remember();
    onFeet = false;
    publish();
    controls.pinned = true;
    focus = null;
    wake();
  }
  /** In through the door of the building beside, or out of the one it's in, in front of its door. */
  function throughDoor(): void {
    if (!interiors || avatar.mode !== 'foot') return;
    if (room) {
      const { door: d } = room;
      const [x, z] = [d.x - Math.sin(d.facing) * OUTSIDE, d.z - Math.cos(d.facing) * OUTSIDE];
      const spot = grid.nearest(x, z, 6) ?? [x, z];
      leave();
      teleport(spot[0], spot[1], d.facing + Math.PI);
    } else if (beside) {
      const into = beside;
      const { door: d } = into;
      const [x, z] = [d.x + Math.sin(d.facing) * INSIDE, d.z + Math.cos(d.facing) * INSIDE];
      const spot = interiors.grid(into, 0).nearest(x, z, 3) ?? [x, z];
      teleport(spot[0], spot[1], d.facing);
      beside = null;
      enter(into);
    }
    sounds.land();
    publishDoor();
  }
  /** Rooms nearby: their data loads, and, close to the street, the nearest is built ahead. */
  let prewarming = 0;
  const prewarmed = new Set<Room>();
  function nearRooms(): void {
    const w = avatar.walker;
    if (!interiors) {
      const close = landmarks.some(([x, z]) => Math.hypot(x - w.x, z - w.z) < ROOMS_NEAR);
      const due = !loadingInteriors && performance.now() >= roomsRetry;
      if (close && shown === 'figure' && due) void loadRooms().catch(() => {});
      return;
    }
    const near = !room && prewarm ? interiors.beside(w.x, w.z, PREWARM_NEAR) : undefined;
    // Beside a building you can go into, from any side, on foot: Enter says so.
    const by =
      !room && avatar.mode === 'foot' ? (interiors.beside(w.x, w.z, PERIMETER) ?? null) : null;
    if (by !== beside) {
      beside = by;
      publishDoor();
    }
    if (!near || prewarming || prewarmed.has(near)) return;
    prewarming = idle(() => {
      prewarming = 0;
      if (disposed) return;
      interiors?.prewarm(near);
      prewarmed.add(near);
    });
  }

  /** The other players, as last given, and a pose to read them into for the full map. */
  let crowd: Roster | null = null;
  /** The full map is open, so the roster, when it comes, is told to send its dots. */
  let mapOpen = false;
  const seen: PlayerPose = { x: 0, z: 0, heading: 0, speed: 0, mode: 'foot', place: '', floor: 0 };

  /** The route being walked was picked (a tap, the map); a bike's own short ones aren't. */
  let picked = false;
  let reported: Float32Array | null = null;
  /** Tells the host when the picked route changes, or it's gone. Called every frame walked. */
  function syncRoute(): void {
    const { route } = avatar.walker;
    if (!route) picked = false;
    const current = picked ? route : null;
    if (current === reported) return;
    reported = current;
    host.onRoute?.(current && (trip?.to ?? [current.at(-2)!, current.at(-1)!]));
  }

  function clearRoute(): void {
    hint.visible = false;
    hint.geometry.dispose();
    marker = undefined;
  }

  /**
   * Walks (or rides) along a route, on the street or the room's floor, to the first of the places
   * round (x, z), within `reach`, that one leads to: the spot itself if it's open, then the
   * nearest open ground, spread out so a walled-in garden or the far side of a fence is passed
   * over for the pavement beside it. Whether one did.
   */
  function walkTo(x: number, z: number, reach = 3, most = TRIES): boolean {
    const w = avatar.walker;
    const here = underfoot();
    const by = room && interiors ? interiors.router(room, avatar.floor) : router;
    const from = here.walkable(w.x, w.z) ? [w.x, w.z] : here.nearest(w.x, w.z, 4);
    if (!from) return false;
    const places = here.around(x, z, reach, most);
    if (here.walkable(x, z)) places.unshift([x, z]);
    for (const [tx, tz] of places.slice(0, most)) {
      const route = by.route(from[0]!, from[1]!, tx, tz, loose);
      if (route) {
        follow(route);
        return true;
      }
    }
    return false;
  }

  function follow(route: Float32Array): void {
    followRoute(avatar.walker, route);
    sounds.routeStart();
    hint.geometry.dispose();
    const floorY = feet[1];
    marker = routeMarker(route, room ? () => floorY : ground);
    hint.geometry = marker.geometry;
    hint.visible = true;
    picked = true;
    wake();
  }

  function refuse(x: number, z: number, why: Refusal): void {
    nope = 0;
    [nopeAt[0], nopeAt[1]] = [x, z];
    sounds.blocked();
    host.onBlocked?.(why);
    wake();
  }

  // What a tap touched, read back from a small render of the scene around it (pick.ts): the
  // exact roof, wall, tree, bench, floor or street the person sees under it and round it.
  const pickTarget = new WebGLRenderTarget(PICK_SIDE, PICK_SIDE);
  const pickDepth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  const pixels = new Uint8Array(PICK_SIDE * PICK_SIDE * 4);
  const points = new Float32Array(PICK_SIDE * PICK_SIDE * 3);
  const clearColor = new Color();
  const unprojected = new Vector3();
  /** Fills `points` with the surface under the square of pixels centred on (x, y), in CSS px. */
  function pickAround(x: number, y: number, width: number, height: number): void {
    const { renderer } = host;
    const [target, shadows] = [renderer.getRenderTarget(), renderer.shadowMap.needsUpdate];
    renderer.getClearColor(clearColor);
    const clearAlpha = renderer.getClearAlpha();
    const square = PICK_SIDE * PICK_STEP;
    camera.setViewOffset(width, height, x - square / 2, y - square / 2, square, square);
    scene.overrideMaterial = pickDepth;
    camera.layers.disable(PUFF_LAYER);
    renderer.shadowMap.needsUpdate = false;
    renderer.setRenderTarget(pickTarget);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(pickTarget, 0, 0, PICK_SIDE, PICK_SIDE, pixels);
    renderer.setRenderTarget(target);
    renderer.setClearColor(clearColor, clearAlpha);
    renderer.shadowMap.needsUpdate = shadows;
    scene.overrideMaterial = null;
    camera.layers.enable(PUFF_LAYER);
    camera.clearViewOffset();
    for (let row = 0; row < PICK_SIDE; row++) {
      // Read back bottom row first; `points` is top row first, as `meant` wants.
      const from = (PICK_SIDE - 1 - row) * PICK_SIDE;
      const py = y + (row - (PICK_SIDE - 1) / 2) * PICK_STEP;
      for (let col = 0; col < PICK_SIDE; col++) {
        const [i, o] = [(from + col) * 4, (row * PICK_SIDE + col) * 3];
        const depth = unpackDepth(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixels[i + 3]!);
        if (Number.isNaN(depth)) {
          points[o] = Number.NaN;
          continue;
        }
        const px = x + (col - (PICK_SIDE - 1) / 2) * PICK_STEP;
        unprojected.set((px / width) * 2 - 1, 1 - (py / height) * 2, depth * 2 - 1);
        unprojected.unproject(camera);
        [points[o], points[o + 1], points[o + 2]] = [unprojected.x, unprojected.y, unprojected.z];
      }
    }
  }
  const meantTests: MeantTests = {
    ground: (x, y, z) => y < ground(x, z) + ON_GROUND,
    open: (x, z) => grid.walkable(x, z),
    building: (x, z) => grid.buildingHeight(x, z) > 0,
  };
  /**
   * The place a tap on a building, touched at (x, z), means: beside it (or the block it's part
   * of), where it shows round the tap (the front, not the courtyard or the street behind), the
   * nearest the tap on the screen. Failing that, the place beside it nearest the spot touched.
   */
  function besideBuilding(x: number, z: number): [number, number] | null {
    const places = grid.besideBuilding(x, z, BESIDE_REACH);
    const cells = new Set(places.map(([px, pz]) => grid.cellAt(px, pz)));
    const { cols } = grid;
    const besideIt = (px: number, py: number, pz: number) => {
      if (!meantTests.ground(px, py, pz) || !grid.walkable(px, pz)) return false;
      // Its cell or one round it: the depth's pixels and the grid's cells don't quite agree.
      const cell = grid.cellAt(px, pz);
      for (let dr = -cols; dr <= cols; dr += cols) {
        for (let dc = -1; dc <= 1; dc++) if (cells.has(cell + dr + dc)) return true;
      }
      return false;
    };
    const inSight = nearestShown(points, PICK_SIDE, besideIt);
    if (inSight) return inSight;
    let best = Infinity;
    let found: [number, number] | null = null;
    for (const [px, pz] of places) {
      const d = Math.hypot(px - x, pz - z);
      if (d < best) [best, found] = [d, [px, pz]];
    }
    return found;
  }
  /** How far a spot is from where the avatar stands (m). */
  const away = (x: number, z: number) => Math.hypot(x - avatar.walker.x, z - avatar.walker.z);
  /** Where to go on from a room's door, for a tap outside the room; dropped by any other. */
  let onward: [number, number] | null = null;
  /** Going further than one route reaches: the spot at the end, and where this leg stops. */
  let trip: { to: [number, number]; leg: [number, number]; legs: number } | null = null;

  function tap(clientX: number, clientY: number): void {
    asked++;
    onward = null;
    trip = null;
    bikes?.cancel();
    if (bikes?.busy) return;
    const rect = canvas.getBoundingClientRect();
    pickAround(clientX - rect.left, clientY - rect.top, rect.width, rect.height);
    const mid = ((PICK_SIDE * PICK_SIDE - 1) / 2) * 3;
    const [tx, ty, tz] = [points[mid]!, points[mid + 1]!, points[mid + 2]!];
    // On the avatar itself: stop where it is.
    if (away(tx, tz) < ON_AVATAR && ty > feet[1] + 0.3 && ty < feet[1] + 3) {
      avatar.walker.route = null;
      clearRoute();
      syncRoute();
      return;
    }
    // In a room: the floor under what it touched, or, outside the room, out through its door
    // and on to the place meant there.
    if (room && interiors && !Number.isNaN(tx) && inRing(interiors.footprint(room), tx, tz)) {
      if (!walkTo(tx, tz, TAP_REACH)) refuse(tx, tz, 'closed');
      return;
    }
    const found = meant(points, PICK_SIDE, meantTests);
    const at = found === 'building' ? besideBuilding(tx, tz) : found;
    if (!at) {
      if (!Number.isNaN(tx)) refuse(tx, tz, 'closed');
      return;
    }
    if (away(...at) > ROUTE_REACH) refuse(...at, 'far');
    else if (room) leaveFor(at, room);
    else routeOrRefuse(...at);
  }

  /**
   * A route to a spot, or says why there's none. One the router can't find so far off is a long
   * way round: too far, not nowhere, and not worth another search (a failed one fills its window).
   */
  function routeOrRefuse(x: number, z: number): boolean {
    const far = away(x, z) > DETOUR;
    if (walkTo(x, z, TAP_REACH, far ? 1 : TRIES)) return true;
    refuse(x, z, far ? 'far' : 'closed');
    return false;
  }

  /**
   * A route to a spot however far it is, in legs one route long: each leg walked, the next is set
   * off on (`nextLeg`). Says why if there's no way even to start. A route's own limit (the
   * router's window) shouldn't be something a person walking across town has to know.
   */
  function headFor(x: number, z: number, legs = 0): boolean {
    const w = avatar.walker;
    for (const [lx, lz, final] of legsToward(w.x, w.z, x, z)) {
      if (!walkTo(lx, lz, TAP_REACH, final ? TRIES : 1)) continue;
      const end = w.route!;
      trip = final ? null : { to: [x, z], leg: [end.at(-2)!, end.at(-1)!], legs };
      return true;
    }
    trip = null;
    refuse(x, z, legs ? 'closed' : 'far');
    return false;
  }

  /** A leg walked to its end sets off on the next; stopped short (the keys took over), it's over. */
  function nextLeg(): void {
    if (!trip || avatar.walker.route) return;
    const { to, leg, legs } = trip;
    trip = null;
    if (away(...leg) >= LEG_ARRIVED) return;
    if (legs < MAX_LEGS) headFor(...to, legs + 1);
    else refuse(...to, 'far');
  }

  /** In a room: out through its door, and on to `at` once outside. */
  function leaveFor(at: [number, number], { door }: { door: Room['door'] }): void {
    const out = [door.x - Math.sin(door.facing) * 0.8, door.z - Math.cos(door.facing) * 0.8];
    if (walkTo(out[0]!, out[1]!, TAP_REACH)) onward = at;
    else refuse(...at, 'closed');
  }

  function wake(): void {
    if (frame || disposed) return;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }

  function tick(now: number): void {
    ticking = true;
    try {
      advance(now);
    } finally {
      ticking = false;
    }
  }

  function advance(now: number): void {
    frame = 0;
    const elapsed = Math.max(0, (now - last) / 1000);
    const dt = Math.min(0.05, elapsed);
    last = now;
    const w = avatar.walker;

    const holding = bikes?.busy ?? false;
    const [sx, sz] = holding ? [0, 0] : screenSteer(host.yaw(), keyRight, keyUp);
    for (let n = ticks(sim, elapsed); n > 0; n--) {
      remember();
      const routed = w.route !== null;
      stirring = stepAvatar(avatar, STEP, sx, sz, underfoot(), running);
      crossings();
      if (avatar.mode === 'foot') sounds.stride(w.phase, w.speed, runBlend(w.speed));
      if (routed && !w.route && !sx && !sz) sounds.routeEnd();
    }
    // Nobody sees an idle figure from far out: it stands still there.
    if (shown !== 'figure' || reducedMotion) w.still = Math.max(w.still, 1e3);
    // A frame too short for a step (the first after a tap often is: its time stamp comes before
    // the tap's) keeps what the last step said, and a route or keys just given keep it going too:
    // otherwise the path is drawn and the loop stops before the first step.
    let busy = stirring || w.route !== null || sx !== 0 || sz !== 0;
    if (bikes) busy = bikes.frame(avatar, elapsed) || busy;
    else if (
      performance.now() >= bikesRetry &&
      nearestParked(scene.children, w.x, w.z, RIDE_NEAR)
    ) {
      void loadBikes();
    }
    if (bikes && bikes.state !== ride) host.onRide?.((ride = bikes.state));
    nearRooms();
    // How fast it goes, for the smoke test, written only as it changes by a step worth noting.
    if (Math.abs(w.speed - shownSpeed) >= 0.5 || (w.speed === 0 && shownSpeed !== 0)) {
      shownSpeed = w.speed;
      canvas.dataset.speed = w.speed.toFixed(1);
    }
    if (holding) remember();

    // Drawn between the last two steps, so motion is even whatever the frame rate.
    const blend = holding ? 1 : sim.left / sim.step;
    const x = prevX + (w.x - prevX) * blend;
    const z = prevZ + (w.z - prevZ) * blend;
    const heading = Math.atan2(
      Math.sin(prevHeading) + (Math.sin(w.heading) - Math.sin(prevHeading)) * blend,
      Math.cos(prevHeading) + (Math.cos(w.heading) - Math.cos(prevHeading)) * blend,
    );
    const phase =
      prevPhase + Math.atan2(Math.sin(w.phase - prevPhase), Math.cos(w.phase - prevPhase)) * blend;
    place(x, z, heading, phase, dt);
    // The others step here; the frame drawn places them (`detail`), as it does on a pan.
    busy = players.step(now, dt) || busy;
    tell();

    if (Math.hypot(w.x - publishedAt[0], w.z - publishedAt[1]) >= 1) publish();
    nextLeg();
    if (marker && !w.route) clearRoute();
    syncRoute();
    if (marker) hint.geometry.setDrawRange(passedVertices(marker, w.travelled), Infinity);

    // The camera: pinned, after the avatar, a little ahead of where it goes; else to a place.
    const lead = reducedMotion ? 0 : w.speed * LEAD;
    if (controls.pinned)
      [aim.x, aim.z] = [x + Math.sin(heading) * lead, z + Math.cos(heading) * lead];
    const to = controls.pinned ? aim : focus;
    if (to) {
      const t = controls.target;
      [goal.x, goal.z] = [t.x, t.z];
      gliding = recentre(goal, to.x, to.z, reducedMotion ? 1 : dt);
      if (goal.x !== t.x || goal.z !== t.z) {
        t.set(goal.x, ground(goal.x, goal.z), goal.z);
        host.placeCamera();
      }
      if (!gliding && to === focus) focus = null;
      busy ||= gliding;
    }
    if (!Number.isNaN(zoomGoal)) {
      const z0 = camera.zoom;
      camera.zoom = Math.exp(
        decay(Math.log(z0), Math.log(zoomGoal), reducedMotion ? 0 : ZOOM_EASE, dt),
      );
      if (Math.abs(camera.zoom - zoomGoal) < 1e-3) [camera.zoom, zoomGoal] = [zoomGoal, Number.NaN];
      camera.updateProjectionMatrix();
      host.placeCamera();
      busy = true;
    }

    nope += elapsed;
    busy = placeRefusal() || busy;

    host.render(looping);
    looping = busy;
    // Zooming in may have woken it already, from inside the render above.
    if (busy && !frame) frame = requestAnimationFrame(tick);
    else publish();
  }

  /** Poses and places the figure where the avatar is drawn. */
  function place(x: number, z: number, heading: number, phase: number, dt: number): void {
    const w = avatar.walker;
    const step = host.groundAt(x, z) - ground(x, z);
    kerb = reducedMotion || !onFeet ? step : decay(kerb, step, KERB_EASE, dt);
    onFeet = true;
    // In a room, its floor: up the ramp of a stair, or over the threshold from the street's.
    const floor =
      room && interiors ? interiors.standing(room, avatar.floor, x, z).y : ground(x, z) + kerb;
    avatar.rise = floor - host.groundAt(x, z);
    [feet[0], feet[1], feet[2]] = [x, floor, z];
    const onFoot = avatar.mode === 'foot' || (bikes?.busy ?? false);
    // Drawn at every zoom, under its diamond when that's too far out to read it.
    character.mesh.visible = onFoot;
    if (!character.mesh.visible) return;
    applyPose(
      character,
      poseAt(pose, w.speed, phase, w.still, !reducedMotion, w.turning, 0, w.surge, heading),
    );
    character.mesh.position.set(x, floor + FEET_Y, z);
    character.mesh.rotation.y = heading;
  }

  /** A refused spot's greyed marker shaking its head, one size on screen. Whether it plays. */
  function placeRefusal(): boolean {
    if (!(nope < NOPE)) {
      refusal.visible = false;
      return false;
    }
    const [x, z] = nopeAt;
    const y = host.groundAt(x, z) + 0.02;
    const radius = markerRadius(span);
    const shake = Math.sin(nope * 38) * Math.exp(-5 * nope) * radius * 0.35;
    refusal.position.set(x + shake, y, z);
    refusal.scale.setScalar(radius * markerDrop(nope));
    refusal.material.opacity = 1 - (nope / NOPE) ** 3;
    // From high up the marker shows over the city, as a map refusal does; near the street it lies
    // on the ground among what stands there.
    refusal.material.depthTest = span < NEAR_SPAN;
    refusal.visible = true;
    return true;
  }

  /** What the other players are told: where the avatar is, as it changes (the app throttles it). */
  const told: PlayerPose = {
    x: Number.NaN,
    z: 0,
    heading: 0,
    speed: 0,
    mode: 'foot',
    place: '',
    floor: 0,
  };
  function tell(): void {
    if (!host.onMove) return;
    const w = avatar.walker;
    const where = room?.id ?? '';
    if (
      w.x === told.x &&
      w.z === told.z &&
      w.heading === told.heading &&
      w.speed === told.speed &&
      avatar.mode === told.mode &&
      where === told.place &&
      avatar.floor === told.floor
    ) {
      return;
    }
    Object.assign(told, {
      x: w.x,
      z: w.z,
      heading: w.heading,
      speed: w.speed,
      mode: avatar.mode,
      place: where,
      floor: avatar.floor,
    });
    host.onMove({ ...told });
  }

  /**
   * Where the avatar stands, each metre and once it stands still: for the smoke test and anyone
   * debugging.
   */
  const publishedAt: [number, number] = [Number.NaN, Number.NaN];
  function publish(): void {
    const w = avatar.walker;
    [publishedAt[0], publishedAt[1]] = [w.x, w.z];
    canvas.dataset.walker = `${w.x.toFixed(1)} ${w.z.toFixed(1)}`;
  }
  publish();
  place(avatar.walker.x, avatar.walker.z, avatar.walker.heading, 0, 0);
  tell();

  /** Pins the camera to the avatar: it glides back to it and keeps it in the middle. */
  function pinCamera(): void {
    controls.pinned = true;
    focus = null;
    wake();
  }

  return {
    get animating() {
      return frame !== 0 || ticking;
    },
    get state() {
      return avatarState(avatar);
    },
    get calls() {
      return (character.mesh.visible ? 2 : 0) + players.calls;
    },
    others(roster) {
      crowd = roster;
      if (mapOpen) roster?.fullMap(true);
      unlisten();
      // News from far off, or from nobody the view would draw, is worth no frame.
      unlisten = roster
        ? roster.listen(() => {
            if (players.drawn > 0 || players.near(performance.now(), playersView())) wake();
          })
        : noop;
      players.use(roster);
      wake();
    },
    dress(next) {
      outfit = next;
      const geometry = characterGeometry(outfit);
      character.mesh.geometry.dispose();
      character.mesh.geometry = geometry;
      character.xray.geometry = geometry;
      xray.color.setHex(outfit.shirt);
      bikes?.dress(outfit);
      wake();
    },
    placeAt(x, z, heading) {
      // Only ever on foot in the street: it comes back where it left, never mid-ride or mid-room.
      if (room || avatar.mode !== 'foot' || bikes?.busy) return;
      const spot = grid.nearest(x, z, 30);
      if (!spot) return;
      asked++;
      teleport(spot[0], spot[1], heading);
    },
    feet,
    steer(right, up) {
      [keyRight, keyUp] = [right, up];
      if (!right && !up) return;
      asked++;
      bikes?.cancel();
      pinCamera();
    },
    run(on) {
      running = on;
    },
    tap,
    lookAt(x, z) {
      controls.pinned = false;
      focus = { x, z };
      if (camera.zoom < PLACE_ZOOM) zoomGoal = PLACE_ZOOM;
      wake();
    },
    recentre: pinCamera,
    comeDown() {
      pinCamera();
      if (camera.zoom < PLACE_ZOOM) zoomGoal = PLACE_ZOOM;
    },
    letGo() {
      focus = null;
      zoomGoal = Number.NaN;
    },
    door: throughDoor,
    ride(action) {
      const request = action === 'bell' ? asked : ++asked;
      loadBikes().then(
        (loaded) => {
          if (request !== asked || disposed) return;
          const chores = loaded.act(action, avatar);
          // Out of reach after all: walking to it is given up.
          if (chores.walkTo) {
            if (walkTo(...chores.walkTo)) picked = false;
            else loaded.cancel();
          }
          wake();
        },
        () => {}, // nothing to ride: the street stays the street
      );
    },
    rooms: () =>
      loadRooms().then((loaded) =>
        loaded.rooms.map(({ id, name, door }) => ({ id, name, x: door.x, z: door.z })),
      ),
    detail(detail, height) {
      span = height;
      prewarm = detail.prewarm;
      // The others, placed for every frame drawn, the camera's too: their tags follow a pan.
      players.place(playersView(detail.avatar === 'figure'));
      // How many are drawn, for the smoke test.
      if (canvas.dataset.players !== String(players.drawn)) {
        canvas.dataset.players = String(players.drawn);
      }
      if (detail.avatar === shown) return;
      shown = detail.avatar;
      const w = avatar.walker;
      place(w.x, w.z, w.heading, w.phase, 0);
      // Close enough for figures now: one loop, to catch up with who joined while they weren't.
      if (shown === 'figure') wake();
    },
    goTo(x, z) {
      asked++;
      onward = null;
      bikes?.cancel();
      if (bikes?.busy) return;
      // A mark can sit inside a block: the street nearest it is where to go.
      const at = grid.nearest(x, z, NAVIGATE_SNAP, true) ?? [x, z];
      trip = null;
      if (room) leaveFor(at, room);
      else if (!headFor(...at)) return;
      pinCamera();
    },
    cancelRoute() {
      const w = avatar.walker;
      trip = null;
      if (!w.route) return;
      w.route = null;
      clearRoute();
      syncRoute();
      wake();
    },
    presences() {
      const w = avatar.walker;
      const now = performance.now();
      const list: Presence[] = [
        { id: 'me', x: w.x, z: w.z, heading: Math.PI - w.heading, self: true },
      ];
      const known = new Set<number>();
      for (const { id } of crowd?.entries() ?? []) {
        if (crowd?.pose(id, now, seen)) {
          known.add(id);
          list.push({
            id: String(id),
            x: seen.x,
            z: seen.z,
            heading: Math.PI - seen.heading,
            self: false,
          });
        }
      }
      // Everyone further off, as the server last said.
      for (const { id, x, z } of crowd?.dots() ?? []) {
        if (!known.has(id)) list.push({ id: String(id), x, z, heading: 0, self: false });
      }
      return list;
    },
    fullMap(on) {
      mapOpen = on;
      crowd?.fullMap(on);
    },
    dispose() {
      disposed = true;
      unlisten();
      players.dispose();
      cancelAnimationFrame(frame);
      cancelIdle(prewarming);
      bikes?.dispose();
      interiors?.dispose();
      for (const mesh of [character.mesh, hint, refusal]) scene.remove(mesh);
      pickTarget.dispose();
      pickDepth.dispose();
      hint.geometry.dispose();
      hint.material.dispose();
      refusal.geometry.dispose();
      refusal.material.dispose();
      body.dispose();
      xray.dispose();
    },
  };
}
