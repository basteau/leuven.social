import {
  Box3,
  BufferGeometry,
  DataTexture,
  DirectionalLight,
  Fog,
  Frustum,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PCFShadowMap,
  RedFormat,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Material, Object3D } from 'three';

import type { City } from '../data/city.ts';
import { clampToArea } from '../data/geometry.ts';
import type { StreetIndex } from '../data/streets.ts';
import { Terrain } from '../data/terrain.ts';
import { addBuilding, footing, partyWalls, wallTop } from './buildings.ts';
import { AWNING } from './facade-codes.ts';
import type { PartyWalls } from './buildings.ts';
import { buildCell, groundRange, partition } from './cells.ts';
import type { Cell, DetailMarks, LandmarkRange } from './cells.ts';
import type { DrawnGround } from './drawn-ground.ts';
import type { buildFurniture, drawnGround } from './furniture.ts';
import {
  createFacadeMaterial,
  createGlowMaterial,
  setNight,
  setPixelSize,
} from './facade-material.ts';
import {
  HOURS_PER_SECOND,
  LAMPS_ON,
  PRESETS,
  daylightAt,
  leuvenHour,
  nextPreset,
  presetAt,
  sunStep,
  wrapHour,
} from './daylight.ts';
import type { Daylight, PresetId } from './daylight.ts';
import { MapControls } from './map-controls.ts';
import { LAYER_Y, slabBottom } from './ground.ts';
import { LINE_LOD } from './paint.ts';
import { LineBuilder, MeshBuilder, corners, geometryBytes } from './mesh-builder.ts';
import type { V3 } from './mesh-builder.ts';
import { OUTLINE, SKY } from './palette.ts';
import {
  depthRange,
  fitShadow,
  lightFrame,
  shadowBias,
  shadowCovers,
  shadowNeeds,
  shadowPoint,
} from './shadow-fit.ts';
import type { ShadowSquare } from './shadow-fit.ts';
import { applyShadowChunks } from './shadow-filter.ts';
import { SPIN_EASE, spinStep } from './spin.ts';
import { minZoomFor } from './zoom-limit.ts';
import type { Presence } from '../data/presence.ts';
import { isTap } from './tap.ts';
import type { Spin } from './spin.ts';
import { terraceParasols } from './terraces.ts';
import type { AvatarLayer, Refusal, RoomPlace } from './avatar-layer.ts';
import type { Outfit } from './character.ts';
import type { PlayerPose } from './crowd.ts';
import type { Roster } from './players.ts';
import { createScaler, pixelRatio } from './resolution.ts';
import type { RideAction, RideState } from './bikes.ts';
import {
  CAMERA_DISTANCE,
  MAX_ZOOM,
  MIN_ZOOM,
  PITCH,
  SPANS,
  VIEW_HEIGHT,
  detailAt,
  fogRange,
  spanOf,
} from './lod.ts';
import type { Detail } from './lod.ts';

export type { RideAction, RideState } from './bikes.ts';
export type { Refusal, RoomPlace } from './avatar-layer.ts';
export type { Outfit } from './character.ts';
export type { PlayerPose } from './crowd.ts';
export type { Roster, RosterEntry } from './players.ts';

export interface ViewerOptions {
  canvas: HTMLCanvasElement;
  city: City;
  reducedMotion: boolean;
  /** A tap the avatar can't go to (no ground there, or too far): a greyed marker shakes too. */
  onBlocked?: (why: Refusal) => void;
  /** The avatar's code couldn't be downloaded (it loads once the first frame is drawn). */
  onAvatarUnavailable?: () => void;
  /**
   * Where the avatar is on the canvas (CSS px from its top left, possibly off it), and whether
   * its figure is drawn there; called whenever either changes, for its arrow.
   */
  onAvatarAt?: (x: number, y: number, figure: boolean) => void;
  /** The street or square under the avatar changed (null: none, or the view too far out). */
  onStreetChange?: (name: string | null) => void;
  /** A bike is near enough to ride, or being ridden, or neither any more. */
  onRideChange?: (state: RideState) => void;
  /** The avatar went into a room (its name and floor's), onto another floor, or out (null). */
  onPlaceChange?: (place: { room: string; floor: string } | null) => void;
  /** The rooms couldn't load: a sentence for a person. Their doors stay shut. */
  onRoomsUnavailable?: (message: string) => void;
  /** A building you can go into is beside the avatar (`inside` false), it's in one, or neither. */
  onDoor?: (door: { room: string; inside: boolean } | null) => void;
  /** Which way the view looks, clockwise from north (radians), whenever it turns. */
  onHeading?: (heading: number) => void;
  /** The light changed: a new time of day, or the day passing. The app paints the sky from it. */
  onDaylight?: (light: Daylight) => void;
  /** Where the other players' name tags go: an element laid over the canvas. */
  tags?: HTMLElement;
  /** Where the avatar is and what it's doing, whenever that changes: for the other players. */
  onMove?: (state: PlayerPose) => void;
  /** A route to a picked spot began (its end, local metres) or ended (null). */
  onRoute?: (target: readonly [number, number] | null) => void;
}

export interface ViewerStats {
  drawCalls: number;
  triangles: number;
}

export interface Viewer {
  rotate(direction: 1 | -1): void;
  /**
   * Keeps turning while a turn control is held: -1 left, 1 right, 0 lets go. The map then
   * settles on the next quarter view.
   */
  spin(direction: number): void;
  /** Multiplies the zoom, within the controls' limits. */
  zoomBy(factor: number): void;
  resetView(): void;
  /** Walks the avatar toward a direction on screen while held: right and up, each from -1 to 1. */
  steer(right: number, up: number): void;
  /** Runs (or sprints on a bike) instead of walking, while on. */
  run(on: boolean): void;
  /** Pins the camera to the avatar again. */
  recentre(): void;
  /**
   * Takes the camera to a spot on the ground (metres east and south of the middle, as `City` has
   * them), down to the street; the avatar stays where it is.
   */
  lookAt(x: number, z: number): void;
  /** Gets on or off the nearest bike, or rings its bell. */
  ride(action: RideAction): void;
  /** Goes into the building beside the avatar (Enter), or back out of the one it's in. */
  door(): void;
  /** The rooms there are inside the landmarks, for the menu (their data loads now if need be). */
  rooms(): Promise<RoomPlace[]>;
  /** The other players to draw, kept by the app from the network; null: none. */
  others(roster: Roster | null): void;
  /** Dresses the avatar: its clothes, skin and hair. */
  dress(outfit: Outfit): void;
  /** Puts the avatar back where it was last time, facing `heading` (on foot, in the street). */
  placeAvatar(x: number, z: number, heading: number): void;
  /** The time of day: the preset nearest the hour, and whether the day is passing. */
  timeOfDay(): { preset: PresetId; passing: boolean };
  /** Steps to the next time of day (morning, midday, golden hour, dusk, night) and names it. */
  nextTimeOfDay(): PresetId;
  /** Lets the day pass, an hour every few seconds, or holds it where it is. */
  passTime(on: boolean): void;
  /** Walks (or rides) to a spot along a route, as a tap does, from anywhere in reach. */
  navigateTo(x: number, z: number): void;
  /** Lets go of the route being walked to a picked spot, if any. */
  cancelRoute(): void;
  /** You and the other players, for the full map. Empty until the avatar has loaded. */
  presences(): readonly Presence[];
  /** The end of the route being walked to a picked spot, or null. */
  routeTarget(): readonly [number, number] | null;
  /** The full map covers the canvas (true), or no longer does: everything moves on, undrawn. */
  cover(on: boolean): void;
  stats(): ViewerStats;
  /** Settles once the first frame is drawn, a few tasks after `createViewer` returns. */
  ready: Promise<void>;
  dispose(): void;
}

const ROTATE_MS = 280;
/** The avatar's arrow points this far over its feet (m): just over its head, drawn 1.3× life. */
const OVER_HEAD = 2.7;
/** Street furniture is made ahead for cells this near the view's middle (m). */
const FURNISH_REACH = 700;
/** The street sign looks the name up again once the avatar has moved this far (m). */
const STREET_STEP = 1;
interface CellEntry {
  cell: Cell;
  box: Box3;
  /** Its mesh, outlines and shadow casters once built; empty until then. */
  objects: Object3D[];
  /** Its street furniture, built after the rest (see `furnish`). */
  furniture: Mesh | undefined;
  /** What of it stands tall enough to show at every zoom, if anything does. */
  tall: Mesh | null;
  /** Its shop fronts' awnings, shown with the furniture, if it has any. */
  awnings: Mesh | null;
  /** Its lamps' light, shown at night at every zoom, if it has a lamp. */
  glow: Mesh | null;
  /** Where the rails and the catenary masts end in its outlines, which only show zoomed in. */
  detail: DetailMarks;
  /** Its ground as drawn, read the first time something stands on it there. */
  drawn?: DrawnGround;
  /** Where the trunks, what else casts shadows and the fine road paint start in its mesh. */
  trunksFrom: number;
  shadowFrom: number;
  fineVertices: number;
  /**
   * Where its hero landmarks are in its mesh and outlines, whose index arrays it then keeps, so
   * a room inside one can draw it as nothing while the avatar is in there (`hideLandmark`).
   */
  landmarks: Map<number, LandmarkRange>;
}

const SHADOW_MAP = 2048;
/**
 * Tallest thing in the city (m), and the margin kept around the view for tall roofs: at most a
 * quarter of the view's height, so zoomed in the square stays tight and its texels fine.
 */
const MAX_HEIGHT = 90;
const SHADOW_REACH = 60;
/**
 * From the map, the shadow square is drawn again once its texels are this much coarser than
 * the view needs: 21 cm a texel at zoom 4, where 4× kept the default view's 70 cm.
 */
const SHADOW_COARSER = 2;
/**
 * Layer masks: the view draws layer 0, the shadow pass layer 1. A cell's shadow casters are only
 * on the shadow layer; its furniture joins whichever pass needs it (see `cull`). The lights are
 * on every layer, so a frame that draws only the shadow map can look at layer 2, where nothing
 * else is, and still find the sun.
 */
const VIEW_LAYER = 1 << 0;
const SHADOW_LAYER = 1 << 1;
const LIGHTS_ONLY = 1 << 2;
/**
 * What one frame may draw, as `scripts/smoke.ts` checks it. A shadow redraw that would take its
 * frame past this gets a frame of its own, and the view follows on the next.
 */
const FRAME_CALLS = 160;
const FRAME_TRIANGLES = 1_150_000;
/** Frames a second the map draws while the day passes (a little under). */
const LIVE_FPS = 32;
/** Time the idle builder may take per slice before handing the main thread back (ms). */
const IDLE_SLICE_MS = 8;
/** Time the first frame's cells may take to build before the page gets a turn (ms). */
const STEP_MS = 40;
/**
 * The largest screen pixel, in metres, at which rails and catenary masts show. Any bigger and
 * a track's two rails come under two pixels apart, so a yard's tracks merge into one dark
 * hatch; the sleeper band alone reads as the track there. In pixels rather than zoom levels,
 * so a dense phone screen gets the detail sooner than a standard one.
 */
const RAIL_PIXEL = 0.5;
const MAST_PIXEL = 0.9;
/** From this many metres a pixel, the outlines are one dense dark mesh: only the surfaces draw. */
const OUTLINE_PIXEL = 1.5;

/** Triangles a mesh draws within its draw range. */
function drawn({ geometry }: Mesh): number {
  const { start, count } = geometry.drawRange;
  return Math.min(count, corners(geometry) - start) / 3;
}

const SCREEN_CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

/** requestIdleCallback where there is one (not in Safari), else the next frame or so. */
const idle = (run: () => void) =>
  'requestIdleCallback' in globalThis
    ? requestIdleCallback(run, { timeout: 500 })
    : (setTimeout(run, 16) as unknown as number);
const cancelIdle = (handle: number) =>
  'cancelIdleCallback' in globalThis ? cancelIdleCallback(handle) : clearTimeout(handle);
/** Hands the main thread back for input and paint, then carries on. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function toonGradient(): DataTexture {
  const steps = new Uint8Array([150, 210, 255]);
  const texture = new DataTexture(steps, steps.length, 1, RedFormat);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export function createViewer(options: ViewerOptions): Viewer {
  const { canvas, city, reducedMotion } = options;
  // Dense screens are smooth already; only standard-density ones pay for multisampling.
  const density = Math.min(globalThis.devicePixelRatio || 1, 2);
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: density < 1.5 });
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  // Hard shadows with a soft rim, each lookup lifted off its surface on the sun's side
  // (shadow-filter.ts).
  applyShadowChunks();
  renderer.shadowMap.type = PCFShadowMap;
  // The city is static, so shadows render once instead of every frame.
  renderer.shadowMap.autoUpdate = false;

  const scene = new Scene();
  // Close in, the far end of the street fades into the horizon's haze (`fogRange`). The fog is
  // always there, far off on the map, so zooming in never recompiles the city's shaders.
  const fog = new Fog(SKY.horizon, 1e7, 1e7 + 1);
  scene.fog = fog;
  const gradientMap = toonGradient();
  // One material for every cell: walls get windows, roads their texture and paint (paint.ts).
  const material = createFacadeMaterial(gradientMap);
  // A mesh without a `facade` attribute (street furniture) reads 0: a plain surface.
  Object.assign(material, { defaultAttributeValues: { facade: [0], lift: [0] } });
  const ink = new LineBasicMaterial({ color: OUTLINE });
  // The lamps' light at night: the same night uniform as the windows.
  const lamps = { value: 0 };
  const glowMaterial = createGlowMaterial(lamps);

  const terrain = new Terrain(city.terrain);

  // Cells are built when they first come into view, and the rest while the page is idle, so
  // the first frame costs what the visible part of the city costs. The city is cut into them
  // after `createViewer` returns (see `ready`).
  let walls: PartyWalls;
  const cells: CellEntry[] = [];
  function cut(): void {
    for (const cell of partition(city, terraceParasols(city))) {
      const [low, high] = groundRange(cell, city.area, terrain, 60);
      cells.push({
        cell,
        // Until it's built, a guess: buildings belong to the cell of their first corner and can
        // overhang it a little, standing on its own ground.
        box: new Box3(
          new Vector3(cell.bounds.minX - 60, low, cell.bounds.minZ - 60),
          new Vector3(cell.bounds.maxX + 60, high + MAX_HEIGHT, cell.bounds.maxZ + 60),
        ),
        objects: [],
        furniture: undefined,
        tall: null,
        awnings: null,
        glow: null,
        detail: { rails: 0, masts: 0 },
        trunksFrom: 0,
        shadowFrom: 0,
        fineVertices: 0,
        landmarks: new Map(),
      });
    }
  }

  /** Vertices and bytes of geometry the built cells hand the GPU. */
  const held = { vertices: 0, bytes: 0 };
  function build(entry: CellEntry): void {
    const { mesh, lines, trunksFrom, shadowFrom, fineVertices, detail, landmarks } = buildCell(
      entry.cell,
      city.area,
      walls,
      terrain,
    );
    Object.assign(entry, { detail, trunksFrom, shadowFrom, fineVertices, landmarks });
    const surfaces = new Mesh(mesh.build({ facade: true }), material);
    surfaces.receiveShadow = true;
    // The shadow pass draws the same buffers from past the ground (and the trunks, see `cull`) up
    // to the fine road paint, as a mesh of its own on the shadow camera's layer: no copy, no
    // extra upload, one draw call as before.
    const shape = new BufferGeometry();
    shape.setAttribute('position', surfaces.geometry.getAttribute('position'));
    shape.setIndex(surfaces.geometry.index);
    // Its bounds are its cell's: computing them would need the array the upload let go of.
    shape.boundingBox = surfaces.geometry.boundingBox;
    shape.boundingSphere = surfaces.geometry.boundingSphere;
    const casters = new Mesh(shape, material);
    casters.castShadow = true;
    casters.layers.mask = SHADOW_LAYER;
    const outlines = new LineSegments(lines.build(), ink);
    // A landmark's range can be drawn as nothing and put back: its index stays, where every other
    // cell lets its arrays go once uploaded.
    if (landmarks.size) {
      for (const g of [surfaces.geometry, outlines.geometry]) g.index!.onUpload(() => {});
    }
    // Cells are culled by their boxes below: three's bounding spheres are far looser.
    entry.objects = [surfaces, outlines, casters];
    hold(surfaces, outlines);
    entry.box.copy(surfaces.geometry.boundingBox!);
    for (const object of entry.objects) object.frustumCulled = false;
    scene.add(surfaces, outlines, casters);
    // Built again (a lost GPU context) while a room is open in it: open again.
    if (hidden && landmarks.has(hidden.id)) hideRange(entry, hidden.id, true);
    if (propsShown) furnish(entry);
  }

  /**
   * A landmark opened for a room inside it: its range in its cell drawn as nothing (zeroed indices,
   * only that range uploaded, what was there kept), so its own walls, cut down, can be drawn by
   * the room instead (`openWalls`). No cell is rebuilt, so going in costs no frame.
   */
  let hidden: { id: number; kept: [ArrayLike<number>, ArrayLike<number>] } | undefined;
  function hideRange(entry: CellEntry, id: number, hide: boolean): void {
    const range = entry.landmarks.get(id);
    const [surfaces, outlines] = entry.objects as [Mesh?, LineSegments?];
    if (!range || !surfaces || !outlines) return;
    const spans = [
      [surfaces.geometry.index!, range.from, range.to],
      [outlines.geometry.index!, range.lineFrom, range.lineTo],
    ] as const;
    for (const [i, [index, from, to]] of spans.entries()) {
      const array = index.array as Uint16Array | Uint32Array;
      if (hide) {
        hidden!.kept[i] = array.slice(from, to);
        array.fill(0, from, to);
      } else array.set(hidden!.kept[i]!, from);
      index.clearUpdateRanges();
      index.addUpdateRange(from, to - from);
      index.needsUpdate = true;
    }
    renderer.shadowMap.needsUpdate = true;
    invalidate();
  }
  const holder = (id: number) => cells.find((e) => e.landmarks.has(id));
  function hideLandmark(id: number | null): void {
    if (hidden?.id === id) return;
    if (hidden) {
      const entry = holder(hidden.id);
      if (entry) hideRange(entry, hidden.id, false);
      hidden = undefined;
    }
    if (id === null) return;
    hidden = { id, kept: [[], []] };
    const entry = holder(id);
    if (entry) hideRange(entry, id, true);
  }
  /**
   * A landmark's walls standing up to `top` (m, in the street's frame) with no roof, written into
   * a room's builders, at the building's own ground; the building's id if there is one.
   */
  function openWalls(id: number, top: number, mesh: MeshBuilder, lines: LineBuilder): boolean {
    const b = city.buildings.find((x) => x.id === id);
    if (!b) return false;
    const base = terrain.base(b.ring);
    mesh.lift = lines.lift = base;
    mesh.foot = footing(terrain, b.ring);
    addBuilding(mesh, lines, b, walls, base, Math.max(1, top - base));
    return true;
  }

  /**
   * The street furniture and monuments are drawn by a chunk of their own (furniture.ts), loaded
   * once the first frame is drawn, or as soon as the view gets close. If it fails to load, the
   * map goes on without them.
   */
  let furnishing:
    { buildFurniture: typeof buildFurniture; drawnGround: typeof drawnGround } | undefined;
  let loadingFurniture: Promise<void> | undefined;
  function loadFurniture(): void {
    loadingFurniture ??= import('./furniture.ts').then(
      (chunk) => {
        furnishing = chunk;
        if (disposed) return;
        // The cells waiting for their furniture get it: those in view now, the rest when idle.
        invalidate();
        idleHandle ||= idle(buildInBackground);
      },
      () => {},
    );
  }

  /**
   * The ground as its cell draws it under a spot (drawn-ground.ts), for the avatar and the bikes
   * to stand on. Read by the furniture chunk; till that loads, the pavement's height.
   */
  let lastCell: CellEntry | undefined;
  function drawnAt(x: number, z: number): number {
    if (!furnishing) {
      loadFurniture();
      return terrain.height(x, z) + LAYER_Y.roads;
    }
    const inside = (e: CellEntry | undefined) =>
      e &&
      x >= e.cell.bounds.minX &&
      x < e.cell.bounds.maxX &&
      z >= e.cell.bounds.minZ &&
      z < e.cell.bounds.maxZ;
    if (!inside(lastCell)) lastCell = cells.find(inside);
    if (!lastCell) return terrain.height(x, z);
    lastCell.drawn ??= furnishing.drawnGround(terrain, lastCell.cell, LAYER_Y);
    return lastCell.drawn.height(x, z);
  }

  /** Makes a mesh of furniture, sharing the city's material (or the glow's), culled by `cull`. */
  function furnitureMesh(
    builder: MeshBuilder,
    striped = false,
    drawnWith: Material = material,
  ): Mesh {
    // No windows: it leaves out the facade attribute and the shader reads its default, but
    // awnings need it for their stripes, and the glow for its fade.
    const mesh = new Mesh(builder.build({ facade: striped }), drawnWith);
    mesh.castShadow = drawnWith === material;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.visible = false; // until `cull` says otherwise
    hold(mesh);
    scene.add(mesh);
    return mesh;
  }

  /**
   * Builds a cell's street furniture. It shows only up close, so it waits for the idle builder,
   * unless the view gets close first (see `prepare`); its tall monuments show at every zoom.
   */
  function furnish(entry: CellEntry): void {
    if (!furnishing) return loadFurniture();
    const { near, bikes, awnings, tall, glow } = furnishing.buildFurniture(entry.cell, {
      MeshBuilder,
      terrain,
      awning: AWNING,
      footing: (b) => footing(terrain, b.ring),
      wallTop,
      layers: LAYER_Y,
    });
    entry.furniture = furnitureMesh(near);
    // Where each parked bike is drawn in it (`PARKED`), and its index kept, so riding can draw
    // a bike taken from its rack as nothing, and put it back.
    entry.furniture.userData.bikes = bikes;
    if (bikes.length) entry.furniture.geometry.index!.onUpload(() => {});
    entry.box.union(entry.furniture.geometry.boundingBox!);
    entry.awnings = awnings && furnitureMesh(awnings, true);
    entry.glow = glow && furnitureMesh(glow, true, glowMaterial);
    entry.tall = tall && furnitureMesh(tall);
    if (entry.tall) {
      entry.box.union(entry.tall.geometry.boundingBox!);
      renderer.shadowMap.needsUpdate = true;
    }
  }

  function hold(...objects: { geometry: BufferGeometry }[]): void {
    for (const { geometry } of objects) {
      held.vertices += geometry.getAttribute('position').count;
      held.bytes += geometryBytes(geometry);
    }
  }

  const sky = new HemisphereLight();
  const sun = new DirectionalLight();
  for (const l of [sky, sun]) l.layers.enableAll();
  scene.add(sky);
  // The sun's frame for the shadow map: golden hour's until the daylight is applied below.
  let light = lightFrame(daylightAt(18).sunDirection);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  sun.shadow.camera.layers.mask = SHADOW_LAYER;
  scene.add(sun, sun.target);
  // The shadow camera's depth spans the whole area, from the slab's underside to the rooftops.
  const cityCorners = city.area.flatMap((a) =>
    [slabBottom(terrain), terrain.highest + MAX_HEIGHT].flatMap((y): V3[] => [
      [a.minX, y, a.minZ],
      [a.maxX, y, a.minZ],
      [a.minX, y, a.maxZ],
      [a.maxX, y, a.maxZ],
    ]),
  );
  let [nearest, farthest] = depthRange(light, cityCorners);
  let shadow: ShadowSquare | undefined;
  /** What the view's span says is worth drawing (lod.ts), as of the last frame. */
  let detail: Detail = detailAt(VIEW_HEIGHT);
  let propsShown = false;
  const shadowFrustum = new Frustum();
  /** Whether cells built since the shadow map was drawn cast into it. */
  let missingCasters = false;
  /** The part of the shadow square the view needs now, in the same light frame. */
  const needFrustum = new Frustum();
  const needProjection = new Matrix4();

  // The one camera, from the whole city down to a street (lod.ts).
  const camera = new OrthographicCamera(-1, 1, 1, -1, 1, CAMERA_DISTANCE * 2);
  /** How far out this window may zoom (zoom-limit.ts). A room keeps its own limits. */
  let farthestZoom = MIN_ZOOM;
  // A drag lets go of the avatar; zooming keeps it in the middle (map-controls.ts).
  const controls = new MapControls(
    camera,
    canvas,
    () => onChange(),
    () => avatar?.letGo(),
  );
  [controls.minZoom, controls.maxZoom] = [MIN_ZOOM, MAX_ZOOM];

  /** Height of the view (m) where it looks: what decides how much detail is worth drawing. */
  const viewSpan = () => spanOf(camera.zoom);

  let yaw = Math.PI / 4;
  function placeCamera(): void {
    const t = controls.target;
    camera.position.set(
      t.x + Math.sin(yaw) * Math.cos(PITCH) * CAMERA_DISTANCE,
      t.y + Math.sin(PITCH) * CAMERA_DISTANCE,
      t.z + Math.cos(yaw) * Math.cos(PITCH) * CAMERA_DISTANCE,
    );
    camera.lookAt(t);
    clampTarget();
    invalidate();
    furnishAhead();
  }

  let width = 0;
  let height = 0;
  const buffer = new Vector2();
  /** Draws fewer pixels while a continuous loop runs slow (resolution.ts). */
  const scaler = createScaler();
  function resize(): void {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    const ratio = pixelRatio(globalThis.devicePixelRatio, scaler.scale);
    if (w === width && h === height && ratio === renderer.getPixelRatio()) return;
    width = w;
    height = h;
    renderer.setDrawingBufferSize(width, height, ratio); // one reallocation, style untouched
    // The buffer is floored to whole pixels, so take the aspect from it: pixels stay square.
    renderer.getDrawingBufferSize(buffer);
    const halfH = VIEW_HEIGHT / 2;
    const halfW = halfH * (buffer.x / buffer.y);
    // How far out the map may go depends on how much ground this window shows (zoom-limit.ts).
    farthestZoom = minZoomFor(buffer.x / buffer.y, VIEW_HEIGHT);
    if (!avatar?.state.place) {
      controls.minZoom = farthestZoom;
      camera.zoom = Math.max(camera.zoom, farthestZoom);
    }
    Object.assign(camera, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
    camera.updateProjectionMatrix();
    invalidate();
  }

  const frustum = new Frustum();
  const viewProjection = new Matrix4();
  const corner = new Vector3();
  const forward = new Vector3();
  const ground = SCREEN_CORNERS.map((): [number, number, number] => [0, 0, 0]);
  /** Points `frustum` at what the view sees now. */
  function aim(): void {
    camera.updateMatrixWorld();
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection);
  }

  /** Builds any cell the camera can see, and fits the shadow map to the view. */
  function prepare(): void {
    aim();
    for (const entry of cells) {
      if (!entry.objects.length && frustum.intersectsBox(entry.box)) build(entry);
    }
    const refit = fitShadowToView();
    // What casts into the view has to exist before the shadow pass draws: build it now, and
    // redraw if that adds to a square already drawn. The rest of the square, its room to pan,
    // waits for the idle builder (see `buildInBackground`).
    let added = false;
    const fromStreet = detail.streetShadows;
    for (const entry of cells) {
      if (!entry.objects.length && needFrustum.intersectsBox(entry.box)) {
        build(entry);
        added = true;
      }
      // Up close, no cell shows without its furniture, nor casts without it from the street.
      const casts = fromStreet && shadowFrustum.intersectsBox(entry.box);
      if (
        propsShown &&
        entry.objects.length &&
        !entry.furniture &&
        (frustum.intersectsBox(entry.box) || casts)
      ) {
        furnish(entry);
        added ||= casts;
      }
    }
    if (refit || added) renderer.shadowMap.needsUpdate = true;
  }

  /**
   * Fits the shadow map to what the view needs, if it doesn't cover it yet (returns whether it
   * moved), and aims `needFrustum` at the part of it that casts into the view.
   */
  function fitShadowToView(): boolean {
    // The ground under the screen's corners, as far as shadows can reach into the view.
    camera.getWorldDirection(forward);
    const span = viewSpan();
    const t = controls.target;
    for (const [i, [x, y]] of SCREEN_CORNERS.entries()) {
      corner.set(x, y, -1).unproject(camera);
      corner.addScaledVector(forward, (t.y - corner.y) / forward.y);
      [ground[i]![0], ground[i]![2]] = [corner.x, corner.z];
    }
    const need = shadowNeeds(light, ground);
    need.half += Math.min(SHADOW_REACH, span / 4);
    detail = detailAt(span);
    propsShown = detail.furniture;
    const refit = !shadow || !shadowCovers(shadow, need, SHADOW_COARSER);
    if (refit) fitShadowTo(need);
    const [dx, dy] = [need.x - shadow!.x, need.y - shadow!.y];
    const { near: front, far: back, matrixWorldInverse } = sun.shadow.camera;
    needFrustum.setFromProjectionMatrix(
      needProjection
        .makeOrthographic(
          dx - need.half,
          dx + need.half,
          dy + need.half,
          dy - need.half,
          front,
          back,
        )
        .multiply(matrixWorldInverse),
    );
    return refit;
  }

  /** Moves the shadow map to a square fitted to what the view needs. */
  function fitShadowTo(need: ShadowSquare): void {
    missingCasters = false;
    shadow = fitShadow(need, SHADOW_MAP);
    sun.position.set(...shadowPoint(light, shadow.x, shadow.y, farthest + 10));
    sun.target.position.set(...shadowPoint(light, shadow.x, shadow.y, 0));
    sun.target.updateMatrixWorld();
    Object.assign(sun.shadow.camera, {
      left: -shadow.half,
      right: shadow.half,
      top: shadow.half,
      bottom: -shadow.half,
      near: 1,
      far: farthest - nearest + 20,
    });
    sun.shadow.camera.updateProjectionMatrix();
    // Biases in texels of this square, so a finer one doesn't lift a bench's shadow away.
    Object.assign(sun.shadow, shadowBias(shadow, SHADOW_MAP, farthest - nearest + 19));
    // The shadow camera's own frustum decides what casts into the square.
    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    sun.shadow.updateMatrices(sun);
    shadowFrustum.copy(sun.shadow.getFrustum());
  }

  /**
   * Shows only the cells in view. On a frame that redraws the shadow map, the casters of the
   * cells that cast into it show too; they sit on the shadow camera's layer, so only it draws them.
   * Returns whether the view and the shadow redraw fit in one frame's budget together, with what
   * the rest of the scene drew on top of the cells last frame (the avatar, the other players).
   */
  function cull(): boolean {
    const shadowPass = renderer.shadowMap.needsUpdate;
    let [calls, triangles] = [0, 0];
    const draw = (mesh: Mesh) => {
      calls++;
      triangles += drawn(mesh);
    };
    const pixel = viewSpan() / buffer.y;
    // From above a trunk's shadow hides in its crown's; close to the street it doesn't, and a
    // lamp's or a bench's shadow is more than a texel.
    const fromStreet = detail.streetShadows;
    for (const entry of cells) {
      const { box, objects, detail: marks, trunksFrom, shadowFrom, fineVertices } = entry;
      const [surfaces, outlines, casters] = objects as [Mesh?, Mesh?, Mesh?];
      if (!surfaces || !outlines || !casters) continue;
      const skip = pixel > MAST_PIXEL ? marks.masts : pixel > RAIL_PIXEL ? marks.rails : 0;
      outlines.geometry.setDrawRange(skip * 2, Infinity);
      const inView = frustum.intersectsBox(box);
      const inked = inView && pixel <= OUTLINE_PIXEL;
      surfaces.visible = inView;
      outlines.visible = inked;
      const casts = shadowPass && shadowFrustum.intersectsBox(box);
      casters.visible = casts;
      const from = fromStreet ? trunksFrom : shadowFrom;
      if (casts) casters.geometry.setDrawRange(from, fineVertices - from);
      if (inView) {
        draw(surfaces);
        if (inked) calls++; // its outlines
      }
      if (casts) draw(casters);
      const { furniture, tall, glow } = entry;
      // At night the lamps' light shows at every zoom, as what reads of a city from above.
      if (glow) {
        glow.visible = inView && daylight.night > LAMPS_ON;
        if (glow.visible) draw(glow);
      }
      if (tall) {
        tall.layers.mask = (inView ? VIEW_LAYER : 0) | (casts ? SHADOW_LAYER : 0);
        tall.visible = inView || casts;
        if (inView) draw(tall);
        if (casts) draw(tall);
      }
      // Up close, `prepare` has built it for every cell in view or casting.
      const furnitureCasts = casts && fromStreet;
      for (const mesh of [furniture, entry.awnings]) {
        if (!mesh) continue;
        mesh.layers.mask = (inView ? VIEW_LAYER : 0) | (furnitureCasts ? SHADOW_LAYER : 0);
        mesh.visible = (inView || furnitureCasts) && propsShown && corners(mesh.geometry) > 0;
        if (mesh.visible && inView) draw(mesh);
        if (mesh.visible && furnitureCasts) draw(mesh);
      }
    }
    counted.calls = calls;
    counted.triangles = triangles;
    // What the figures will take is known now; what else the frame drew besides, from the last.
    const extra = Math.max(others.calls, avatar?.calls ?? 0);
    return calls + extra <= FRAME_CALLS && triangles + others.triangles <= FRAME_TRIANGLES;
  }

  /** What `cull` counted for the cells, and what the frame drew besides them, last frame. */
  const counted = { calls: 0, triangles: 0 };
  const others = { calls: 0, triangles: 0 };
  /**
   * Furniture shows only from zoom 2, where the view is under 300 m tall, so it is made ahead
   * only for cells near the view; further ones get it when the view comes near (`prepare`).
   * That keeps what a visit that never zooms in holds on the GPU to a third less.
   */
  const wantsFurniture = (entry: CellEntry) =>
    !entry.furniture && entry.box.distanceToPoint(controls.target) < FURNISH_REACH;

  // Everything else is built in small slices while the page has nothing better to do.
  let idleHandle = 0;
  function buildInBackground(): void {
    idleHandle = 0;
    const t = controls.target;
    const near = (a: CellEntry, b: CellEntry) =>
      a.box.distanceToPoint(t) - b.box.distanceToPoint(t);
    // The cells first, then the furniture of those within reach of the view, nearest first.
    const waiting = [
      ...cells.filter((entry) => !entry.objects.length).toSorted(near),
      ...cells.filter(wantsFurniture).toSorted(near),
    ];
    const start = performance.now();
    // A frame is drawn only when it would show something new: a cell that came into view, or
    // the shadow map redrawn with all its casters.
    let changed = false;
    for (const entry of waiting) {
      if (performance.now() - start > IDLE_SLICE_MS) break;
      if (entry.objects.length) {
        // Off screen: up close, `prepare` furnishes what shows or casts before it's drawn. The
        // tall monuments it brings show at every zoom.
        if (!entry.furniture) furnish(entry);
        if (!furnishing) break;
        changed ||= entry.tall !== null && frustum.intersectsBox(entry.box);
        continue;
      }
      build(entry);
      missingCasters ||= shadowFrustum.intersectsBox(entry.box);
      changed ||= frustum.intersectsBox(entry.box);
    }
    // Once the last cell that casts into the shadow square exists, redraw it with them all.
    if (
      missingCasters &&
      !cells.some((e) => !e.objects.length && shadowFrustum.intersectsBox(e.box))
    ) {
      missingCasters = false;
      renderer.shadowMap.needsUpdate = true;
      changed = true;
    }
    if (changed) invalidate();
    // What the cells hand the GPU, for the smoke test, whether or not a frame is drawn.
    publish({ vertices: held.vertices, geometryBytes: held.bytes });
    // Cells left to furnish wait for the chunk, which picks the work up again when it arrives.
    const unbuilt = cells.some((e) => !e.objects.length);
    if (unbuilt || (furnishing && cells.some(wantsFurniture))) {
      idleHandle = idle(buildInBackground);
    }
  }

  const peak = { drawCalls: 0, triangles: 0 };
  /** Sets the canvas's data attributes that changed: a DOM write per frame is a style recalc. */
  function publish(values: Record<string, number | boolean>): void {
    for (const key in values) {
      const value = String(values[key]);
      if (canvas.dataset[key] !== value) canvas.dataset[key] = value;
    }
  }
  /**
   * A frame of a continuous loop (walking, riding, a held turn, the day passing): only these say
   * anything about how fast frames can go. A frame drawn on demand follows the last input, and a
   * gap in those is someone pausing. The scaler works on the street; the map stays sharp (`render`).
   */
  function loopFrame(now: number): void {
    if (detail.avatar === 'figure' && !covered && scaler.frame(now)) resize();
    renderNow();
  }

  /** Something opaque is over the whole canvas: time and the avatar go on, nothing is drawn. */
  let covered = false;
  function render(): void {
    if (covered) return;
    // Read from the span, not `detail`: that's last frame's, and one zoom step draws one frame.
    if (scaler.scale < 1 && detailAt(viewSpan()).avatar !== 'figure' && scaler.reset()) resize();
    // World metres per drawing-buffer pixel: how much road paint and texture is worth drawing.
    const span = viewSpan();
    const unit = span / renderer.getDrawingBufferSize(buffer).y;
    setPixelSize(material, unit);
    [fog.near, fog.far] = fogRange(span);
    camera.updateMatrixWorld();
    prepare();
    avatar?.detail(detail, span);
    const shown = detail.avatar === 'figure';
    if (avatar) {
      // Just over the avatar's head on screen, for its arrow to point at without covering the
      // figure: only when that changes by a pixel.
      const [fx, fy, fz] = avatar.feet;
      at.set(fx, fy + OVER_HEAD, fz).project(camera);
      const [ax, ay] = [((at.x + 1) / 2) * width, ((1 - at.y) / 2) * height];
      // Written as "not within a pixel", so the first frame (NaN) says where it is too.
      const still = Math.abs(ax - avatarAt[0]) < 1 && Math.abs(ay - avatarAt[1]) < 1;
      if (shown !== avatarShown || !still) {
        [avatarAt[0], avatarAt[1], avatarShown] = [ax, ay, shown];
        options.onAvatarAt?.(ax, ay, shown);
      }
    }
    // Fine road paint is drawn last in each cell, so a view too far out to see it can stop short.
    for (const { objects, fineVertices } of cells) {
      (objects[0] as Mesh | undefined)?.geometry.setDrawRange(
        0,
        unit > LINE_LOD ? fineVertices : Infinity,
      );
    }
    const together = cull();
    const shadowPass = renderer.shadowMap.needsUpdate;
    // A shadow redraw too big to share a frame with the view draws alone: the view looks at a
    // layer that holds only the lights, and nothing clears or draws on the screen, which keeps
    // showing the last frame. The view follows on the next one.
    const alone = shadowPass && !together;
    if (alone) [camera.layers.mask, renderer.autoClear] = [LIGHTS_ONLY, false];
    renderer.render(scene, camera);
    if (alone) [camera.layers.mask, renderer.autoClear] = [VIEW_LAYER, true];
    // The cost of this very frame and the most any frame cost, for the smoke test and anyone
    // debugging, with what the GPU holds. Frames that redraw the static shadow map (on load, and
    // when the view leaves its square) cost more.
    const { calls, triangles } = renderer.info.render;
    // What the cells don't account for: the figures, their routes and markers, the riders.
    if (!alone) {
      others.calls = Math.max(0, calls - counted.calls);
      others.triangles = Math.max(0, triangles - counted.triangles);
    }
    peak.drawCalls = Math.max(peak.drawCalls, calls);
    peak.triangles = Math.max(peak.triangles, triangles);
    publish({
      drawCalls: calls,
      triangles,
      shadowPass,
      peakDrawCalls: peak.drawCalls,
      peakTriangles: peak.triangles,
      vertices: held.vertices,
      geometryBytes: held.bytes,
      scale: scaler.scale,
      avatar: avatarShown,
      zoom: Math.round(camera.zoom * 100) / 100,
    });
    if (alone) {
      invalidate();
      return;
    }

    signStreet();
    signHeading();
  }

  // The street sign: the street or square under the avatar, while the view is close enough to
  // show it, looked up again only after a step. The lookup arrives with the avatar's chunk.
  let streets: StreetIndex | undefined;
  let signed: string | null = null;
  const signedAt = { x: Number.NaN, z: Number.NaN };
  let avatarShown = false;
  const avatarAt: [number, number] = [Number.NaN, Number.NaN];
  const at = new Vector3();
  function signStreet(): void {
    if (!options.onStreetChange) return;
    let name: string | null = null;
    if (avatar && viewSpan() <= SPANS.figure) {
      const [x, , z] = avatar.feet;
      if (Math.hypot(x - signedAt.x, z - signedAt.z) < STREET_STEP) return;
      [signedAt.x, signedAt.z] = [x, z];
      if (!streets) return;
      name = streets.nameAt(x, z, signed);
    } else signedAt.x = Number.NaN;
    if (name !== signed) options.onStreetChange((signed = name));
  }

  const facing = new Vector3();
  let heading = Number.NaN;
  function signHeading(): void {
    if (!options.onHeading) return;
    camera.getWorldDirection(facing);
    const now = Math.atan2(facing.x, -facing.z);
    if (Math.abs(now - heading) < 1e-3) return;
    options.onHeading((heading = now));
  }

  // The avatar is its own chunk, downloaded once the first frame is drawn, with the street
  // names beside it.
  let avatar: AvatarLayer | undefined;
  let loadingAvatar: Promise<AvatarLayer> | undefined;
  let disposed = false;
  function loadAvatar(): Promise<AvatarLayer> {
    loadingAvatar ??= Promise.all([import('./avatar-layer.ts'), import('../data/streets.ts')]).then(
      ([{ createAvatarLayer }, { StreetIndex }]) => {
        if (disposed) throw new Error('The map closed while the avatar loaded.');
        streets ??= new StreetIndex(city);
        avatar ??= createAvatarLayer({
          scene,
          renderer,
          camera,
          controls,
          canvas,
          city,
          terrain,
          groundAt: drawnAt,
          gradientMap,
          night: material.userData.night as { value: number },
          reducedMotion,
          yaw: () => yaw,
          placeCamera,
          render: (continued) => {
            if (continued) loopFrame(performance.now());
            else renderNow();
          },
          farthestZoom: () => farthestZoom,
          onRoute: (target) => {
            routeTo = target;
            options.onRoute?.(target);
          },
          shadowsChanged: () => {
            renderer.shadowMap.needsUpdate = true;
            invalidate();
          },
          base: import.meta.env.BASE_URL,
          material,
          ink,
          hideLandmark,
          openWalls,
          ...(options.onPlaceChange && { onPlace: options.onPlaceChange }),
          ...(options.onRoomsUnavailable && { onRoomsUnavailable: options.onRoomsUnavailable }),
          ...(options.onDoor && { onDoor: options.onDoor }),
          ...(options.onBlocked && { onBlocked: options.onBlocked }),
          ...(options.onRideChange && { onRide: options.onRideChange }),
          ...(options.onMove && { onMove: options.onMove }),
          tags: options.tags ?? null,
        });
        invalidate();
        return avatar;
      },
    );
    // A failed download can be tried again.
    loadingAvatar.catch(() => {
      loadingAvatar = undefined;
    });
    return loadingAvatar;
  }
  function withAvatar(act: (loaded: AvatarLayer) => void): void {
    if (avatar) {
      act(avatar);
      return;
    }
    loadAvatar().then(act, (error: unknown) => {
      if (disposed) return;
      console.error(error);
      options.onAvatarUnavailable?.();
    });
  }

  let frame = 0;
  function renderNow(): void {
    cancelAnimationFrame(frame);
    frame = 0;
    render();
  }
  function cover(on: boolean): void {
    if (on === covered) return;
    covered = on;
    if (avatar) avatar.fullMap(on);
    else
      void loadingAvatar?.then(
        (loaded) => loaded.fullMap(covered),
        () => {},
      );
    // Uncovered, the city as it is now, before the page paints.
    if (!on && !disposed) renderNow();
  }
  function invalidate(): void {
    // While the avatar moves, its loop draws every frame itself.
    if (frame || avatar?.animating) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  }

  /** Keeps the target inside the area and on its ground, so the view turns about the street. */
  function clampTarget(): void {
    const t = controls.target;
    const [cx, cz] = clampToArea(city.area, t.x, t.z);
    const cy = terrain.height(cx, cz);
    if (cx !== t.x || cy !== t.y || cz !== t.z) {
      camera.position.x += cx - t.x;
      camera.position.y += cy - t.y;
      camera.position.z += cz - t.z;
      t.set(cx, cy, cz);
    }
  }
  /** The view moved by hand: a pan, a pinch, a wheel. */
  function onChange(): void {
    clampTarget();
    invalidate();
    furnishAhead();
  }
  /** The view moved: the furniture round its new place is made ahead, when idle. */
  function furnishAhead(): void {
    if (furnishing && !idleHandle) idleHandle = idle(buildInBackground);
  }

  let spin = 0;
  function rotate(direction: 1 | -1): void {
    const from = yaw;
    const to =
      Math.round((yaw - Math.PI / 4) / (Math.PI / 2)) * (Math.PI / 2) +
      Math.PI / 4 +
      direction * (Math.PI / 2);
    stopTurning();
    if (reducedMotion) {
      yaw = to;
      placeCamera();
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ROTATE_MS);
      yaw = from + (to - from) * (1 - (1 - t) ** 3);
      placeCamera();
      // Already inside a frame: don't wait for the next one, unless the avatar's loop draws it.
      if (!avatar?.animating) loopFrame(now);
      spin = t < 1 ? requestAnimationFrame(step) : 0;
    };
    spin = requestAnimationFrame(step);
  }

  // A held turn control: a spin of its own, settling on the next quarter view.
  const turning: Spin = { held: 0, rate: 0, to: Number.NaN };
  function stopTurning(): void {
    cancelAnimationFrame(spin);
    turning.rate = 0;
  }
  function spinMap(direction: number): void {
    turning.held = direction;
    // Let go, a spin under way settles by itself.
    if (!direction) return;
    stopTurning();
    turning.to = Number.NaN;
    let last = performance.now();
    const step = (now: number) => {
      // Reduced motion: no easing in or out, though the turn itself is what was asked for.
      yaw = spinStep(
        turning,
        yaw,
        Math.min(0.1, (now - last) / 1000),
        reducedMotion ? 1e9 : SPIN_EASE,
      );
      last = now;
      placeCamera();
      if (!avatar?.animating) loopFrame(now);
      spin = turning.held || turning.rate ? requestAnimationFrame(step) : 0;
    };
    spin = requestAnimationFrame(step);
  }

  function zoomBy(factor: number): void {
    camera.zoom = Math.min(controls.maxZoom, Math.max(controls.minZoom, camera.zoom * factor));
    camera.updateProjectionMatrix();
    invalidate();
  }

  let routeTo: readonly [number, number] | null = null;

  /** North at the top again, and the camera back on the avatar (over Grote Markt before it loads). */
  function resetView(): void {
    stopTurning();
    yaw = Math.PI / 4;
    placeCamera();
    avatar?.recentre();
  }

  // A tap on the map (not a pan, not a pinch) sends the avatar there: the one pointer handler
  // besides the map controls' pan, pinch and wheel.
  const listening = new AbortController();
  const listen = (type: string, handle: (event: PointerEvent) => void) =>
    canvas.addEventListener(type as 'pointerup', handle, { signal: listening.signal });
  let press: PointerEvent | null = null;
  const still = (event: PointerEvent, timed = false) =>
    event.pointerId === press?.pointerId &&
    isTap(
      event.clientX - press.clientX,
      event.clientY - press.clientY,
      timed ? event.timeStamp - press.timeStamp : 0,
    );
  // A second finger down makes it a pinch, which no tap ends.
  listen('pointerdown', (event) => (press = event.isPrimary && !event.button ? event : null));
  // Moved past the slop, it's a pan however it ends.
  listen('pointermove', (event) => {
    if (!still(event) && event.pointerId === press?.pointerId) press = null;
  });
  const lift = (event: PointerEvent) => {
    const tap = event.type === 'pointerup' && still(event, true);
    if (event.pointerId === press?.pointerId) press = null;
    if (tap) withAvatar((loaded) => loaded.tap(event.clientX, event.clientY));
  };
  listen('pointerup', lift);
  listen('pointercancel', lift);

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  // Moving the window to a screen with another pixel density changes no CSS size.
  let densityQuery: MediaQueryList | undefined;
  const onDensity = () => {
    scaler.reset();
    resize();
    watchDensity();
  };
  function watchDensity(): void {
    densityQuery = globalThis.matchMedia?.(`(resolution: ${globalThis.devicePixelRatio}dppx)`);
    densityQuery?.addEventListener('change', onDensity, { once: true });
  }
  watchDensity();

  // After a lost-and-restored GPU context (backgrounded phone tabs), the cells' buffers are gone
  // from the GPU, and their arrays were let go after upload: build them again, as on load.
  const onRestored = () => {
    for (const entry of cells) {
      scene.remove(...entry.objects);
      if (entry.furniture) scene.remove(entry.furniture);
      if (entry.tall) scene.remove(entry.tall);
      if (entry.awnings) scene.remove(entry.awnings);
      if (entry.glow) scene.remove(entry.glow);
      entry.objects = [];
      entry.furniture = undefined;
      entry.tall = null;
      entry.awnings = null;
      entry.glow = null;
    }
    [held.vertices, held.bytes] = [0, 0];
    shadow = undefined;
    renderer.shadowMap.needsUpdate = true;
    invalidate();
    if (!idleHandle) idleHandle = idle(buildInBackground);
  };
  canvas.addEventListener('webglcontextrestored', onRestored);

  // The time of day: Leuven's own clock when the map opens, then whatever is asked for. The
  // lights, the fog and the night uniform all follow it; the sun
  // the shadow map sees moves in quarter-hour steps, each a redraw of the static shadows.
  let hour = leuvenHour();
  let daylight = daylightAt(hour);
  let sunHour = Number.NaN;
  function applyDaylight(draw = true): void {
    daylight = daylightAt(hour);
    sun.color.set(daylight.sun);
    sun.intensity = daylight.sunIntensity;
    sky.color.set(daylight.sky);
    sky.groundColor.set(daylight.bounce);
    sky.intensity = daylight.skyIntensity;
    fog.color.set(daylight.horizon);
    setNight(material, daylight.night);
    lamps.value = Math.max(0, (daylight.night - LAMPS_ON) / (1 - LAMPS_ON));
    const step = sunStep(hour);
    if (step !== sunHour) {
      sunHour = step;
      light = lightFrame(daylightAt(step).sunDirection);
      [nearest, farthest] = depthRange(light, cityCorners);
      shadow = undefined; // fitted again, to the new sun, before the next frame
      renderer.shadowMap.needsUpdate = true;
    }
    options.onDaylight?.(daylight);
    if (draw) invalidate();
  }
  // What moves by itself: the day passing. While it does, a frame loop of its own steps it and
  // draws (unless the avatar's loop is drawing every frame already); otherwise the map renders on
  // demand as ever. A hidden tab pauses it with its animation frames.
  let passing = false;
  let liveFrame = 0;
  let liveLast = 0;
  const alive = () => passing;
  function tickLive(now: number): void {
    liveFrame = 0;
    if (!alive()) return;
    // Every other frame is plenty for light that changes by the minute, and half the GPU time on
    // a phone; while the avatar moves its loop draws every frame anyway.
    if (!avatar?.animating && now - liveLast < 1000 / LIVE_FPS) {
      liveFrame = requestAnimationFrame(tickLive);
      return;
    }
    const dt = Math.min(0.1, Math.max(0, (now - liveLast) / 1000));
    liveLast = now;
    if (passing) {
      hour = wrapHour(hour + dt * HOURS_PER_SECOND);
      applyDaylight(false);
    }
    if (!avatar?.animating) loopFrame(now);
    liveFrame = requestAnimationFrame(tickLive);
  }
  function wake(): void {
    if (liveFrame || !alive()) return;
    liveLast = performance.now();
    liveFrame = requestAnimationFrame(tickLive);
  }
  function passTime(on: boolean): void {
    passing = on;
    wake();
  }
  function nextTimeOfDay(): PresetId {
    const next = nextPreset(presetAt(hour));
    hour = PRESETS.find((p) => p.id === next)!.hour;
    applyDaylight();
    return next;
  }
  applyDaylight();

  resize();
  resetView();
  // Shaders compile on the GPU's own threads (KHR_parallel_shader_compile) while the city is cut
  // and its first cells built, so the first frame doesn't wait on them. A triangle and a line
  // stand in for the cells: the programs depend on the material and the scene, not the shape.
  const sample = new MeshBuilder();
  sample.triangle([0, 0, 0], [1, 0, 0], [0, 0, 1], 0, [0, 1, 0]);
  const ruler = new LineBuilder();
  ruler.segment([0, 0, 0], [1, 0, 0]);
  const standIns = new Scene();
  const standIn = new Mesh(sample.build({ facade: true }), material);
  standIn.receiveShadow = true;
  standIns.add(standIn, new LineSegments(ruler.build(), ink));
  renderer
    .compileAsync(standIns, camera, scene)
    .catch(() => {}) // the first frame compiles anyway
    .finally(() => {
      // Their programs stay with the shared materials; the two stand-in shapes can go.
      for (const child of standIns.children) (child as Mesh | LineSegments).geometry.dispose();
    });

  /**
   * The first frame, with the main thread handed back between its steps (cutting the city into
   * cells, building those in view a few at a time, drawing), so the page keeps painting and
   * taking input while it loads. Settles once the first frame is drawn.
   */
  const ready = (async () => {
    await nextTask();
    if (disposed) return;
    walls = partyWalls(city.buildings, (b) => terrain.base(b.ring));
    await nextTask();
    if (disposed) return;
    let since = performance.now();
    cut();
    aim();
    // The cells in view, then those casting into it, which the first frame would otherwise build
    // in one long task.
    for (const casting of [false, true]) {
      if (casting) fitShadowToView();
      for (const entry of cells) {
        if (performance.now() - since > STEP_MS) {
          // eslint-disable-next-line no-await-in-loop -- taking turns with the page is the point
          await nextTask();
          if (disposed) return;
          since = performance.now();
          aim(); // the view may have moved meanwhile
          if (casting) fitShadowToView();
        }
        const needed = casting ? needFrustum : frustum;
        if (!entry.objects.length && needed.intersectsBox(entry.box)) build(entry);
      }
    }
    await nextTask();
    if (disposed) return;
    renderer.shadowMap.needsUpdate = true;
    renderNow();
    idleHandle = idle(buildInBackground);
    withAvatar(() => {});
  })();

  return {
    ready,
    rotate,
    zoomBy,
    resetView,
    steer: (x, y) => avatar?.steer(x, y),
    run: (on) => avatar?.run(on),
    recentre: () => avatar?.recentre(),
    lookAt: (x, z) => withAvatar((loaded) => loaded.lookAt(x, z)),
    door: () => avatar?.door(),
    ride: (action) => withAvatar((loaded) => loaded.ride(action)),
    rooms: () => loadAvatar().then((loaded) => loaded.rooms()),
    others: (roster) => withAvatar((loaded) => loaded.others(roster)),
    dress: (outfit) => withAvatar((loaded) => loaded.dress(outfit)),
    placeAvatar: (x, z, turned) => withAvatar((loaded) => loaded.placeAt(x, z, turned)),
    navigateTo: (x, z) => withAvatar((loaded) => loaded.goTo(x, z)),
    cancelRoute: () => avatar?.cancelRoute(),
    presences: () => avatar?.presences() ?? [],
    routeTarget: () => routeTo,
    cover,
    spin: spinMap,
    timeOfDay: () => ({ preset: presetAt(hour), passing }),
    nextTimeOfDay,
    passTime,
    stats: () => ({
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    }),
    dispose() {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(spin);
      cancelAnimationFrame(liveFrame);
      cancelIdle(idleHandle);
      disposed = true;
      avatar?.dispose();
      observer.disconnect();
      listening.abort();
      densityQuery?.removeEventListener('change', onDensity);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      controls.dispose();
      scene.traverse((object: Object3D) => {
        const { geometry, material: m } = object as Partial<{
          geometry: BufferGeometry;
          material: Material;
        }>;
        geometry?.dispose();
        m?.dispose();
      });
      gradientMap.dispose();
      renderer.dispose();
    },
  };
}
