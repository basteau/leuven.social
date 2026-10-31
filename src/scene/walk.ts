import { Mesh, MeshBasicMaterial, Raycaster, Vector2, Vector3 } from 'three';
import type { OrthographicCamera, Scene, Texture } from 'three';
import type { MapControls } from 'three/addons/controls/MapControls.js';

import type { City } from '../data/city.ts';
import { Router } from '../data/route.ts';
import { WalkGrid, pickWalkable } from '../data/walkable.ts';
import { createCharacterMaterial, createXrayMaterial } from './character-material.ts';
import { CHARACTER_SCALE, applyPose, createCharacter, poseAt, restPose } from './character.ts';
import type { Character } from './character.ts';
import { passedVertices, routeMarker } from './route-marker.ts';
import type { RouteMarker } from './route-marker.ts';
import { createWalker, followRoute, stepWalker } from './walker.ts';
import type { Walker } from './walker.ts';

/**
 * Walk mode, wired to the viewer: pick a spot on the map, then walk with the keys or by
 * clicking where to go. Animates only while something moves; otherwise the viewer is back to
 * rendering on demand. The logic it drives (walkability, routes, steering, poses) is pure and
 * tested elsewhere; this file is the browser glue.
 */

export type WalkMode = 'map' | 'pick' | 'walk';

/** Close enough to see the stride, far enough to see where to go next. */
const WALK_ZOOM = 7;
const WALK_ZOOM_RANGE = [3.5, 12] as const;
/** How quickly the camera catches up with the walker, and settles its zoom (per second). */
const FOLLOW_RATE = 6;
const ZOOM_RATE = 9;
/** How far the nearest walkable spot may lie from a click (m): wider when choosing a start. */
const CLICK_REACH = 8;
const START_REACH = 30;
/** A press that moves less than this (px) and lifts within TAP_MS is a click, not a drag. */
const TAP_SLOP = 8;
const TAP_MS = 600;
/** The figure pops up over this long when it arrives on the map (s). */
const APPEAR = 0.3;
/** Half the figure's width (m): how close steering may bring its middle to a wall. */
const BODY_RADIUS = 0.5;
/** Feet on the squares, which sit highest of the ground layers. */
const GROUND_Y = 0.2;

export interface WalkHost {
  scene: Scene;
  camera: OrthographicCamera;
  controls: MapControls;
  canvas: HTMLCanvasElement;
  keyTarget: HTMLElement;
  city: City;
  gradientMap: Texture;
  reducedMotion: boolean;
  /** Re-aims the camera at the controls' target. */
  placeCamera(): void;
  /** Draws a frame now. */
  render(): void;
  onModeChange?(mode: WalkMode): void;
  /** A click or start spot that can't be walked to. */
  onBlocked?(): void;
}

export interface Walk {
  readonly mode: WalkMode;
  /** Waits for a click on the map that says where to start. */
  pick(): void;
  /** Starts at the walkable spot nearest the middle of the view. */
  startAtCentre(): void;
  /** Back to the map, where the walk ended. */
  exit(): void;
  /** Walks toward a direction on screen: right and up, each from -1 to 1. */
  steer(right: number, up: number): void;
  dispose(): void;
}

export function createWalk(host: WalkHost): Walk {
  const { scene, camera, controls, canvas, reducedMotion } = host;
  const mapZoom = [controls.minZoom, controls.maxZoom] as const;
  let mode: WalkMode = 'map';

  // The walk grid is built the first time someone wants to walk, not with the map.
  let grid: WalkGrid | undefined;
  let router: Router | undefined;
  /** Keys steer the figure's body clear of facades; routes keep their own distance. */
  const walkable = (x: number, z: number) => grid!.walkable(x, z, BODY_RADIUS);
  const ensureGrid = () => {
    grid ??= new WalkGrid(host.city);
    router ??= new Router(grid);
    return grid;
  };

  let character: Character | undefined;
  const body = createCharacterMaterial(host.gradientMap);
  const xray = createXrayMaterial();
  const hint = new Mesh(undefined, new MeshBasicMaterial({ vertexColors: true }));
  hint.frustumCulled = false;
  hint.visible = false;
  let marker: RouteMarker | undefined;
  let walker: Walker | undefined;
  const pose = restPose();
  let appear = 1;

  let steerRight = 0;
  let steerUp = 0;
  let zoomGoal: number | undefined;
  let frame = 0;
  let last = 0;
  const forward = new Vector3();

  function setMode(next: WalkMode): void {
    if (next === mode) return;
    mode = next;
    // Picking and walking take clicks; walking also takes the arrow keys and keeps the camera.
    controls.cursorStyle = next === 'map' ? 'grab' : 'auto';
    if (next !== 'map') canvas.style.cursor = next === 'pick' ? 'crosshair' : 'pointer';
    controls.enablePan = next !== 'walk';
    controls.zoomToCursor = next !== 'walk';
    if (next === 'walk') controls.stopListenToKeyEvents();
    else controls.listenToKeyEvents(host.keyTarget);
    canvas.dataset.walk = next;
    host.onModeChange?.(next);
  }

  /** Eases the zoom to `goal`, letting the controls' limits span the way there. */
  function zoomTo(goal: number): void {
    zoomGoal = goal;
    controls.minZoom = Math.min(camera.zoom, goal, mapZoom[0]);
    controls.maxZoom = Math.max(camera.zoom, goal, WALK_ZOOM_RANGE[1]);
  }

  function clearRoute(): void {
    hint.visible = false;
    hint.geometry.dispose();
    marker = undefined;
  }

  function start(x: number, z: number): void {
    // Face the camera on arrival, as if stepping into the picture.
    camera.getWorldDirection(forward);
    walker = createWalker(x, z, Math.atan2(-forward.x, -forward.z));
    if (!character) {
      character = createCharacter(body, xray);
      scene.add(character.mesh, hint);
    }
    character.mesh.visible = true;
    appear = reducedMotion ? 1 : 0;
    clearRoute();
    publish();
    setMode('walk');
    zoomTo(Math.max(camera.zoom, WALK_ZOOM));
    wake();
  }

  /** Where a click at client coordinates lands on walkable ground, or null. */
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  function spotAt(clientX: number, clientY: number, reach: number): [number, number] | null {
    const rect = canvas.getBoundingClientRect();
    ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const { origin, direction } = raycaster.ray;
    return pickWalkable(
      ensureGrid(),
      [origin.x, origin.y, origin.z],
      [direction.x, direction.y, direction.z],
      reach,
    );
  }

  function walkTo(x: number, z: number): void {
    if (!walker || !router || !grid) return;
    const from = grid.walkable(walker.x, walker.z)
      ? [walker.x, walker.z]
      : grid.nearest(walker.x, walker.z, 2);
    const route = from && router.route(from[0]!, from[1]!, x, z);
    if (!route) {
      host.onBlocked?.();
      return;
    }
    [walker.x, walker.z] = [route[0]!, route[1]!];
    followRoute(walker, route);
    hint.geometry.dispose();
    marker = routeMarker(route);
    hint.geometry = marker.geometry;
    hint.visible = true;
    wake();
  }

  function onClick(clientX: number, clientY: number): void {
    const spot = spotAt(clientX, clientY, mode === 'pick' ? START_REACH : CLICK_REACH);
    if (!spot) host.onBlocked?.();
    else if (mode === 'pick') start(...spot);
    else walkTo(...spot);
  }

  // Taps and clicks, told apart from drags and pinches.
  const press = { id: -1, x: 0, y: 0, time: 0, multi: false };
  const onPointerDown = (event: PointerEvent) => {
    if (mode === 'map') return;
    if (press.id !== -1) {
      press.multi = true;
      return;
    }
    Object.assign(press, {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
      multi: false,
    });
  };
  const onPointerUp = (event: PointerEvent) => {
    if (event.pointerId !== press.id) return;
    press.id = -1;
    const still = Math.hypot(event.clientX - press.x, event.clientY - press.y) < TAP_SLOP;
    if (mode !== 'map' && still && !press.multi && event.timeStamp - press.time < TAP_MS) {
      onClick(event.clientX, event.clientY);
    }
  };
  const onPointerCancel = () => {
    press.id = -1;
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);

  function wake(): void {
    if (frame) return;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }

  function tick(now: number): void {
    frame = 0;
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    const ease = reducedMotion ? 1 : 1 - Math.exp(-FOLLOW_RATE * dt);
    const zoomEase = reducedMotion ? 1 : 1 - Math.exp(-ZOOM_RATE * dt);
    let busy = false;

    if (walker && character && mode === 'walk') {
      // Keys steer relative to the screen: up is away from the camera.
      camera.getWorldDirection(forward);
      const length = Math.hypot(forward.x, forward.z);
      const [fx, fz] = [forward.x / length, forward.z / length];
      const sx = -fz * steerRight + fx * steerUp;
      const sz = fx * steerRight + fz * steerUp;
      busy = stepWalker(walker, dt, sx, sz, walkable) || sx !== 0 || sz !== 0;
      if (reducedMotion) walker.still = Math.max(walker.still, 1e3); // no idle fidgeting

      applyPose(character, poseAt(pose, walker.speed, walker.phase, walker.still, !reducedMotion));
      appear = Math.min(1, appear + dt / APPEAR);
      // Pops up with a little overshoot.
      const pop = appear < 1 ? 1 + 2.7 * (appear - 1) ** 3 + 1.7 * (appear - 1) ** 2 : 1;
      character.mesh.scale.setScalar(CHARACTER_SCALE * pop);
      character.mesh.position.set(walker.x, GROUND_Y, walker.z);
      character.mesh.rotation.y = walker.heading;
      busy ||= appear < 1;

      if (marker && !walker.route) clearRoute();
      if (marker) hint.geometry.setDrawRange(passedVertices(marker, walker.travelled), Infinity);

      const t = controls.target;
      const [dx, dz] = [walker.x - t.x, walker.z - t.z];
      t.x += dx * ease;
      t.z += dz * ease;
      busy ||= Math.hypot(dx, dz) > 0.01;
    }

    if (zoomGoal !== undefined) {
      camera.zoom += (zoomGoal - camera.zoom) * zoomEase;
      if (Math.abs(camera.zoom - zoomGoal) < zoomGoal * 0.002) {
        camera.zoom = zoomGoal;
        zoomGoal = undefined;
        [controls.minZoom, controls.maxZoom] = mode === 'walk' ? WALK_ZOOM_RANGE : mapZoom;
      }
      camera.updateProjectionMatrix();
      busy ||= zoomGoal !== undefined;
    }

    host.placeCamera();
    host.render();
    if (busy) frame = requestAnimationFrame(tick);
    else publish();
  }

  /** Where the walker stands, once it stands still: for the smoke test and anyone debugging. */
  function publish(): void {
    canvas.dataset.walker = walker ? `${walker.x.toFixed(1)} ${walker.z.toFixed(1)}` : '';
  }

  // The map's zoom before walking, to return to.
  let mapZoomBefore = 1;

  return {
    get mode() {
      return mode;
    },
    pick() {
      ensureGrid();
      if (mode === 'map') mapZoomBefore = camera.zoom;
      setMode('pick');
    },
    startAtCentre() {
      if (mode === 'map') mapZoomBefore = camera.zoom;
      const spot = spotAt(
        canvas.getBoundingClientRect().left + canvas.clientWidth / 2,
        canvas.getBoundingClientRect().top + canvas.clientHeight / 2,
        START_REACH,
      );
      if (spot) start(...spot);
      else host.onBlocked?.();
    },
    exit() {
      if (mode === 'map') return;
      const walked = mode === 'walk';
      [steerRight, steerUp] = [0, 0];
      walker = undefined;
      if (character) character.mesh.visible = false;
      clearRoute();
      setMode('map');
      if (walked) {
        zoomTo(Math.min(mapZoom[1], Math.max(mapZoom[0], mapZoomBefore)));
        wake();
      }
    },
    steer(right, up) {
      [steerRight, steerUp] = [right, up];
      if (right || up) wake();
    },
    dispose() {
      cancelAnimationFrame(frame);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      hint.geometry.dispose();
      (hint.material as MeshBasicMaterial).dispose();
      body.dispose();
      xray.dispose();
    },
  };
}
