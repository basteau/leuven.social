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
import type { Material, Object3D, PerspectiveCamera } from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';

import type { City } from '../data/city.ts';
import { clampToArea } from '../data/geometry.ts';
import { partyWalls } from './buildings.ts';
import { buildCell, partition } from './cells.ts';
import type { Cell, DetailMarks } from './cells.ts';
import { createFacadeMaterial, setPixelSize } from './facade-material.ts';
import { labelHeights } from './label-anchors.ts';
import { LIGHT } from './lighting.ts';
import { SLAB_DEPTH } from './ground.ts';
import { LINE_LOD } from './paint.ts';
import { geometryBytes } from './mesh-builder.ts';
import type { V3 } from './mesh-builder.ts';
import { BOUNCE_LIGHT, OUTLINE, SKY, SKY_LIGHT, SUN } from './palette.ts';
import {
  depthRange,
  fitShadow,
  lightFrame,
  shadowCovers,
  shadowNeeds,
  shadowPoint,
} from './shadow-fit.ts';
import type { ShadowSquare } from './shadow-fit.ts';
import { applyOneTapShadows } from './shadow-filter.ts';
import { terraceParasols } from './terraces.ts';
import type { Walk, WalkMode } from './walk.ts';

export type { WalkMode } from './walk.ts';

export interface ViewerOptions {
  canvas: HTMLCanvasElement;
  /** Focusable element whose arrow keys pan the map. */
  keyTarget: HTMLElement;
  /** Absolutely positioned layer over the canvas that receives landmark labels. */
  labelLayer: HTMLElement;
  city: City;
  reducedMotion: boolean;
  /** Walk mode changed: picking a start, walking, or back on the map. */
  onWalkModeChange?: (mode: WalkMode) => void;
  /** A spot that can't be walked to was picked. */
  onWalkBlocked?: () => void;
  /** Walk mode's code couldn't be downloaded (it loads the first time someone walks). */
  onWalkUnavailable?: () => void;
}

export interface ViewerStats {
  drawCalls: number;
  triangles: number;
}

export interface Viewer {
  rotate(direction: 1 | -1): void;
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
  stats(): ViewerStats;
  dispose(): void;
}

/** Metres of city shown top to bottom at zoom 1. */
const VIEW_HEIGHT = 560;
const PITCH = Math.atan(1 / Math.SQRT2); // true isometric, ≈ 35.26°
const CAMERA_DISTANCE = 2000;
const ROTATE_MS = 280;
/** Seen from the street, labels further than this would float over the houses in front (m). */
const LABEL_REACH = 160;
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
/** Tallest thing in the city (m), and the margin kept around the view for tall roofs. */
const MAX_HEIGHT = 90;
const SHADOW_REACH = 60;
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
 * frames that show the most city are the ones that can least afford it.
 */
const PROP_ZOOM = 2;
/** Time the idle builder may take per slice before handing the main thread back (ms). */
const IDLE_SLICE_MS = 8;
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
  return Math.min(count, geometry.getAttribute('position').count - start) / 3;
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
  const { canvas, keyTarget, labelLayer, city, reducedMotion } = options;
  // Dense screens are smooth already; only standard-density ones pay for multisampling.
  const density = Math.min(globalThis.devicePixelRatio || 1, 2);
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: density < 1.5 });
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  // Hard shadows, each texel's edge smoothed by one hardware-filtered tap (shadow-filter.ts).
  applyOneTapShadows();
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
  const ink = new LineBasicMaterial({ color: OUTLINE });

  // Cells are built when they first come into view, and the rest while the page is idle, so
  // the first frame costs what the visible part of the city costs.
  const walls = partyWalls(city.buildings);
  const cells: CellEntry[] = partition(city, terraceParasols(city)).map((cell) => ({
    cell,
    // Until it's built, a guess: buildings belong to the cell of their first corner and can
    // overhang it a little.
    box: new Box3(
      new Vector3(cell.bounds.minX - 60, -SLAB_DEPTH, cell.bounds.minZ - 60),
      new Vector3(cell.bounds.maxX + 60, MAX_HEIGHT, cell.bounds.maxZ + 60),
    ),
    objects: [],
    detail: { rails: 0, masts: 0 },
    trunksFrom: 0,
    shadowFrom: 0,
    fineVertices: 0,
  }));

  /** Vertices and bytes of geometry the built cells hand the GPU. */
  const held = { vertices: 0, bytes: 0 };
  function build(entry: CellEntry): void {
    const { mesh, lines, props, trunksFrom, shadowFrom, fineVertices, detail } = buildCell(
      entry.cell,
      city.area,
      walls,
    );
    Object.assign(entry, { detail, trunksFrom, shadowFrom, fineVertices });
    const surfaces = new Mesh(mesh.build({ facade: true }), material);
    surfaces.receiveShadow = true;
    // The shadow pass draws the same buffers from past the ground (and the trunks, see `cull`) up
    // to the fine road paint, as a mesh of its own on the shadow camera's layer: no copy, no
    // extra upload, one draw call as before.
    const shape = new BufferGeometry();
    shape.setAttribute('position', surfaces.geometry.getAttribute('position'));
    // Its bounds are its cell's: computing them would need the array the upload let go of.
    shape.boundingBox = surfaces.geometry.boundingBox;
    shape.boundingSphere = surfaces.geometry.boundingSphere;
    const casters = new Mesh(shape, material);
    casters.castShadow = true;
    casters.layers.mask = SHADOW_LAYER;
    // Street furniture shares the material and its program: one more draw call, only up close.
    const furniture = new Mesh(props.build({ facade: true }), material);
    furniture.castShadow = true;
    furniture.receiveShadow = true;
    const outlines = new LineSegments(lines.build(), ink);
    // Cells are culled by their boxes below: three's bounding spheres are far looser.
    entry.objects = [surfaces, outlines, casters, furniture];
    for (const { geometry } of [surfaces, outlines, furniture]) {
      held.vertices += geometry.getAttribute('position').count;
      held.bytes += geometryBytes(geometry);
    }
    entry.box.copy(surfaces.geometry.boundingBox!);
    if (entry.cell.props.length) entry.box.union(furniture.geometry.boundingBox!);
    for (const object of entry.objects) object.frustumCulled = false;
    scene.add(surfaces, outlines, casters, furniture);
  }

  const sky = new HemisphereLight(SKY_LIGHT, BOUNCE_LIGHT, LIGHT.sky);
  const sun = new DirectionalLight(SUN, LIGHT.sun);
  for (const l of [sky, sun]) l.layers.enableAll();
  scene.add(sky);
  const light = lightFrame(SUN_DIRECTION);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  sun.shadow.camera.layers.mask = SHADOW_LAYER;
  scene.add(sun, sun.target);
  // The shadow camera's depth spans the whole area, from the slab's underside to the rooftops.
  const [nearest, farthest] = depthRange(
    light,
    city.area.flatMap((a) =>
      [-SLAB_DEPTH, MAX_HEIGHT].flatMap((y): V3[] => [
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

  // Landmark labels are plain DOM, moved with transforms after each render. Their order is
  // their priority: a label that would overlap an earlier one, or the screen edge, is hidden,
  // and so is one whose zoom hasn't been reached.
  const labelEls = city.labels.map((label) => {
    const el = document.createElement('span');
    el.className = 'map-label';
    el.textContent = label.name;
    return el;
  });
  labelLayer.append(...labelEls);
  // Measure after all are in the DOM: one layout instead of one per label. Each remembers what it
  // last showed, so a frame only writes to the labels that changed.
  const anchors = labelHeights(city.labels, city.buildings);
  const labels = labelEls.map((el, i) => ({
    el,
    w: el.offsetWidth,
    h: el.offsetHeight,
    minZoom: city.labels[i]!.minZoom,
    world: new Vector3(city.labels[i]!.x, anchors[i]!, city.labels[i]!.z),
    shown: true,
    transform: '',
  }));
  /** The boxes of the labels placed so far this frame, four numbers each. */
  const placed = new Float64Array(labels.length * 4);
  const projected = new Vector3();

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
  /** Builds any cell the camera can see, and fits the shadow map to the view. */
  function prepare(): void {
    viewProjection.multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection);
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
        corner.addScaledVector(forward, -corner.y / forward.y);
        [ground[i]![0], ground[i]![2]] = [corner.x, corner.z];
      }
    }
    const need = shadowNeeds(light, view === camera ? ground : around(t.x, t.z, reach));
    need.half += view === camera ? SHADOW_REACH : WALK_SHADOW_REACH;
    // Furniture appearing or hiding changes what casts shadows: refit the square to the view,
    // which is close up when it appears, so the redraw stays small.
    const near = span <= VIEW_HEIGHT / PROP_ZOOM;
    if (near !== propsShown) shadow = undefined;
    propsShown = near;
    const refit = !shadow || !shadowCovers(shadow, need, view === camera ? 4 : WALK_SHADOW_COARSER);
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
    for (const { box, cell, objects, detail, trunksFrom, shadowFrom, fineVertices } of cells) {
      const [surfaces, outlines, casters, furniture] = objects as [Mesh?, Mesh?, Mesh?, Mesh?];
      if (!surfaces || !outlines || !casters || !furniture) continue;
      const skip = pixel > MAST_PIXEL ? detail.masts : pixel > RAIL_PIXEL ? detail.rails : 0;
      outlines.geometry.setDrawRange(skip * 2, Infinity);
      const inView = frustum.intersectsBox(box);
      surfaces.visible = inView;
      outlines.visible = inView;
      const casts = shadowPass && shadowFrustum.intersectsBox(box);
      casters.visible = casts;
      const from = fromStreet ? trunksFrom : shadowFrom;
      if (casts) casters.geometry.setDrawRange(from, fineVertices - from);
      const furnitureCasts = casts && !flying;
      furniture.layers.mask = (inView ? VIEW_LAYER : 0) | (furnitureCasts ? SHADOW_LAYER : 0);
      furniture.visible = (inView || furnitureCasts) && propsShown && cell.props.length > 0;
      if (inView) {
        draw(surfaces);
        calls++; // its outlines
      }
      if (casts) draw(casters);
      if (furniture.visible && inView) draw(furniture);
      if (furniture.visible && furnitureCasts) draw(furniture);
    }
    return calls <= FRAME_CALLS && triangles <= FRAME_TRIANGLES;
  }

  // Everything else is built in small slices while the page has nothing better to do.
  let idleHandle = 0;
  function buildInBackground(): void {
    idleHandle = 0;
    const t = controls.target;
    const waiting = cells
      .filter((entry) => !entry.objects.length)
      .toSorted((a, b) => a.box.distanceToPoint(t) - b.box.distanceToPoint(t));
    const start = performance.now();
    for (const entry of waiting) {
      if (performance.now() - start > IDLE_SLICE_MS) break;
      build(entry);
      missingCasters ||= shadowFrustum.intersectsBox(entry.box);
    }
    // Once the last cell that casts into the shadow square exists, redraw it with them all.
    if (
      missingCasters &&
      !cells.some((e) => !e.objects.length && shadowFrustum.intersectsBox(e.box))
    ) {
      missingCasters = false;
      renderer.shadowMap.needsUpdate = true;
    }
    invalidate();
    if (cells.some((entry) => !entry.objects.length)) idleHandle = idle(buildInBackground);
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
    });
    if (alone) {
      invalidate();
      return;
    }

    let count = 0;
    const fromStreet = street !== undefined;
    const zoom = VIEW_HEIGHT / viewSpan();
    for (const label of labels) {
      let show = fromStreet
        ? label.world.distanceTo(view.position) <= LABEL_REACH
        : zoom >= label.minZoom;
      let [left, top, right, bottom] = [0, 0, 0, 0];
      if (show) {
        projected.copy(label.world).project(view);
        const x = ((projected.x + 1) / 2) * width;
        const y = ((1 - projected.y) / 2) * height;
        [left, top, right, bottom] = [x - label.w / 2, y - label.h, x + label.w / 2, y];
        show = projected.z < 1 && left >= 0 && top >= 0 && right <= width && bottom <= height;
        for (let i = 0; show && i < count * 4; i += 4) {
          const clash =
            left < placed[i + 2]! &&
            right > placed[i]! &&
            top < placed[i + 3]! &&
            bottom > placed[i + 1]!;
          show = !clash;
        }
      }
      if (show !== label.shown) label.el.hidden = !(label.shown = show);
      if (!show) continue;
      [placed[count * 4], placed[count * 4 + 1]] = [left, top];
      [placed[count * 4 + 2], placed[count * 4 + 3]] = [right, bottom];
      count++;
      const transform = `translate(${(left + label.w / 2).toFixed(1)}px, ${bottom.toFixed(1)}px)`;
      if (transform !== label.transform) label.el.style.transform = label.transform = transform;
    }
  }

  // Walking is its own chunk, downloaded the first time someone walks (or is about to).
  let walk: Walk | undefined;
  let loadingWalk: Promise<Walk> | undefined;
  let disposed = false;
  function loadWalk(): Promise<Walk> {
    loadingWalk ??= import('./walk.ts').then(({ createWalk }) => {
      if (disposed) throw new Error('The map closed while walk mode loaded.');
      walk ??= createWalk({
        scene,
        camera,
        controls,
        canvas,
        overlay: labelLayer,
        city,
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
        ...(options.onWalkModeChange && { onModeChange: options.onWalkModeChange }),
        ...(options.onWalkBlocked && { onBlocked: options.onWalkBlocked }),
      });
      return walk;
    });
    // A failed download can be tried again.
    loadingWalk.catch(() => {
      loadingWalk = undefined;
    });
    return loadingWalk;
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

  function clampTarget(): void {
    const t = controls.target;
    const [cx, cz] = clampToArea(city.area, t.x, t.z);
    if (cx !== t.x || cz !== t.z) {
      camera.position.x += cx - t.x;
      camera.position.z += cz - t.z;
      t.set(cx, t.y, cz);
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
    cancelAnimationFrame(spin);
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
    cancelAnimationFrame(spin);
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
      entry.objects = [];
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
  renderer.shadowMap.needsUpdate = true;
  renderNow();
  idleHandle = idle(buildInBackground);

  return {
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
    look: (direction) => walk?.look(direction),
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
      observer.disconnect();
      densityQuery?.removeEventListener('change', onDensity);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      controls.removeEventListener('change', onChange);
      controls.dispose();
      for (const { el } of labels) el.remove();
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
