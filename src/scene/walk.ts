import {
  BackSide,
  BufferAttribute,
  Color,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Raycaster,
  SphereGeometry,
  Vector2,
} from 'three';
import type { Fog, OrthographicCamera, Scene, Texture } from 'three';
import type { MapControls } from 'three/addons/controls/MapControls.js';

import type { City } from '../data/city.ts';
import { createWalkSounds } from '../audio/walking.ts';
import { Router } from '../data/route.ts';
import { WalkGrid, pickWalkable } from '../data/walkable.ts';
import { createCharacterMaterial, createXrayMaterial } from './character-material.ts';
import { CHARACTER_SCALE, applyPose, createCharacter, poseAt, restPose } from './character.ts';
import type { Character } from './character.ts';
import {
  CHASE_FOV,
  LOOK_HEIGHT,
  MAP_FOV,
  boomDirection,
  chaseFov,
  createBoom,
  flight,
  freeLength,
  headLook,
  mapYaw,
  settleReach,
  spanAt,
  stretchBoom,
  swingBehind,
  turnBoom,
  wrap,
} from './chase.ts';
import type { Boom, Lens, Shot, Vec3 } from './chase.ts';
import { SKY } from './palette.ts';
import { passedVertices, routeMarker } from './route-marker.ts';
import type { RouteMarker } from './route-marker.ts';
import { WALK_SPEED, createWalker, followRoute, runBlend, stepWalker } from './walker.ts';
import type { Walker } from './walker.ts';

/**
 * Walk mode, wired to the viewer: pick a spot on the map, fly down behind the walker, then
 * walk or run with the keys, a thumb stick or by clicking where to go, and drag to look
 * around. Animates only while something moves; otherwise the viewer is back to rendering on
 * demand. The logic it drives (walkability, routes, steering, poses, the camera boom) is pure
 * and tested elsewhere; this file is the browser glue.
 */

export type WalkMode = 'map' | 'pick' | 'walk';

/** How far the nearest walkable spot may lie from a click (m): wider when choosing a start. */
const CLICK_REACH = 8;
const START_REACH = 30;
/** A press that moves less than this (px) and lifts within TAP_MS is a click, not a drag. */
const TAP_SLOP = 8;
const TAP_MS = 600;
/** The flight from the map down to the walker, and back (s). */
const FLIGHT = 1.4;
/** The figure pops up over this long once the camera is close (s). */
const APPEAR = 0.3;
/** Half the figure's width (m): how close steering may bring its middle to a wall. */
const BODY_RADIUS = 0.5;
/**
 * Feet just above the squares, the highest ground layer, so the outline under the soles never
 * dips below the street (where the x-ray would show it).
 */
const GROUND_Y = 0.32;
/** The city fades into the haze from FOG_NEAR to FOG_FAR beyond the walker (m). */
const FOG_NEAR = 90;
const FOG_FAR = 330;
/** How quickly the camera's look point follows the walker (per second, exponential). */
const FOLLOW_RATE = 14;
/** Holding a turn key turns the view this fast (rad/s); a turn button turns it this far. */
const LOOK_KEY_RATE = 1.9;
const TURN_STEP = Math.PI / 4;
/** After a drag, routes leave the camera alone this long before swinging it behind (ms). */
const LOOK_HOLD_MS = 1800;
const SWING_RATE = 1.4;
/** The thumb stick: how far it reaches (px); pushed to the rim, it runs. */
const STICK_RADIUS = 52;
/** Touches that start in this share of the screen, from its left edge, steer. */
const STICK_SHARE = 0.42;
const ISO_PITCH = Math.atan(1 / Math.SQRT2);
/** Within this distance of the walker (m), the flight checks it can still see it. */
const FLIGHT_CHECK = 400;

export interface WalkHost {
  scene: Scene;
  /** The map's camera; walking brings its own. */
  camera: OrthographicCamera;
  controls: MapControls;
  canvas: HTMLCanvasElement;
  /** A layer over the canvas that takes no pointer events, for the thumb stick. */
  overlay: HTMLElement;
  city: City;
  gradientMap: Texture;
  /** The scene's fog, kept far off on the map: walking draws it in to the haze. */
  fog: Fog;
  reducedMotion: boolean;
  /** The map camera's yaw, read and set. */
  yaw(): number;
  setYaw(yaw: number): void;
  /** Re-aims the map camera at the controls' target. */
  placeCamera(): void;
  /** Draws with this camera from now on, or with the map's again. */
  useView(camera: PerspectiveCamera | null): void;
  /** Draws a frame now. */
  render(): void;
  onModeChange?(mode: WalkMode): void;
  /** A click or start spot that can't be walked to. */
  onBlocked?(): void;
}

export interface Walk {
  readonly mode: WalkMode;
  /** Whether a walk frame is already on its way, so the viewer needn't draw one of its own. */
  readonly animating: boolean;
  /**
   * While flying between map and street, the height of the view at the map's end (m): enough
   * ground for shadows to cover the whole flight, so they're fitted once, not every frame.
   */
  readonly flightSpan: number | undefined;
  /** Ends a flight back to the map at once, for when the map takes the camera. */
  land(): void;
  /** The canvas changed size: the walking camera's lens follows. */
  resized(): void;
  /** Waits for a click on the map that says where to start. */
  pick(): void;
  /** Starts at the walkable spot nearest the middle of the view. */
  startAtCentre(): void;
  /** Back to the map, where the walk ended. */
  exit(): void;
  /** Walks toward a direction on screen: right and up, each from -1 to 1. */
  steer(right: number, up: number): void;
  /** Runs instead of walking, while on. */
  run(on: boolean): void;
  /** Turns the view while held: -1 left, 1 right, 0 stops. */
  look(direction: number): void;
  /** Turns the view an eighth of the way round: -1 left, 1 right. */
  turn(direction: 1 | -1): void;
  /** Brings the camera closer (factor above 1) or further. */
  zoom(factor: number): void;
  dispose(): void;
}

/** A sky dome, horizon haze to blue overhead, drawn behind the city while walking. */
function createSky(): Mesh {
  const geometry = new SphereGeometry(1, 24, 12);
  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  const [low, high] = [new Color(SKY.horizon), new Color(SKY.top)];
  const color = new Color();
  for (let i = 0; i < position.count; i++) {
    const up = Math.min(1, Math.max(0, position.getY(i) / 0.45));
    color.lerpColors(low, high, up * up * (3 - 2 * up)).toArray(colors, i * 3);
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  const sky = new Mesh(
    geometry,
    new MeshBasicMaterial({
      vertexColors: true,
      side: BackSide,
      fog: false,
      depthWrite: false,
      transparent: true,
    }),
  );
  sky.frustumCulled = false;
  sky.visible = false;
  sky.renderOrder = -1;
  return sky;
}

export function createWalk(host: WalkHost): Walk {
  const { scene, camera, controls, canvas, reducedMotion } = host;
  let mode: WalkMode = 'map';

  // The walk grid is built the first time someone wants to walk, not with the map.
  let grid: WalkGrid | undefined;
  let router: Router | undefined;
  /** Keys steer the figure's body clear of facades; routes keep their own distance. */
  const walkable = (x: number, z: number, dx: number, dz: number) =>
    grid!.walkable(x, z, BODY_RADIUS, dx, dz);
  const heightAt = (x: number, z: number) => grid!.buildingHeight(x, z);
  const ensureGrid = () => {
    grid ??= new WalkGrid(host.city);
    router ??= new Router(grid);
    return grid;
  };

  const view = new PerspectiveCamera(CHASE_FOV, 1, 0.1, 1000);
  const { fog } = host;
  const sky = createSky();
  scene.add(sky);

  let character: Character | undefined;
  const body = createCharacterMaterial(host.gradientMap);
  const xray = createXrayMaterial();
  const hint = new Mesh(undefined, new MeshBasicMaterial({ vertexColors: true }));
  hint.frustumCulled = false;
  hint.visible = false;
  let marker: RouteMarker | undefined;
  const sounds = createWalkSounds();
  let walker: Walker | undefined;
  const pose = restPose();
  let appear = 1;
  let head = 0;

  const boom: Boom = createBoom(0);
  const lookAt: Vec3 = [0, 0, 0];
  const out: Vec3 = [0, 0, 0];
  /** Flight progress: 0 on the map, 1 behind the walker; and which way it's going. */
  let flown = 0;
  let flying: -1 | 0 | 1 = 0;
  const mapShot: Shot = { look: [0, 0, 0], yaw: 0, pitch: ISO_PITCH, fov: MAP_FOV, span: 1 };
  const chaseShot: Shot = { look: lookAt, yaw: 0, pitch: 0, fov: CHASE_FOV, span: 1 };
  const lens: Lens = { look: [0, 0, 0], yaw: 0, pitch: 0, fov: CHASE_FOV, distance: 1 };
  let mapZoomBefore = 1;

  let keyRight = 0;
  let keyUp = 0;
  let running = false;
  let lookKeys = 0;
  let turnLeft = 0;
  let lastLook = -Infinity;
  let frame = 0;
  let last = 0;

  function setMode(next: WalkMode): void {
    if (next === mode) return;
    mode = next;
    // Picking takes clicks on the map; walking takes the pointer for itself.
    controls.cursorStyle = next === 'map' ? 'grab' : 'auto';
    if (next !== 'map') canvas.style.cursor = next === 'pick' ? 'crosshair' : 'pointer';
    controls.enabled = next !== 'walk' && flying === 0;
    canvas.dataset.walk = next;
    host.onModeChange?.(next);
  }

  function clearRoute(): void {
    hint.visible = false;
    hint.geometry.dispose();
    marker = undefined;
  }

  /** Height of the map's view (m) at a zoom: where the flight starts and ends. */
  const mapSpan = (zoom: number) => (camera.top - camera.bottom) / zoom;

  function start(x: number, z: number): void {
    // Stepping into the picture: facing away from the camera, which stays behind.
    const yaw = host.yaw();
    walker = createWalker(x, z, wrap(yaw + Math.PI));
    Object.assign(boom, createBoom(yaw));
    if (!character) {
      character = createCharacter(body, xray);
      scene.add(character.mesh, hint);
    }
    character.mesh.visible = true;
    character.mesh.scale.setScalar(0);
    appear = reducedMotion ? 1 : 0;
    head = 0;
    clearRoute();
    [lookAt[0], lookAt[1], lookAt[2]] = [x, GROUND_Y + LOOK_HEIGHT, z];
    const t = controls.target;
    Object.assign(mapShot, { yaw, pitch: ISO_PITCH, fov: MAP_FOV, span: mapSpan(camera.zoom) });
    [mapShot.look[0], mapShot.look[1], mapShot.look[2]] = [t.x, t.y, t.z];
    // No flight with reduced motion, or for nobody: a hidden page draws no frames to fly in.
    const cut = reducedMotion || document.hidden;
    flown = cut ? 1 : 0;
    flying = cut ? 0 : 1;
    host.useView(view);
    publish();
    setMode('walk');
    sounds.enter();
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
    raycaster.setFromCamera(ndc, mode === 'walk' ? view : camera);
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
    sounds.routeStart();
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

  // The thumb stick: a ring under the thumb and a knob that follows it, shown while steering.
  const ring = document.createElement('div');
  ring.className = 'stick';
  ring.hidden = true;
  const knob = document.createElement('div');
  knob.className = 'stick-knob';
  ring.append(knob);
  host.overlay.append(ring);
  const stick = { right: 0, up: 0, run: false };
  function releaseStick(): void {
    Object.assign(stick, { right: 0, up: 0, run: false });
    ring.hidden = true;
  }

  // Taps and clicks, told apart from drags (looking around, or the thumb stick) and pinches.
  interface Press {
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    time: number;
    dragged: boolean;
    stick: boolean;
  }
  const presses = new Map<number, Press>();
  let multi = false;
  let pinch = 0;
  const onPointerDown = (event: PointerEvent) => {
    if (mode === 'map') return;
    // Picking takes the main button only; walking looks around with any.
    if (mode === 'pick' && event.button !== 0) return;
    multi = presses.size > 0;
    const rect = canvas.getBoundingClientRect();
    let steering = mode === 'walk' && event.pointerType !== 'mouse';
    steering &&= event.clientX - rect.left < rect.width * STICK_SHARE;
    for (const press of presses.values()) steering &&= !press.stick;
    presses.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      time: event.timeStamp,
      dragged: false,
      stick: steering,
    });
    if (mode === 'walk') canvas.setPointerCapture(event.pointerId);
    pinch = 0;
  };
  const onPointerMove = (event: PointerEvent) => {
    const press = presses.get(event.pointerId);
    if (!press) return;
    const [dx, dy] = [event.clientX - press.x, event.clientY - press.y];
    // Picking, a drag pans the map; it isn't a tap either.
    press.dragged ||= Math.hypot(dx, dy) >= TAP_SLOP;
    if (mode !== 'walk') return;
    const [moveX, moveY] = [event.clientX - press.lastX, event.clientY - press.lastY];
    [press.lastX, press.lastY] = [event.clientX, event.clientY];
    if (press.stick) {
      const length = Math.hypot(dx, dy);
      if (!press.dragged || length < 1e-3) {
        stick.right = 0;
        stick.up = 0;
        return;
      }
      const reach = Math.min(length, STICK_RADIUS);
      const [ux, uy] = [dx / length, dy / length];
      Object.assign(stick, {
        right: (ux * reach) / STICK_RADIUS,
        up: (-uy * reach) / STICK_RADIUS,
        // Past the rim it runs; it eases back to a walk only well inside, so it doesn't flicker.
        run: length >= STICK_RADIUS * (stick.run ? 1.15 : 1.4),
      });
      ring.hidden = false;
      ring.style.translate = `${press.x}px ${press.y}px`;
      // The knob stays inside the ring, 30 px from its middle at most.
      const travel = (reach / STICK_RADIUS) * 30;
      knob.style.translate = `${ux * travel}px ${uy * travel}px`;
      wake();
      return;
    }
    let other: Press | undefined;
    for (const [id, p] of presses) if (id !== event.pointerId && !p.stick) other = p;
    if (other) {
      // Two fingers pinch the camera closer or further.
      const apart = Math.hypot(other.lastX - press.lastX, other.lastY - press.lastY);
      if (pinch > 0 && apart > 0) stretchBoom(boom, pinch / apart);
      pinch = apart;
    } else if (press.dragged) {
      // Grab the world: it turns with the pointer, and dragging down looks up.
      const scale = (Math.PI * 1.2) / Math.max(700, canvas.clientWidth);
      turnBoom(boom, moveX * scale, -moveY * scale);
      canvas.style.cursor = 'grabbing';
    } else return;
    lastLook = event.timeStamp;
    wake();
  };
  const onPointerUp = (event: PointerEvent) => {
    const press = presses.get(event.pointerId);
    if (!press) return;
    presses.delete(event.pointerId);
    pinch = 0;
    if (press.stick) {
      releaseStick();
      wake();
    }
    if (mode === 'walk') canvas.style.cursor = 'pointer';
    const quick = event.timeStamp - press.time < TAP_MS;
    if (mode !== 'map' && !press.dragged && !multi && quick && event.button === 0) {
      onClick(event.clientX, event.clientY);
    }
  };
  const onPointerCancel = (event: PointerEvent) => {
    if (presses.get(event.pointerId)?.stick) releaseStick();
    presses.delete(event.pointerId);
  };
  const onWheel = (event: WheelEvent) => {
    if (mode !== 'walk') return;
    event.preventDefault();
    stretchBoom(boom, Math.exp(event.deltaY * 0.0015));
    wake();
  };
  const onContextMenu = (event: Event) => {
    if (mode === 'walk') event.preventDefault();
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);
  // A hidden page draws no frames: a flight under way ends where it was going, at once.
  const onVisibility = () => {
    if (!document.hidden || !flying) return;
    if (flying === -1) land();
    else {
      flying = 0;
      flown = 1;
      placeView();
    }
    host.render();
  };
  document.addEventListener('visibilitychange', onVisibility);

  function wake(): void {
    if (frame) return;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }

  /** Back on the map: the map camera takes over where the flight out ended. */
  function land(): void {
    flying = 0;
    flown = 0;
    host.useView(null);
    sky.visible = false;
    fog.near = 1e7;
    fog.far = 1e7 + 1;
    if (walker) controls.target.set(walker.x, 0, walker.z);
    walker = undefined;
    if (character) character.mesh.visible = false;
    clearRoute();
    host.setYaw(mapShot.yaw);
    camera.zoom = Math.min(controls.maxZoom, Math.max(controls.minZoom, mapZoomBefore));
    camera.updateProjectionMatrix();
    controls.enabled = mode !== 'walk';
    host.placeCamera();
    publish();
  }

  function tick(now: number): void {
    frame = 0;
    const elapsed = Math.max(0, (now - last) / 1000);
    // Steps stay small however long a frame took; the flight keeps to the clock.
    const dt = Math.min(0.05, elapsed);
    last = now;
    let busy = false;

    if (walker && character) {
      if (mode === 'walk') {
        // Keys and the stick steer relative to the screen: up is away from the camera.
        const steering = stick.right !== 0 || stick.up !== 0;
        const right = steering ? stick.right : keyRight;
        const up = steering ? stick.up : keyUp;
        const fx = -Math.sin(boom.yaw);
        const fz = -Math.cos(boom.yaw);
        const sx = -fz * right + fx * up;
        const sz = fx * right + fz * up;
        busy = stepWalker(walker, dt, sx, sz, walkable, running || stick.run);
        sounds.stride(walker.phase, walker.speed, runBlend(walker.speed));
        busy ||= sx !== 0 || sz !== 0;
        if (reducedMotion) walker.still = Math.max(walker.still, 1e3); // no idle fidgeting

        if (lookKeys) turnBoom(boom, -lookKeys * LOOK_KEY_RATE * dt, 0);
        if (turnLeft) {
          const step = reducedMotion ? turnLeft : turnLeft * (1 - Math.exp(-10 * dt));
          turnBoom(boom, step, 0);
          turnLeft = Math.abs(turnLeft - step) < 1e-3 ? 0 : turnLeft - step;
        }
        if (lookKeys !== 0 || turnLeft !== 0) {
          busy = true;
          lastLook = now;
        }
        // Walking a route, the camera swings round behind unless someone is looking about.
        if (walker.route && now - lastLook > LOOK_HOLD_MS && !reducedMotion) {
          const rate = SWING_RATE * Math.min(1, walker.speed / WALK_SPEED);
          swingBehind(boom, walker.heading, rate, dt);
        }
      }

      // The head turns where the camera looks, less so at a run.
      const goal = headLook(walker.heading, boom.yaw) * (1 - 0.6 * runBlend(walker.speed));
      head += (goal - head) * (reducedMotion ? 1 : 1 - Math.exp(-6 * dt));
      busy ||= Math.abs(goal - head) > 0.01;
      applyPose(
        character,
        poseAt(
          pose,
          walker.speed,
          walker.phase,
          walker.still,
          !reducedMotion,
          walker.turning,
          head,
        ),
      );
      if (flown > 0.5 || !flying) appear = Math.min(1, appear + dt / APPEAR);
      // Pops up with a little overshoot.
      const pop = appear < 1 ? 1 + 2.7 * (appear - 1) ** 3 + 1.7 * (appear - 1) ** 2 : 1;
      character.mesh.scale.setScalar(CHARACTER_SCALE * pop);
      character.mesh.position.set(walker.x, GROUND_Y, walker.z);
      character.mesh.rotation.y = walker.heading;
      busy ||= appear < 1;

      if (marker && !walker.route) {
        if (walker.speed === 0) sounds.routeEnd(); // arrived, rather than steered off it
        clearRoute();
      }
      if (marker) hint.geometry.setDrawRange(passedVertices(marker, walker.travelled), Infinity);

      // The camera's look point trails the walker by a hair, and the boom shortens for walls.
      const follow = reducedMotion ? 1 : 1 - Math.exp(-FOLLOW_RATE * dt);
      lookAt[0] += (walker.x - lookAt[0]) * follow;
      lookAt[1] += (GROUND_Y + LOOK_HEIGHT - lookAt[1]) * follow;
      lookAt[2] += (walker.z - lookAt[2]) * follow;
      busy ||= Math.hypot(walker.x - lookAt[0], walker.z - lookAt[2]) > 0.002;
      boomDirection(boom.yaw, boom.pitch, out);
      const free = freeLength(heightAt, lookAt, out, boom.distance);
      boom.reach = reducedMotion ? free : settleReach(boom.reach, free, dt);
      busy ||= Math.abs(boom.reach - free) > 0.01;
      controls.target.set(walker.x, 0, walker.z);

      if (flying) {
        flown = Math.min(1, Math.max(0, flown + (flying * elapsed) / FLIGHT));
        busy = true;
        if (flying === 1 && flown === 1) flying = 0;
      }
      placeView();
      if (flying === -1 && flown === 0) land();
    }

    host.render();
    if (busy && walker) frame = requestAnimationFrame(tick);
    else publish();
  }

  /** Puts the walking camera where the boom (or the flight along it) says. */
  function placeView(): void {
    const fov = chaseFov(canvas.clientWidth / Math.max(1, canvas.clientHeight));
    chaseShot.yaw = boom.yaw;
    chaseShot.pitch = boom.pitch;
    chaseShot.fov = fov;
    chaseShot.span = spanAt(boom.reach, fov);
    flight(mapShot, chaseShot, flown, lens);
    boomDirection(lens.yaw, lens.pitch, out);
    const d = lens.distance;
    view.position.set(
      lens.look[0] + out[0] * d,
      lens.look[1] + out[1] * d,
      lens.look[2] + out[2] * d,
    );
    if (flown < 1) {
      // Swooping down, keep the walker in sight: no flying through houses on the way.
      const { x, y, z } = view.position;
      const length = Math.hypot(x - lookAt[0], y - lookAt[1], z - lookAt[2]);
      if (length < FLIGHT_CHECK) {
        out[0] = (x - lookAt[0]) / length;
        out[1] = (y - lookAt[1]) / length;
        out[2] = (z - lookAt[2]) / length;
        const free = freeLength(heightAt, lookAt, out, length);
        if (free < length) {
          view.position.set(
            lookAt[0] + out[0] * free,
            lookAt[1] + out[1] * free,
            lookAt[2] + out[2] * free,
          );
        }
      }
    }
    view.lookAt(lens.look[0], lens.look[1], lens.look[2]);
    // High up the flight there is no haze, and the whole map is in reach. Haze, sky and far
    // plane keep their order all the way: the haze ends inside the sky, the sky inside the far.
    // The walker is the nearest thing worth keeping in view, wherever the camera was pulled to.
    const eye = view.position;
    const near = Math.min(d, Math.hypot(eye.x - lookAt[0], eye.y - lookAt[1], eye.z - lookAt[2]));
    const high = (1 - flown) * 4000;
    view.fov = lens.fov;
    view.near = Math.max(0.05, near * 0.02);
    view.far = d + FOG_FAR + 60 + high;
    view.updateProjectionMatrix();
    fog.near = d + FOG_NEAR + high;
    fog.far = d + FOG_FAR + high;
    sky.visible = true;
    sky.position.copy(view.position);
    sky.scale.setScalar(d + FOG_FAR + 30 + high);
    (sky.material as MeshBasicMaterial).opacity = flown * flown;
  }

  /** Where the walker stands, once it stands still: for the smoke test and anyone debugging. */
  function publish(): void {
    canvas.dataset.walker = walker ? `${walker.x.toFixed(1)} ${walker.z.toFixed(1)}` : '';
  }

  return {
    get mode() {
      return mode;
    },
    get animating() {
      return frame !== 0;
    },
    get flightSpan() {
      return flying
        ? mapShot.span * Math.max(1, canvas.clientWidth / canvas.clientHeight)
        : undefined;
    },
    land() {
      if (flying === -1) land();
    },
    resized() {
      if (walker) wake();
    },
    pick() {
      if (flying === -1) land();
      ensureGrid();
      if (mode === 'map') mapZoomBefore = camera.zoom;
      setMode('pick');
    },
    startAtCentre() {
      if (mode === 'map') mapZoomBefore = camera.zoom;
      const rect = canvas.getBoundingClientRect();
      const spot = spotAt(rect.left + rect.width / 2, rect.top + rect.height / 2, START_REACH);
      if (spot) start(...spot);
      else host.onBlocked?.();
    },
    exit() {
      if (mode === 'map') return;
      const walked = mode === 'walk';
      [keyRight, keyUp, lookKeys, turnLeft] = [0, 0, 0, 0];
      releaseStick();
      presses.clear();
      setMode('map');
      if (!walked || !walker) return;
      sounds.leave();
      walker.route = null;
      clearRoute();
      // Fly back up to the map, turned to the nearest of its four views.
      const zoom = Math.min(controls.maxZoom, Math.max(controls.minZoom, mapZoomBefore));
      Object.assign(mapShot, { yaw: mapYaw(boom.yaw), span: mapSpan(zoom) });
      [mapShot.look[0], mapShot.look[1], mapShot.look[2]] = [walker.x, 0, walker.z];
      if (reducedMotion || document.hidden) {
        land();
        host.render();
        return;
      }
      flying = -1;
      controls.enabled = false;
      wake();
    },
    steer(right, up) {
      [keyRight, keyUp] = [right, up];
      if (right || up) wake();
    },
    run(on) {
      running = on;
    },
    look(direction) {
      lookKeys = direction;
      if (direction) wake();
    },
    turn(direction) {
      turnLeft -= direction * TURN_STEP;
      wake();
    },
    zoom(factor) {
      stretchBoom(boom, 1 / factor);
      wake();
    },
    dispose() {
      cancelAnimationFrame(frame);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('visibilitychange', onVisibility);
      ring.remove();
      hint.geometry.dispose();
      (hint.material as MeshBasicMaterial).dispose();
      sky.geometry.dispose();
      (sky.material as MeshBasicMaterial).dispose();
      body.dispose();
      xray.dispose();
    },
  };
}
