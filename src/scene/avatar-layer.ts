import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  GreaterDepth,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  Raycaster,
  Vector2,
} from 'three';
import type { Material, OrthographicCamera, Scene, Texture } from 'three';

import { createWalkSounds } from '../audio/walking.ts';
import { LANDMARK_FOOTPRINTS } from '../data/area.ts';
import { inRing } from '../data/cell-grid.ts';
import type { City } from '../data/city.ts';
import { DOOR_HALF } from '../data/room-grid.ts';
import type { Room } from '../data/rooms.ts';
import { Router } from '../data/route.ts';
import type { Terrain } from '../data/terrain.ts';
import { WalkGrid, pickWalkable } from '../data/walkable.ts';
import { avatarState, createAvatar, stepAvatar } from './avatar.ts';
import type { Avatar, AvatarState } from './avatar.ts';
import type { Bikes, RideAction, RideState } from './bikes.ts';
import { createCharacterMaterial, createXrayMaterial } from './character-material.ts';
import type { Fade } from './character-material.ts';
import { CHARACTER_SCALE, applyPose, createCharacter, poseAt, restPose } from './character.ts';
import { loose } from './collide.ts';
import { BAYER } from './facade-material.ts';
import { LEAD, recentre, screenSteer } from './follow.ts';
import { loadInteriors } from './interiors.ts';
import type { Interiors } from './interiors.ts';
import type { Detail } from './lod.ts';
import { MAX_ZOOM, MIN_ZOOM } from './lod.ts';
import type { MapControls } from './map-controls.ts';
import { markerDrop, markerGeometry, markerRadius } from './marker.ts';
import { MeshBuilder, linearVertexColors } from './mesh-builder.ts';
import type { LineBuilder } from './mesh-builder.ts';
import { clock, decay, ticks } from './motion.ts';
import { OUTLINE } from './palette.ts';
import { nearestParked } from './parked.ts';
import { passedVertices, routeMarker } from './route-marker.ts';
import type { RouteMarker } from './route-marker.ts';
import { walkSolids } from './solids.ts';
import { STEP, runBlend } from './walker.ts';

/**
 * The avatar in the scene: its figure, its route hint, a refused spot's marker, the camera
 * keeping it in view, its bikes and the rooms it walks into. A chunk of its own, loaded once the
 * first frame is drawn; the avatar it draws is on Grote Markt from the start.
 *
 * One way to move, on foot or on a bike: W A S D by the screen (Shift runs or sprints), or a tap
 * on the ground within ROUTE_REACH, which walks or rides it there along a route. The one thing
 * that puts it anywhere at once is a building's door: beside a building with a room inside, from
 * any side, Enter takes it in, and Enter again back out to its door. The camera is pinned to it, gliding after it, until the person drags the map;
 * then the view is theirs until Space (or W A S D, or the edge arrow) brings it back. Animates
 * only while something moves; otherwise the viewer renders on demand. The logic is pure and
 * tested elsewhere (avatar.ts, follow.ts, walker.ts, the grids and routes); this is the glue.
 */

/** How far the nearest walkable spot may lie from a tap (m). */
const TAP_REACH = 8;
/** A tap further than this from the avatar (m) is too far to go to: it walks, never jumps. */
const ROUTE_REACH = 250;
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
/** After the rooms failed to load, they are tried again no sooner than this (ms). */
const ROOMS_RETRY_MS = 30_000;

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
  render(): void;
  /** What casts shadows changed: a rack bike taken or put back. */
  shadowsChanged(): void;
  /** A tap the avatar can't go to, and why. */
  onBlocked?(why: Refusal): void;
  /** A bike near enough to ride, riding, or neither. */
  onRide?(state: RideState): void;
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
  /** Where its feet are drawn this frame (m), for the dither in front of it and its arrow. */
  readonly feet: readonly [number, number, number];
  /** Walks toward a direction on screen while held: right and up, each from -1 to 1. */
  steer(right: number, up: number): void;
  /** Runs (or sprints on a bike) while on. */
  run(on: boolean): void;
  /** A tap on the map at client coordinates: walk or ride there, if it's within reach. */
  tap(clientX: number, clientY: number): void;
  /** Takes the camera to a spot (m), down to the street, leaving the avatar where it is. */
  lookAt(x: number, z: number): void;
  /** Pins the camera to the avatar again, gliding back to it. */
  recentre(): void;
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
  const start = grid.nearest(0, 0, 60, true) ?? [0, 0];
  const avatar: Avatar = createAvatar(start[0], start[1], Math.PI);
  // The camera keeps the avatar in the middle from the start.
  controls.pinned = true;

  const fade: Fade = { value: 1 };
  const body = createCharacterMaterial(host.gradientMap, fade);
  const xray = createXrayMaterial(fade);
  const character = createCharacter(body, xray);
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
  /** Whether a tick is under way: its own frame, so the viewer draws none on top of it. */
  let ticking = false;
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
        greaterDepth: GreaterDepth,
        scene,
        canvas,
        body,
        floor: host.groundAt,
        shadowsChanged: host.shadowsChanged,
      });
      bikes.show(shown === 'figure');
      wake();
      return bikes;
    });
    // A failed download is tried again near the next rack.
    loadingBikes.catch(() => (loadingBikes = undefined));
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
        roomsRetry = performance.now() + ROOMS_RETRY_MS;
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
    [controls.minZoom, controls.maxZoom] = [MIN_ZOOM, MAX_ZOOM];
    publishPlace();
    publishDoor();
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

  function clearRoute(): void {
    hint.visible = false;
    hint.geometry.dispose();
    marker = undefined;
  }

  /** Walks (or rides) to a spot along a route, on the street or the room's floor. */
  function walkTo(x: number, z: number): boolean {
    const w = avatar.walker;
    const here = underfoot();
    const by = room && interiors ? interiors.router(room, avatar.floor) : router;
    const from = here.walkable(w.x, w.z) ? [w.x, w.z] : here.nearest(w.x, w.z, 2);
    // A spot the grid has closed (beside a rack, against a wall) is reached by the open cell
    // nearest it.
    const to = here.walkable(x, z) ? [x, z] : here.nearest(x, z, 3);
    const route = from && to && by.route(from[0]!, from[1]!, to[0]!, to[1]!, loose);
    if (!route) return false;
    [w.x, w.z] = [route[0]!, route[1]!];
    w.route = route;
    w.next = 1;
    w.travelled = 0;
    sounds.routeStart();
    hint.geometry.dispose();
    const floorY = feet[1];
    marker = routeMarker(route, room ? () => floorY : ground);
    hint.geometry = marker.geometry;
    hint.visible = true;
    wake();
    return true;
  }

  function refuse(x: number, z: number, why: Refusal): void {
    nope = 0;
    [nopeAt[0], nopeAt[1]] = [x, z];
    sounds.blocked();
    host.onBlocked?.(why);
    wake();
  }

  const raycaster = new Raycaster();
  const ndc = new Vector2();
  /** Where a ray meets the plane at height `y`: (x, z). */
  const onPlane = (y: number): [number, number] => {
    const { origin: o, direction: d } = raycaster.ray;
    const k = d.y < 0 ? (o.y - y) / -d.y : 0;
    return [o.x + d.x * k, o.z + d.z * k];
  };
  /** Within reach of the avatar, or refused as too far. */
  const reachable = (x: number, z: number) => {
    const w = avatar.walker;
    if (Math.hypot(x - w.x, z - w.z) <= ROUTE_REACH) return true;
    refuse(x, z, 'far');
    return false;
  };
  function tap(clientX: number, clientY: number): void {
    asked++;
    bikes?.cancel();
    if (bikes?.busy) return;
    const rect = canvas.getBoundingClientRect();
    ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const { origin, direction } = raycaster.ray;
    if (direction.y >= 0) return;
    // In a room, where the ray meets its floor: there, or out through the door.
    if (room && interiors) {
      const [x, z] = onPlane(feet[1]);
      const { door } = room;
      const out = !inRing(interiors.footprint(room), x, z);
      const [tx, tz] = out
        ? [door.x - Math.sin(door.facing) * 0.8, door.z - Math.cos(door.facing) * 0.8]
        : [x, z];
      if (!walkTo(tx, tz)) refuse(x, z, 'closed');
      return;
    }
    const spot = pickWalkable(
      grid,
      [origin.x, origin.y, origin.z],
      [direction.x, direction.y, direction.z],
      TAP_REACH,
      false,
      terrain,
    );
    if (!spot) {
      const t = controls.target;
      refuse(...onPlane(ground(t.x, t.z)), 'closed');
      return;
    }
    if (reachable(...spot) && !walkTo(...spot)) refuse(...spot, 'closed');
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
    let moving = false;
    for (let n = ticks(sim, elapsed); n > 0; n--) {
      remember();
      const routed = w.route !== null;
      moving = stepAvatar(avatar, STEP, sx, sz, underfoot(), running);
      crossings();
      if (avatar.mode === 'foot') sounds.stride(w.phase, w.speed, runBlend(w.speed));
      if (routed && !w.route && !sx && !sz) sounds.routeEnd();
    }
    // Nobody sees an idle figure from far out: it stands still there.
    if (shown !== 'figure' || reducedMotion) w.still = Math.max(w.still, 1e3);
    let busy = moving || sx !== 0 || sz !== 0;
    if (bikes) busy = bikes.frame(avatar, elapsed) || busy;
    else if (nearestParked(scene.children, w.x, w.z, RIDE_NEAR)) void loadBikes();
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

    if (Math.hypot(w.x - publishedAt[0], w.z - publishedAt[1]) >= 1) publish();
    if (marker && !w.route) clearRoute();
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

    host.render();
    if (busy) frame = requestAnimationFrame(tick);
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
    character.mesh.visible = shown === 'figure' && onFoot;
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
          if (chores.walkTo && !walkTo(...chores.walkTo)) loaded.cancel();
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
      if (detail.avatar === shown) return;
      shown = detail.avatar;
      bikes?.show(shown === 'figure');
      const w = avatar.walker;
      place(w.x, w.z, w.heading, w.phase, 0);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      cancelIdle(prewarming);
      bikes?.dispose();
      interiors?.dispose();
      for (const mesh of [character.mesh, hint, refusal]) scene.remove(mesh);
      hint.geometry.dispose();
      hint.material.dispose();
      refusal.geometry.dispose();
      refusal.material.dispose();
      body.dispose();
      xray.dispose();
    },
  };
}
