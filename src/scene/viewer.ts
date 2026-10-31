import {
  BasicShadowMap,
  DataTexture,
  DirectionalLight,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshToonMaterial,
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
import { buildingsGeometry } from './buildings.ts';
import { createFacadeMaterial } from './facade-material.ts';
import { groundGeometry } from './ground.ts';
import { BOUNCE_LIGHT, OUTLINE, SKY_LIGHT, SUN } from './palette.ts';
import { createTrees } from './trees.ts';

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
  const material = new MeshToonMaterial({ vertexColors: true, gradientMap });

  const ground = new Mesh(groundGeometry(city), material);
  ground.receiveShadow = true;
  const blocks = buildingsGeometry(city.buildings);
  const buildings = new Mesh(blocks.surfaces, createFacadeMaterial(gradientMap));
  buildings.castShadow = true;
  buildings.receiveShadow = true;
  const outlines = new LineSegments(blocks.outlines, new LineBasicMaterial({ color: OUTLINE }));
  const trees = createTrees(city.trees, material);
  scene.add(ground, buildings, outlines, trees);

  const { minX, minZ, maxX, maxZ } = city.bounds;
  const center = new Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
  const span = Math.max(maxX - minX, maxZ - minZ);

  scene.add(new HemisphereLight(SKY_LIGHT, BOUNCE_LIGHT, 1.3));
  const sun = new DirectionalLight(SUN, 2.2);
  // Golden hour from the south-west, low enough for long shadows.
  sun.position.copy(center).add(new Vector3(-0.55, 0.62, 0.56).multiplyScalar(span));
  sun.target.position.copy(center);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  Object.assign(sun.shadow.camera, {
    left: -span * 0.65,
    right: span * 0.65,
    top: span * 0.65,
    bottom: -span * 0.65,
    near: 1,
    far: span * 3,
  });
  scene.add(sun, sun.target);

  const camera = new OrthographicCamera(-1, 1, 1, -1, 1, CAMERA_DISTANCE * 2);
  const controls = new MapControls(camera, canvas);
  controls.enableRotate = false;
  controls.enableDamping = false;
  controls.zoomToCursor = true;
  controls.minZoom = 0.5;
  // Past 4× the 2048² shadow map shows its texels; a bigger map would cost memory everywhere.
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
    renderer.render(scene, camera);

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
    const cx = Math.min(Math.max(t.x, minX), maxX);
    const cz = Math.min(Math.max(t.z, minZ), maxZ);
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
