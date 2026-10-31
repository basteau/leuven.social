import {
  BasicShadowMap,
  Box3,
  DataTexture,
  DirectionalLight,
  Frustum,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  RedFormat,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { BufferGeometry, Material, Object3D } from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';

import type { City } from '../data/city.ts';
import { clampToArea } from '../data/geometry.ts';
import { partyWalls } from './buildings.ts';
import { buildCell, partition } from './cells.ts';
import type { Cell, DetailMarks } from './cells.ts';
import { createFacadeMaterial } from './facade-material.ts';
import { SLAB_DEPTH } from './ground.ts';
import type { V3 } from './mesh-builder.ts';
import { BOUNCE_LIGHT, OUTLINE, SKY_LIGHT, SUN } from './palette.ts';
import {
  depthRange,
  fitShadow,
  lightFrame,
  shadowCovers,
  shadowNeeds,
  shadowPoint,
} from './shadow-fit.ts';
import type { ShadowSquare } from './shadow-fit.ts';
import { terraceParasols } from './terraces.ts';

export interface ViewerOptions {
  canvas: HTMLCanvasElement;
  /** Focusable element whose arrow keys pan the map. */
  keyTarget: HTMLElement;
  /** Absolutely positioned layer over the canvas that receives landmark labels. */
  labelLayer: HTMLElement;
  city: City;
  pixelated: boolean;
  reducedMotion: boolean;
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
  setPixelated(on: boolean): void;
  stats(): ViewerStats;
  dispose(): void;
}

/** Metres of city shown top to bottom at zoom 1. */
const VIEW_HEIGHT = 560;
/** Vertical game pixels the pixel look aims for, whatever the screen. */
const PIXEL_ROWS = 420;
const PITCH = Math.atan(1 / Math.SQRT2); // true isometric, ≈ 35.26°
const CAMERA_DISTANCE = 2000;
const ROTATE_MS = 280;
const LABEL_HEIGHT = 28;
interface CellEntry {
  cell: Cell;
  box: Box3;
  /** Its mesh and outlines once built; empty until then. */
  objects: Object3D[];
  /** Where the rails and the catenary masts end in its outlines, which only show zoomed in. */
  detail: DetailMarks;
}

/** Golden hour from the south-west, low enough for long shadows. */
const SUN_DIRECTION: V3 = [-0.55, 0.62, 0.56];
const SHADOW_MAP = 2048;
/** Tallest thing in the city (m), and the margin kept around the view for tall roofs. */
const MAX_HEIGHT = 90;
const SHADOW_REACH = 60;
/** Layer masks: the view draws layer 0, the shadow pass layer 1 (see `cull`). */
const VIEW_LAYER = 1 << 0;
const SHADOW_LAYER = 1 << 1;
/** Time the idle builder may take per slice before handing the main thread back (ms). */
const IDLE_SLICE_MS = 8;
/**
 * Zooms from which rails and catenary masts show. Further out, a track's two rails are under
 * two game pixels apart and a yard's tracks would merge into one dark hatch; the sleeper band
 * alone reads as the track there.
 */
const RAIL_ZOOM = 2.5;
const MAST_ZOOM = 1.5;

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
  let pixelated = options.pixelated;

  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: false });
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = BasicShadowMap;
  // The city is static, so shadows render once instead of every frame.
  renderer.shadowMap.autoUpdate = false;

  const scene = new Scene();
  const gradientMap = toonGradient();
  // One material for every cell: ground and trees carry no facade, so they get no windows.
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
  }));

  function build(entry: CellEntry): void {
    const { mesh, lines, detail } = buildCell(entry.cell, city.area, walls);
    entry.detail = detail;
    const surfaces = new Mesh(mesh.build({ facade: true }), material);
    surfaces.castShadow = true;
    surfaces.receiveShadow = true;
    const outlines = new LineSegments(lines.build(), ink);
    // Cells are culled by their boxes below: three's bounding spheres are far looser.
    entry.objects = [surfaces, outlines];
    surfaces.geometry.computeBoundingBox();
    entry.box.copy(surfaces.geometry.boundingBox!);
    for (const object of entry.objects) object.frustumCulled = false;
    scene.add(surfaces, outlines);
  }

  scene.add(new HemisphereLight(SKY_LIGHT, BOUNCE_LIGHT, 1.3));
  const sun = new DirectionalLight(SUN, 2.2);
  const light = lightFrame(SUN_DIRECTION);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  sun.shadow.camera.layers.set(1);
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
  const shadowFrustum = new Frustum();

  const camera = new OrthographicCamera(-1, 1, 1, -1, 1, CAMERA_DISTANCE * 2);
  const controls = new MapControls(camera, canvas);
  controls.enableRotate = false;
  controls.enableDamping = false;
  controls.zoomToCursor = true;
  controls.minZoom = 0.5;
  controls.maxZoom = 4;
  controls.cursorStyle = 'grab';
  controls.listenToKeyEvents(keyTarget); // arrow keys pan while the map has focus

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
  // their priority: a label that would overlap an earlier one, or the screen edge, is hidden.
  const labelEls = city.labels.map((label) => {
    const el = document.createElement('span');
    el.className = 'map-label';
    el.textContent = label.name;
    return el;
  });
  labelLayer.append(...labelEls);
  // Measure after all are in the DOM: one layout instead of one per label.
  const labels = labelEls.map((el, i) => ({
    el,
    w: el.offsetWidth,
    h: el.offsetHeight,
    world: new Vector3(city.labels[i]!.x, LABEL_HEIGHT, city.labels[i]!.z),
  }));
  const placed: [number, number, number, number][] = [];
  const projected = new Vector3();

  let width = 0;
  let height = 0;
  const buffer = new Vector2();
  function resize(): void {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    const ratio = pixelated
      ? 1 / Math.max(2, Math.round(h / PIXEL_ROWS))
      : Math.min(globalThis.devicePixelRatio || 1, 2);
    if (w === width && h === height && ratio === renderer.getPixelRatio()) return;
    width = w;
    height = h;
    renderer.setDrawingBufferSize(width, height, ratio); // one reallocation, style untouched
    // The buffer is floored to whole pixels, so take the aspect from it: game pixels stay square.
    renderer.getDrawingBufferSize(buffer);
    const halfH = VIEW_HEIGHT / 2;
    const halfW = halfH * (buffer.x / buffer.y);
    Object.assign(camera, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
    camera.updateProjectionMatrix();
    invalidate();
  }

  const frustum = new Frustum();
  const viewProjection = new Matrix4();
  const corner = new Vector3();
  const forward = new Vector3();
  /** Builds any cell the camera can see, and fits the shadow map to the view. */
  function prepare(): void {
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection);
    for (const entry of cells) {
      if (!entry.objects.length && frustum.intersectsBox(entry.box)) build(entry);
    }

    // The ground under the screen's corners, as far as shadows can reach into the view.
    camera.getWorldDirection(forward);
    const ground = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([x, y]): V3 => {
      corner.set(x!, y!, -1).unproject(camera);
      corner.addScaledVector(forward, -corner.y / forward.y);
      return [corner.x, 0, corner.z];
    });
    const need = shadowNeeds(light, ground);
    need.half += SHADOW_REACH;
    if (shadow && shadowCovers(shadow, need)) return;
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
    // Everything that can cast into the square has to exist before its one shadow pass.
    for (const entry of cells) {
      if (!entry.objects.length && shadowFrustum.intersectsBox(entry.box)) build(entry);
    }
    renderer.shadowMap.needsUpdate = true;
  }

  /**
   * Shows only the cells in view. On a frame that redraws the shadow map, the cells that cast
   * into it join the shadow camera's layer, so the shadow pass draws them and the view doesn't.
   */
  function cull(): void {
    const shadowPass = renderer.shadowMap.needsUpdate;
    const zoom = camera.zoom;
    for (const { box, objects, detail } of cells) {
      const [surfaces, outlines] = objects as [Mesh?, LineSegments?];
      if (!surfaces || !outlines) continue;
      const skip = zoom < MAST_ZOOM ? detail.masts : zoom < RAIL_ZOOM ? detail.rails : 0;
      outlines.geometry.setDrawRange(skip * 2, Infinity);
      const inView = frustum.intersectsBox(box);
      const casts = shadowPass && shadowFrustum.intersectsBox(box);
      surfaces.layers.mask = (inView ? VIEW_LAYER : 0) | (casts ? SHADOW_LAYER : 0);
      surfaces.visible = inView || casts;
      outlines.visible = inView;
    }
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
    }
    invalidate();
    if (cells.some((entry) => !entry.objects.length)) idleHandle = idle(buildInBackground);
  }

  const right = new Vector3();
  const up = new Vector3();
  const saved = new Vector3();
  function render(): void {
    // Snap the camera to whole game pixels so edges don't shimmer while panning.
    saved.copy(camera.position);
    if (pixelated) {
      camera.updateMatrixWorld();
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      up.setFromMatrixColumn(camera.matrixWorld, 1);
      const unit =
        (camera.top - camera.bottom) / camera.zoom / renderer.getDrawingBufferSize(buffer).y;
      const r = camera.position.dot(right);
      const u = camera.position.dot(up);
      camera.position
        .addScaledVector(right, Math.round(r / unit) * unit - r)
        .addScaledVector(up, Math.round(u / unit) * unit - u);
    }
    camera.updateMatrixWorld();
    prepare();
    cull();
    const shadowPass = renderer.shadowMap.needsUpdate;
    renderer.render(scene, camera);
    // The cost of this very frame, for the smoke test and anyone debugging. Frames that redraw
    // the static shadow map (on load, and when the view leaves its square) cost more.
    Object.assign(canvas.dataset, {
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      shadowPass,
    });

    placed.length = 0;
    for (const { el, w, h, world } of labels) {
      projected.copy(world).project(camera);
      const x = ((projected.x + 1) / 2) * width;
      const y = ((1 - projected.y) / 2) * height;
      const box: [number, number, number, number] = [x - w / 2, y - h, x + w / 2, y];
      const fits = box[0] >= 0 && box[1] >= 0 && box[2] <= width && box[3] <= height;
      const clash = placed.some(
        (b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1],
      );
      el.hidden = !fits || clash;
      if (el.hidden) continue;
      placed.push(box);
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
    camera.position.copy(saved);
  }

  let frame = 0;
  function renderNow(): void {
    cancelAnimationFrame(frame);
    frame = 0;
    render();
  }
  function invalidate(): void {
    if (frame) return;
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
      renderNow(); // already inside a frame: don't wait for the next one
      spin = t < 1 ? requestAnimationFrame(step) : 0;
    };
    spin = requestAnimationFrame(step);
  }

  function zoomBy(factor: number): void {
    camera.zoom = Math.min(controls.maxZoom, Math.max(controls.minZoom, camera.zoom * factor));
    camera.updateProjectionMatrix();
    controls.update();
    invalidate();
  }

  function resetView(): void {
    cancelAnimationFrame(spin);
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

  // After a lost-and-restored GPU context (backgrounded phone tabs), redraw shadows and frame.
  const onRestored = () => {
    renderer.shadowMap.needsUpdate = true;
    invalidate();
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
    setPixelated(on) {
      if (on === pixelated) return;
      pixelated = on;
      resize();
    },
    stats: () => ({
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    }),
    dispose() {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(spin);
      cancelIdle(idleHandle);
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
