import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DataTexture,
  DirectionalLight,
  Fog,
  Frustum,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshToonMaterial,
  NearestFilter,
  OrthographicCamera,
  PCFShadowMap,
  RedFormat,
  SRGBColorSpace,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Material, Object3D, PerspectiveCamera } from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';

import type { City } from '../data/city.ts';
import { clampToArea } from '../data/geometry.ts';
import type { StreetIndex } from '../data/streets.ts';
import { Terrain } from '../data/terrain.ts';
import { facadeOf, footing, partyWalls, wallTop } from './buildings.ts';
import { AWNING } from './facade-codes.ts';
import type { PartyWalls } from './buildings.ts';
import { buildCell, groundRange, partition } from './cells.ts';
import type { Cell, DetailMarks } from './cells.ts';
import type { buildFurniture } from './furniture.ts';
import {
  createFacadeMaterial,
  fadeInkNearCamera,
  fadeNearCamera,
  setPixelSize,
} from './facade-material.ts';
import { LIGHT } from './lighting.ts';
import { LAYER_Y, slabBottom } from './ground.ts';
import { LINE_LOD } from './paint.ts';
import { LineBuilder, MeshBuilder, corners, geometryBytes } from './mesh-builder.ts';
import type { V3 } from './mesh-builder.ts';
import { BOUNCE_LIGHT, OUTLINE, PLATE, SKY, SKY_LIGHT, SUN } from './palette.ts';
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
import type { Spin } from './spin.ts';
import { terraceParasols } from './terraces.ts';
import type { Plates } from './plates.ts';
import type { RideAction, RideState } from './ride.ts';
import type { Walk, WalkMode } from './walk.ts';

export type { WalkMode } from './walk.ts';
export type { RideState } from './ride.ts';

export interface ViewerOptions {
  canvas: HTMLCanvasElement;
  /** Focusable element whose arrow keys pan the map. */
  keyTarget: HTMLElement;
  /** A layer over the canvas that takes no pointer events, for walk mode's thumb stick. */
  overlay: HTMLElement;
  city: City;
  reducedMotion: boolean;
  /** Walk mode changed: picking a start, walking, or back on the map. */
  onWalkModeChange?: (mode: WalkMode) => void;
  /** A spot that can't be walked to was picked. */
  onWalkBlocked?: () => void;
  /** Walk mode's code couldn't be downloaded (it loads the first time someone walks). */
  onWalkUnavailable?: () => void;
  /** The street or square under the walker changed (null: none, or not walking). */
  onStreetChange?: (name: string | null) => void;
  /** A bike is near enough to ride, or being ridden, or neither any more. */
  onRideChange?: (state: RideState) => void;
  /** Which way the view looks, clockwise from north (radians), whenever it turns. */
  onHeading?: (heading: number) => void;
}

export interface ViewerStats {
  drawCalls: number;
  triangles: number;
}

export interface Viewer {
  rotate(direction: 1 | -1): void;
  /**
   * Keeps turning while a turn control is held: -1 left, 1 right, 0 lets go. The map then
   * settles on the next quarter view; walking, the view turns as with a held Q or E.
   */
  spin(direction: number): void;
  /** Multiplies the zoom, within the controls' limits. */
  zoomBy(factor: number): void;
  resetView(): void;
  /** Starts downloading walk mode, for when someone is about to walk. */
  preloadWalk(): void;
  /** Starts walk mode: the next click on the map says where. */
  pickWalkStart(): void;
  /** Starts walking from the street nearest the middle of the view. */
  walkFromCentre(): void;
  /** Back to the map. */
  stopWalking(): void;
  /** Walks toward a direction on screen while held: right and up, each from -1 to 1. */
  steer(right: number, up: number): void;
  /** Runs instead of walking, while on. */
  run(on: boolean): void;
  /** Turns the walking view while held: -1 left, 1 right, 0 stops. */
  look(direction: number): void;
  /** Gets on or off the nearest bike, rings its bell, or gets riding ready (`warm`). */
  ride(action: RideAction | 'warm'): void;
  stats(): ViewerStats;
  /** Settles once the first frame is drawn, a few tasks after `createViewer` returns. */
  ready: Promise<void>;
  dispose(): void;
}

/** Metres of city shown top to bottom at zoom 1. */
const VIEW_HEIGHT = 560;
const PITCH = Math.atan(1 / Math.SQRT2); // true isometric, ≈ 35.26°
const CAMERA_DISTANCE = 2000;
const ROTATE_MS = 280;
/** The street sign looks the name up again once the walker (or the view) has moved this far (m). */
const STREET_STEP = 1;
/**
 * From the street: shadows cover this far round the walker, whichever way it looks, with this
 * margin for roofs (m), and are redrawn once over 1.6× coarser than that needs. Close up, a
 * shadow texel spans many pixels, so the square stays tight: about 12 cm a texel.
 */
const WALK_SHADOW = 45;
const WALK_SHADOW_REACH = 30;
const WALK_SHADOW_COARSER = 1.6;
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
  /** Where the rails and the catenary masts end in its outlines, which only show zoomed in. */
  detail: DetailMarks;
  /** Where the trunks, what else casts shadows and the fine road paint start in its mesh. */
  trunksFrom: number;
  shadowFrom: number;
  fineVertices: number;
}

/** Golden hour from the south-west, low enough for long shadows. */
const SUN_DIRECTION: V3 = [-0.55, 0.62, 0.56];
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
const FRAME_CALLS = 100;
const FRAME_TRIANGLES = 600_000;
/**
 * Zoom from which street furniture shows. Further out a lamp post is a stray pixel, and the
 * frames that show the most city are the ones that can least afford it. It casts shadows only
 * from the street: on the map a bench's shadow is a texel or two under the shadow lookup's lift,
 * and redrawing the map's square with the city's bikes and lamps took half a million triangles.
 */
const PROP_ZOOM = 2;
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
  const { canvas, keyTarget, overlay, city, reducedMotion } = options;
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
  // Walking fades the far city into the horizon's haze. The fog is always there, far off on
  // the map, so starting a walk never recompiles the city's shaders.
  const fog = new Fog(SKY.horizon, 1e7, 1e7 + 1);
  scene.fog = fog;
  const gradientMap = toonGradient();
  // One material for every cell: walls get windows, roads their texture and paint (paint.ts).
  const material = createFacadeMaterial(gradientMap);
  // A mesh without a `facade` attribute (street furniture) reads 0: a plain surface.
  Object.assign(material, { defaultAttributeValues: { facade: [0], lift: [0] } });
  const ink = new LineBasicMaterial({ color: OUTLINE });
  fadeInkNearCamera(ink);

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
        detail: { rails: 0, masts: 0 },
        trunksFrom: 0,
        shadowFrom: 0,
        fineVertices: 0,
      });
    }
  }

  /** Vertices and bytes of geometry the built cells hand the GPU. */
  const held = { vertices: 0, bytes: 0 };
  function build(entry: CellEntry): void {
    const { mesh, lines, trunksFrom, shadowFrom, fineVertices, detail } = buildCell(
      entry.cell,
      city.area,
      walls,
      terrain,
    );
    Object.assign(entry, { detail, trunksFrom, shadowFrom, fineVertices });
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
    // Cells are culled by their boxes below: three's bounding spheres are far looser.
    entry.objects = [surfaces, outlines, casters];
    hold(surfaces, outlines);
    entry.box.copy(surfaces.geometry.boundingBox!);
    for (const object of entry.objects) object.frustumCulled = false;
    scene.add(surfaces, outlines, casters);
    if (propsShown) furnish(entry);
  }

  /**
   * The street furniture and monuments are drawn by a chunk of their own (furniture.ts), loaded
   * once the first frame is drawn, or as soon as the view gets close. If it fails to load, the
   * map goes on without them.
   */
  let furnishing: { buildFurniture: typeof buildFurniture } | undefined;
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

  /** Makes a mesh of furniture, sharing the city's material, culled by `cull`. */
  function furnitureMesh(builder: MeshBuilder, striped = false): Mesh {
    // No windows: it leaves out the facade attribute and the shader reads its default, but
    // awnings need it for their stripes.
    const mesh = new Mesh(builder.build({ facade: striped }), material);
    mesh.castShadow = true;
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
    const { near, bikes, awnings, tall } = furnishing.buildFurniture(entry.cell, {
      MeshBuilder,
      terrain,
      awning: AWNING,
      footing: (b) => footing(terrain, b.ring),
      wallTop,
      ground: (x, z) => terrain.height(x, z),
      layers: LAYER_Y,
    });
    entry.furniture = furnitureMesh(near);
    // Where each parked bike is drawn in it (`PARKED`), and its index kept, so riding can draw
    // a bike taken from its rack as nothing, and put it back.
    entry.furniture.userData.bikes = bikes;
    if (bikes.length) entry.furniture.geometry.index!.onUpload(() => {});
    entry.box.union(entry.furniture.geometry.boundingBox!);
    entry.awnings = awnings && furnitureMesh(awnings, true);
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

  const sky = new HemisphereLight(SKY_LIGHT, BOUNCE_LIGHT, LIGHT.sky);
  const sun = new DirectionalLight(SUN, LIGHT.sun);
  for (const l of [sky, sun]) l.layers.enableAll();
  scene.add(sky);
  const light = lightFrame(SUN_DIRECTION);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  sun.shadow.camera.layers.mask = SHADOW_LAYER;
  scene.add(sun, sun.target);
  // The shadow camera's depth spans the whole area, from the slab's underside to the rooftops.
  const [nearest, farthest] = depthRange(
    light,
    city.area.flatMap((a) =>
      [slabBottom(terrain), terrain.highest + MAX_HEIGHT].flatMap((y): V3[] => [
        [a.minX, y, a.minZ],
        [a.maxX, y, a.minZ],
        [a.minX, y, a.maxZ],
        [a.maxX, y, a.maxZ],
      ]),
    ),
  );
  let shadow: ShadowSquare | undefined;
  let propsShown = false;
  const shadowFrustum = new Frustum();
  /** Whether cells built since the shadow map was drawn cast into it. */
  let missingCasters = false;
  /** The part of the shadow square the view needs now, in the same light frame. */
  const needFrustum = new Frustum();
  const needProjection = new Matrix4();

  const camera = new OrthographicCamera(-1, 1, 1, -1, 1, CAMERA_DISTANCE * 2);
  const controls = new MapControls(camera, canvas);
  controls.enableRotate = false;
  controls.enableDamping = false;
  controls.zoomToCursor = true;
  controls.minZoom = 0.5;
  controls.maxZoom = 4;
  controls.cursorStyle = 'grab';
  controls.listenToKeyEvents(keyTarget); // arrow keys pan while the map has focus

  // The camera that draws: the map's, or the walking one while walking.
  let view: OrthographicCamera | PerspectiveCamera = camera;
  let street: PerspectiveCamera | undefined;
  /** Height of the view (m) where it looks: what decides how much detail is worth drawing. */
  const viewSpan = () =>
    street
      ? 2 * street.position.distanceTo(controls.target) * Math.tan((street.fov * Math.PI) / 360)
      : VIEW_HEIGHT / camera.zoom;

  let yaw = Math.PI / 4;
  function placeCamera(): void {
    const t = controls.target;
    camera.position.set(
      t.x + Math.sin(yaw) * Math.cos(PITCH) * CAMERA_DISTANCE,
      t.y + Math.sin(PITCH) * CAMERA_DISTANCE,
      t.z + Math.cos(yaw) * Math.cos(PITCH) * CAMERA_DISTANCE,
    );
    camera.lookAt(t);
    controls.update();
  }

  let width = 0;
  let height = 0;
  const buffer = new Vector2();
  function resize(): void {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (w === width && h === height && ratio === renderer.getPixelRatio()) return;
    width = w;
    height = h;
    renderer.setDrawingBufferSize(width, height, ratio); // one reallocation, style untouched
    // The buffer is floored to whole pixels, so take the aspect from it: pixels stay square.
    renderer.getDrawingBufferSize(buffer);
    const halfH = VIEW_HEIGHT / 2;
    const halfW = halfH * (buffer.x / buffer.y);
    Object.assign(camera, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
    camera.updateProjectionMatrix();
    walk?.resized();
    invalidate();
  }

  // The ground all round the walker, reused each frame.
  const square: [number, number, number][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  function around(x: number, z: number, reach: number): readonly V3[] {
    for (let i = 0; i < 4; i++) {
      square[i]![0] = x + (i === 1 || i === 2 ? reach : -reach);
      square[i]![2] = z + (i >= 2 ? reach : -reach);
    }
    return square;
  }

  const frustum = new Frustum();
  const viewProjection = new Matrix4();
  const corner = new Vector3();
  const forward = new Vector3();
  const ground = SCREEN_CORNERS.map((): [number, number, number] => [0, 0, 0]);
  /** Points `frustum` at what the view sees now. */
  function aim(): void {
    view.updateMatrixWorld();
    viewProjection.multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection);
  }

  /** Builds any cell the camera can see, and fits the shadow map to the view. */
  function prepare(): void {
    aim();
    for (const entry of cells) {
      if (!entry.objects.length && frustum.intersectsBox(entry.box)) build(entry);
    }

    // The ground under the screen's corners, as far as shadows can reach into the view. From
    // the street that's the haze, all round the walker, so looking about never redraws them.
    camera.getWorldDirection(forward);
    const span = viewSpan();
    const t = controls.target;
    const reach = Math.max(WALK_SHADOW, walk?.flightSpan ?? span);
    if (view === camera) {
      for (const [i, [x, y]] of SCREEN_CORNERS.entries()) {
        corner.set(x, y, -1).unproject(camera);
        corner.addScaledVector(forward, (t.y - corner.y) / forward.y);
        [ground[i]![0], ground[i]![2]] = [corner.x, corner.z];
      }
    }
    const need = shadowNeeds(light, view === camera ? ground : around(t.x, t.z, reach));
    need.half += view === camera ? Math.min(SHADOW_REACH, span / 4) : WALK_SHADOW_REACH;
    propsShown = span <= VIEW_HEIGHT / PROP_ZOOM;
    const fromStreet = view !== camera && walk?.flightSpan === undefined;
    const coarser = view === camera ? SHADOW_COARSER : WALK_SHADOW_COARSER;
    const refit = !shadow || !shadowCovers(shadow, need, coarser);
    if (refit) fitShadowTo(need);
    // What casts into the view has to exist before the shadow pass draws: build it now, and
    // redraw if that adds to a square already drawn. The rest of the square, its room to pan,
    // waits for the idle builder (see `buildInBackground`).
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
    let added = false;
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
   * Returns whether the view and the shadow redraw fit in one frame's budget together.
   */
  function cull(): boolean {
    const shadowPass = renderer.shadowMap.needsUpdate;
    let [calls, triangles] = [0, 0];
    const draw = (mesh: Mesh) => {
      calls++;
      triangles += drawn(mesh);
    };
    const pixel = viewSpan() / buffer.y;
    // From above a trunk's shadow hides in its crown's; from the street it doesn't. Mid-flight
    // the shadow square spans the map view, where a trunk's or a lamp's shadow is less than a
    // texel; landing refits it round the walker with theirs.
    const flying = walk?.flightSpan !== undefined;
    const fromStreet = view !== camera && !flying;
    for (const entry of cells) {
      const { box, objects, detail, trunksFrom, shadowFrom, fineVertices } = entry;
      const [surfaces, outlines, casters] = objects as [Mesh?, Mesh?, Mesh?];
      if (!surfaces || !outlines || !casters) continue;
      const skip = pixel > MAST_PIXEL ? detail.masts : pixel > RAIL_PIXEL ? detail.rails : 0;
      outlines.geometry.setDrawRange(skip * 2, Infinity);
      const inView = frustum.intersectsBox(box);
      surfaces.visible = inView;
      outlines.visible = inView;
      const casts = shadowPass && shadowFrustum.intersectsBox(box);
      casters.visible = casts;
      const from = fromStreet ? trunksFrom : shadowFrom;
      if (casts) casters.geometry.setDrawRange(from, fineVertices - from);
      if (inView) {
        draw(surfaces);
        calls++; // its outlines
      }
      if (casts) draw(casters);
      const { furniture, tall } = entry;
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
    return calls <= FRAME_CALLS && triangles <= FRAME_TRIANGLES;
  }

  // Everything else is built in small slices while the page has nothing better to do.
  let idleHandle = 0;
  function buildInBackground(): void {
    idleHandle = 0;
    const t = controls.target;
    const near = (a: CellEntry, b: CellEntry) =>
      a.box.distanceToPoint(t) - b.box.distanceToPoint(t);
    // The cells first, then their furniture, nearest first.
    const waiting = [
      ...cells.filter((entry) => !entry.objects.length).toSorted(near),
      ...cells.filter((entry) => !entry.furniture).toSorted(near),
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
    if (unbuilt || (furnishing && cells.some((e) => !e.furniture))) {
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
  function render(): void {
    if (street) {
      street.aspect = buffer.x / buffer.y;
      street.updateProjectionMatrix();
    }
    // World metres per drawing-buffer pixel (where the walking camera looks, from the street):
    // how much road paint and texture is worth drawing.
    const unit = viewSpan() / renderer.getDrawingBufferSize(buffer).y;
    setPixelSize(material, unit);
    view.updateMatrixWorld();
    prepare();
    // The plates on the facades show on foot, not in the flight down or back up.
    const t = controls.target;
    plates?.update(t.x, t.z, walk?.mode === 'walk' && walk.flightSpan === undefined);
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
    if (alone) [view.layers.mask, renderer.autoClear] = [LIGHTS_ONLY, false];
    renderer.render(scene, view);
    if (alone) [view.layers.mask, renderer.autoClear] = [VIEW_LAYER, true];
    // The cost of this very frame and the most any frame cost, for the smoke test and anyone
    // debugging, with what the GPU holds. Frames that redraw the static shadow map (on load, and
    // when the view leaves its square) cost more.
    const { calls, triangles } = renderer.info.render;
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
      plates: plates?.shown ?? 0,
    });
    if (alone) {
      invalidate();
      return;
    }

    signStreet();
    signHeading();
  }

  // The street sign: names are looked up only while walking, and again only after a step. The
  // lookup arrives with walk mode, so the map's first load doesn't carry it.
  let streets: StreetIndex | undefined;
  let signed: string | null = null;
  const signedAt = { x: Number.NaN, z: Number.NaN };
  function signStreet(): void {
    if (!options.onStreetChange) return;
    const t = controls.target;
    let name: string | null = null;
    if (walk?.mode === 'walk') {
      if (Math.hypot(t.x - signedAt.x, t.z - signedAt.z) < STREET_STEP) return;
      signedAt.x = t.x;
      signedAt.z = t.z;
      if (!streets) return;
      name = streets.nameAt(t.x, t.z, signed);
    } else signedAt.x = Number.NaN;
    if (name !== signed) options.onStreetChange((signed = name));
  }

  const facing = new Vector3();
  let heading = Number.NaN;
  function signHeading(): void {
    if (!options.onHeading) return;
    view.getWorldDirection(facing);
    const now = Math.atan2(facing.x, -facing.z);
    if (Math.abs(now - heading) < 1e-3) return;
    options.onHeading((heading = now));
  }

  // Walking is its own chunk, downloaded the first time someone walks (or is about to).
  let walk: Walk | undefined;
  let plates: Plates | undefined;
  let loadingWalk: Promise<Walk> | undefined;
  let disposed = false;
  function loadWalk(): Promise<Walk> {
    loadingWalk ??= Promise.all([import('./walk.ts'), import('../data/streets.ts')]).then(
      ([{ createWalk }, { StreetIndex }]) => {
        if (disposed) throw new Error('The map closed while walk mode loaded.');
        streets ??= new StreetIndex(city);
        walk ??= createWalk({
          scene,
          camera,
          controls,
          canvas,
          overlay,
          city,
          terrain,
          gradientMap,
          fog,
          reducedMotion,
          yaw: () => yaw,
          setYaw: (to) => {
            yaw = to;
          },
          placeCamera,
          useView: (to) => {
            street = to ?? undefined;
            view = to ?? camera;
          },
          render: renderNow,
          renderer,
          onRide: options.onRideChange,
          onModeChange: (mode) => {
            // A held turn on the map mustn't fight the flight down.
            if (mode === 'walk') stopTurning();
            options.onWalkModeChange?.(mode);
            signStreet();
          },
          ...(options.onWalkBlocked && { onBlocked: options.onWalkBlocked }),
        });
        loadFacadePlates();
        return walk;
      },
    );
    // A failed download can be tried again.
    loadingWalk.catch(() => {
      loadingWalk = undefined;
    });
    return loadingWalk;
  }
  // The house numbers and street plates on the facades: their own chunk and data, after walk
  // mode's, and only decoration, so a failure leaves the walk as it was.
  function loadFacadePlates(): void {
    import('./plates.ts')
      .then(({ loadPlates }) =>
        loadPlates({
          kit: {
            three: {
              BufferAttribute,
              BufferGeometry,
              CanvasTexture,
              Mesh,
              MeshToonMaterial,
              SRGBColorSpace,
            },
            colours: PLATE,
          },
          scene,
          city,
          facade: (b) => ({ ...facadeOf(b), foot: footing(terrain, b.ring) }),
          height: (x, z) => terrain.height(x, z),
          gradientMap,
          anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()),
          compile: (object) => renderer.compileAsync(object, view, scene),
          changed: invalidate,
          fadeNearCamera: (plate) => fadeNearCamera(plate, 'plates-v1'),
        }),
      )
      .then(
        (loaded) => {
          if (disposed) loaded.dispose();
          else plates = loaded;
        },
        (error: unknown) => console.warn('The plates on the facades could not load.', error),
      );
  }
  function withWalk(act: (loaded: Walk) => void): void {
    if (walk) {
      act(walk);
      return;
    }
    loadWalk().then(act, (error: unknown) => {
      if (disposed) return;
      console.error(error);
      options.onWalkUnavailable?.();
    });
  }

  let frame = 0;
  function renderNow(): void {
    cancelAnimationFrame(frame);
    frame = 0;
    render();
  }
  function invalidate(): void {
    // While walking, the walk loop draws every frame itself.
    if (frame || walk?.animating) return;
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
  const onChange = () => {
    clampTarget();
    invalidate();
  };
  controls.addEventListener('change', onChange);

  let spin = 0;
  function rotate(direction: 1 | -1): void {
    if (walk?.mode === 'walk') {
      walk.turn(direction);
      return;
    }
    walk?.land();
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
      // Already inside a frame: don't wait for the next one, unless the walk loop draws it.
      if (!walk?.animating) renderNow();
      spin = t < 1 ? requestAnimationFrame(step) : 0;
    };
    spin = requestAnimationFrame(step);
  }

  // A held turn control: on the map a spin of its own; walking, a look, with the turn keys'.
  const turning: Spin = { held: 0, rate: 0, to: Number.NaN };
  let looking = 0;
  function stopTurning(): void {
    cancelAnimationFrame(spin);
    turning.rate = 0;
  }
  function look(direction: number): void {
    looking = direction;
    walk?.look(Math.sign(looking + turning.held));
  }
  function spinMap(direction: number): void {
    turning.held = direction;
    look(looking);
    // Let go, a spin under way settles by itself.
    if (!direction || walk?.mode === 'walk') return;
    walk?.land();
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
      if (!walk?.animating) renderNow();
      spin = turning.held || turning.rate ? requestAnimationFrame(step) : 0;
    };
    spin = requestAnimationFrame(step);
  }

  function zoomBy(factor: number): void {
    if (walk?.mode === 'walk') {
      walk.zoom(factor);
      return;
    }
    walk?.land();
    camera.zoom = Math.min(controls.maxZoom, Math.max(controls.minZoom, camera.zoom * factor));
    camera.updateProjectionMatrix();
    controls.update();
    invalidate();
  }

  function resetView(): void {
    stopTurning();
    walk?.land();
    yaw = Math.PI / 4;
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    placeCamera();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  // Moving the window to a screen with another pixel density changes no CSS size.
  let densityQuery: MediaQueryList | undefined;
  const onDensity = () => {
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
      entry.objects = [];
      entry.furniture = undefined;
      entry.tall = null;
      entry.awnings = null;
    }
    [held.vertices, held.bytes] = [0, 0];
    shadow = undefined;
    renderer.shadowMap.needsUpdate = true;
    invalidate();
    if (!idleHandle) idleHandle = idle(buildInBackground);
  };
  canvas.addEventListener('webglcontextrestored', onRestored);

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
    walls = partyWalls(city.buildings, (b) => footing(terrain, b.ring));
    await nextTask();
    if (disposed) return;
    let since = performance.now();
    cut();
    aim();
    for (const entry of cells) {
      if (performance.now() - since > STEP_MS) {
        // eslint-disable-next-line no-await-in-loop -- taking turns with the page is the point
        await nextTask();
        if (disposed) return;
        since = performance.now();
        aim(); // the view may have moved meanwhile
      }
      if (!entry.objects.length && frustum.intersectsBox(entry.box)) build(entry);
    }
    await nextTask();
    if (disposed) return;
    renderer.shadowMap.needsUpdate = true;
    renderNow();
    idleHandle = idle(buildInBackground);
  })();

  return {
    ready,
    rotate,
    zoomBy,
    resetView,
    preloadWalk: () => {
      loadWalk().catch(() => {}); // a warm-up: the next real attempt reports any failure
    },
    pickWalkStart: () => withWalk((loaded) => loaded.pick()),
    walkFromCentre: () => withWalk((loaded) => loaded.startAtCentre()),
    stopWalking: () => walk?.exit(),
    steer: (x, y) => walk?.steer(x, y),
    run: (on) => walk?.run(on),
    ride: (action) => walk?.ride(action),
    look,
    spin: spinMap,
    stats: () => ({
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    }),
    dispose() {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(spin);
      cancelIdle(idleHandle);
      disposed = true;
      walk?.dispose();
      plates?.dispose();
      observer.disconnect();
      densityQuery?.removeEventListener('change', onDensity);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      controls.removeEventListener('change', onChange);
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
