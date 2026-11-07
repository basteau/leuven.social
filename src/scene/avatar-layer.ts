import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  Raycaster,
  Vector2,
} from 'three';
import type { OrthographicCamera, Scene, Texture } from 'three';

import { createWalkSounds } from '../audio/walking.ts';
import type { City } from '../data/city.ts';
import { Router } from '../data/route.ts';
import type { Terrain } from '../data/terrain.ts';
import { WalkGrid, pickWalkable } from '../data/walkable.ts';
import { avatarState, createAvatar, jump, stepAvatar } from './avatar.ts';
import type { Avatar, AvatarState } from './avatar.ts';
import type { Bikes, RideAction, RideState } from './bikes.ts';
import { createCharacterMaterial, createXrayMaterial } from './character-material.ts';
import type { Fade } from './character-material.ts';
import { CHARACTER_SCALE, applyPose, createCharacter, poseAt, restPose } from './character.ts';
import { loose } from './collide.ts';
import { BAYER } from './facade-material.ts';
import { LEAD, followStrength, recentre, screenSteer } from './follow.ts';
import type { Detail } from './lod.ts';
import type { MapControls } from './map-controls.ts';
import {
  MARK,
  MARKER_INDICES,
  avatarDot,
  markerDrop,
  markerGeometry,
  markerRadius,
  puff,
} from './marker.ts';
import { MeshBuilder, linearVertexColors } from './mesh-builder.ts';
import { clock, decay, ticks } from './motion.ts';
import { OUTLINE } from './palette.ts';
import { nearestParked } from './parked.ts';
import { passedVertices, routeMarker } from './route-marker.ts';
import type { RouteMarker } from './route-marker.ts';
import { walkSolids } from './solids.ts';
import { STEP, runBlend } from './walker.ts';

/**
 * The avatar in the scene: its figure (or, from further out, a marker), its route hint, the
 * marker where it's sent, and the camera keeping it in view. A chunk of its own, loaded once the
 * first frame is drawn; the avatar it draws is in its state from the start, on Grote Markt.
 * W A S D walk it by the screen, Shift runs, a tap on the ground routes it there (or, too far to
 * walk, puts it there), F takes a bike and Esc brings the camera back to it. Panning stays the
 * person's: following waits until a while after the last pan (follow.ts). Animates only while
 * something moves; otherwise the viewer renders on demand. The logic is pure and tested
 * elsewhere (avatar.ts, follow.ts, walker.ts, the walk grid and routes); this is the glue.
 */

/** How far the nearest walkable spot may lie from a tap (m), and from a place chosen by name. */
const TAP_REACH = 8;
const PLACE_REACH = 30;
/**
 * A tap further than this from the avatar (m), or with the view too far out to show its figure,
 * puts it there rather than walking it there.
 */
const ROUTE_REACH = 250;
/** A place chosen from the menu brings the camera at least this close (zoom). */
const PLACE_ZOOM = 8;
/** A spot nobody can reach: its greyed marker shakes and goes over this long (s). */
const NOPE = 0.55;
/** Under this much view (m), the marker is hidden by what stands in front of it. */
const NEAR_SPAN = 30;
/** Feet this far over the ground as drawn, so their ink never dips into the street (m). */
const FEET_Y = 0.04;
/** A kerb's step up or down is eased over this half-life (s), not taken in one frame. */
const KERB_EASE = 0.04;
/** Within this of a parked bike (m), riding's chunk downloads, ready for F. */
const RIDE_NEAR = 25;
/** The avatar far out: its marker is this share of the place marker's size. */
const DOT_SHARE = 0.5;
/** Zoom eases to a place's with this half-life (s). */
const ZOOM_EASE = 0.12;

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
  /** A tap on ground nobody can reach. */
  onBlocked?(): void;
  /** A bike near enough to ride, riding, or neither. */
  onRide?(state: RideState): void;
}

export interface AvatarLayer {
  /** Whether a frame of its own is on its way, so the viewer needn't draw one. */
  readonly animating: boolean;
  readonly state: AvatarState;
  /** Walks toward a direction on screen while held: right and up, each from -1 to 1. */
  steer(right: number, up: number): void;
  /** Runs (or sprints on a bike) while on. */
  run(on: boolean): void;
  /** A tap on the map at client coordinates: walk there, or be put there if it's far. */
  tap(clientX: number, clientY: number): void;
  /** Puts the avatar on the street nearest a spot (m) and brings the camera to it. */
  goTo(x: number, z: number): void;
  /** Brings the camera back to the avatar now. */
  recentre(): void;
  /** The view was moved by hand: following waits a while. */
  moved(): void;
  /** Gets on or off the nearest bike, or rings its bell. */
  ride(action: RideAction): void;
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

  // The marker where the avatar was sent and the dust of its arrival, or a refused spot greyed:
  // one unlit draw call, over the city so it shows from far out.
  const pin = new Mesh(
    markerGeometry(),
    new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false }),
  );
  colours(pin.material);
  pin.frustumCulled = false;
  pin.visible = false;
  pin.renderOrder = 3;
  scene.add(pin);
  // The avatar from further out: two triangles, over everything.
  const dot = new Mesh(
    avatarDot(),
    new MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, fog: false }),
  );
  colours(dot.material);
  dot.frustumCulled = false;
  dot.visible = false;
  dot.renderOrder = 4;
  const ring = new Mesh(
    dot.geometry,
    new MeshBasicMaterial({ color: OUTLINE, depthTest: false, depthWrite: false, fog: false }),
  );
  ring.frustumCulled = false;
  ring.renderOrder = 3;
  dot.add(ring);
  ring.scale.setScalar(1.35);
  ring.position.y = -0.01;
  scene.add(dot);

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

  let keyRight = 0;
  let keyUp = 0;
  let running = false;
  let frame = 0;
  let last = 0;
  /** When the view was last moved by hand (ms), and whether a recentre was asked for. */
  let movedAt = -Infinity;
  let recentring = false;
  /** Whether the camera's target is on its way to the avatar. */
  let following = false;
  /** A zoom the camera eases to (a place chosen by name), or NaN. */
  let zoomGoal = Number.NaN;
  /** What the view's span allows: the figure, a marker, or nothing. */
  let shown: Detail['avatar'] = 'none';
  let span = 560;
  /** Seconds since the avatar was put somewhere by a jump, NaN with none playing. */
  let jumped = Number.NaN;
  /** A spot nobody can reach: how long since its greyed marker dropped (s), and where. */
  let nope = Number.NaN;
  const nopeAt: [number, number] = [0, 0];

  // Riding is a chunk of its own, downloaded near a rack (or on F).
  let bikes: Bikes | undefined;
  let loadingBikes: Promise<Bikes> | undefined;
  const loadBikes = () => {
    loadingBikes ??= import('./bikes.ts').then(({ createBikes }) => {
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
  let ride: RideState = '';
  let shownSpeed = Number.NaN;

  function clearRoute(): void {
    hint.visible = false;
    hint.geometry.dispose();
    marker = undefined;
  }

  /** Walks to a spot along a route, or says it can't. */
  function walkTo(x: number, z: number): boolean {
    const w = avatar.walker;
    const from = grid.walkable(w.x, w.z) ? [w.x, w.z] : grid.nearest(w.x, w.z, 2);
    // A spot the grid has closed (beside a rack, against a wall) is reached by the open cell
    // nearest it.
    const to = grid.walkable(x, z) ? [x, z] : grid.nearest(x, z, 3);
    const route = from && to && router.route(from[0]!, from[1]!, to[0]!, to[1]!, loose);
    if (!route) return false;
    [w.x, w.z] = [route[0]!, route[1]!];
    w.route = route;
    w.next = 1;
    w.travelled = 0;
    sounds.routeStart();
    hint.geometry.dispose();
    marker = routeMarker(route, ground);
    hint.geometry = marker.geometry;
    hint.visible = true;
    following = true;
    wake();
    return true;
  }

  /** Puts the avatar at a spot at once, with the marker and a puff of dust. */
  function jumpTo(x: number, z: number): void {
    clearRoute();
    jump(avatar, x, z);
    remember();
    onFeet = false;
    jumped = 0;
    sounds.land();
    following = true;
    publish();
    wake();
  }

  function refuse(x: number, z: number): void {
    nope = 0;
    [nopeAt[0], nopeAt[1]] = [x, z];
    sounds.blocked();
    host.onBlocked?.();
    wake();
  }

  const raycaster = new Raycaster();
  const ndc = new Vector2();
  function tap(clientX: number, clientY: number): void {
    const rect = canvas.getBoundingClientRect();
    ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const { origin, direction } = raycaster.ray;
    const spot = pickWalkable(
      grid,
      [origin.x, origin.y, origin.z],
      [direction.x, direction.y, direction.z],
      TAP_REACH,
      false,
      terrain,
    );
    if (!spot) {
      // Where the ray meets the ground round the view's middle.
      const t = controls.target;
      const k = direction.y < 0 ? (origin.y - ground(t.x, t.z)) / -direction.y : 0;
      refuse(origin.x + direction.x * k, origin.z + direction.z * k);
      return;
    }
    const w = avatar.walker;
    if (bikes?.busy) return;
    // Close enough to see the avatar, a tap within reach walks it there; from further out, or
    // further off, it's put there.
    const near = shown === 'figure' && Math.hypot(spot[0] - w.x, spot[1] - w.z) <= ROUTE_REACH;
    if (!near || !walkTo(...spot)) jumpTo(...spot);
  }

  function wake(): void {
    if (frame) return;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }

  function tick(now: number): void {
    frame = 0;
    const elapsed = Math.max(0, (now - last) / 1000);
    const dt = Math.min(0.05, elapsed);
    last = now;
    const w = avatar.walker;
    let busy = false;

    const holding = bikes?.busy ?? false;
    const [sx, sz] = holding ? [0, 0] : screenSteer(host.yaw(), keyRight, keyUp);
    let moving = false;
    for (let n = ticks(sim, elapsed); n > 0; n--) {
      remember();
      const routed = w.route !== null;
      moving = stepAvatar(avatar, STEP, sx, sz, grid, running);
      if (avatar.mode === 'foot') sounds.stride(w.phase, w.speed, runBlend(w.speed));
      if (routed && !w.route && !sx && !sz) sounds.routeEnd();
    }
    // Nobody sees an idle figure from far out: it stands still there.
    if (shown !== 'figure' || reducedMotion) w.still = Math.max(w.still, 1e3);
    if (bikes) busy = bikes.frame(avatar, elapsed) || busy;
    else if (nearestParked(scene.children, w.x, w.z, RIDE_NEAR)) void loadBikes();
    if (bikes && bikes.state !== ride) host.onRide?.((ride = bikes.state));
    // How fast it goes, for the smoke test, written only as it changes by a step worth noting.
    if (Math.abs(w.speed - shownSpeed) >= 0.5 || (w.speed === 0 && shownSpeed !== 0)) {
      shownSpeed = w.speed;
      canvas.dataset.speed = w.speed.toFixed(1);
    }
    busy ||= moving || sx !== 0 || sz !== 0;
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

    // The camera: back to the avatar once nobody has moved the view for a while, or at once.
    following ||= w.speed > 0 || w.route !== null;
    const strength = recentring ? 1 : followStrength((now - movedAt) / 1000);
    if (following && strength > 0) {
      const t = controls.target;
      const lead = reducedMotion ? 0 : w.speed * LEAD;
      const goal = { x: t.x, z: t.z };
      const on = recentre(
        goal,
        x + Math.sin(heading) * lead,
        z + Math.cos(heading) * lead,
        strength,
        reducedMotion ? 1 : dt,
      );
      const moved = goal.x !== t.x || goal.z !== t.z;
      if (moved) {
        t.set(goal.x, ground(goal.x, goal.z), goal.z);
        host.placeCamera();
      }
      following = on || w.speed > 0 || w.route !== null;
      if (!following) recentring = false;
      busy ||= following;
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

    jumped += elapsed;
    nope += elapsed;
    busy = placeSpot() || busy;

    host.render();
    if (busy) frame = requestAnimationFrame(tick);
    else publish();
  }

  /** Poses and places the figure (or its marker from further out) where the avatar is drawn. */
  function place(x: number, z: number, heading: number, phase: number, dt: number): void {
    const w = avatar.walker;
    const step = host.groundAt(x, z) - ground(x, z);
    kerb = reducedMotion || !onFeet ? step : decay(kerb, step, KERB_EASE, dt);
    onFeet = true;
    const floor = ground(x, z) + kerb + avatar.rise;
    const onFoot = avatar.mode === 'foot' || (bikes?.busy ?? false);
    character.mesh.visible = shown === 'figure' && onFoot;
    if (character.mesh.visible) {
      applyPose(
        character,
        poseAt(pose, w.speed, phase, w.still, !reducedMotion, w.turning, 0, w.surge, heading),
      );
      character.mesh.position.set(x, floor + FEET_Y, z);
      character.mesh.rotation.y = heading;
    }
    dot.visible = shown === 'marker';
    if (dot.visible) {
      dot.position.set(x, floor + 0.05, z);
      dot.scale.setScalar(markerRadius(span) * DOT_SHARE);
    }
  }

  /**
   * The marker where the avatar was put and the dust of its arrival, or a refused spot's greyed
   * marker shaking its head: the same size on screen whatever the zoom. Whether one is playing.
   */
  function placeSpot(): boolean {
    const w = avatar.walker;
    let [x, z, size, left] = [w.x, w.z, 1, 1];
    let dust = false;
    const refused = nope < NOPE;
    if (refused) {
      [x, z] = nopeAt;
      size = markerDrop(nope);
      left = 1 - (nope / NOPE) ** 3;
    } else if (jumped < MARK) {
      size = markerDrop(jumped);
    } else {
      const dusting = puff(jumped - MARK);
      if (!dusting) {
        pin.visible = false;
        return false;
      }
      [size, left] = dusting;
      dust = true;
    }
    const y = host.groundAt(x, z) + 0.02;
    const radius = markerRadius(span);
    const shake = refused ? Math.sin(nope * 38) * Math.exp(-5 * nope) * radius * 0.35 : 0;
    pin.position.set(x + shake, y, z);
    pin.scale.setScalar(radius * size);
    pin.material.opacity = left;
    pin.material.color.setHex(refused ? 0xa8a39c : 0xffffff);
    // From high up the marker shows over the city, as a map pin does; near the street it lies
    // under the avatar's feet.
    pin.material.depthTest = span < NEAR_SPAN;
    pin.geometry.setDrawRange(dust ? MARKER_INDICES : 0, dust ? Infinity : MARKER_INDICES);
    pin.visible = true;
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

  return {
    get animating() {
      return frame !== 0;
    },
    get state() {
      return avatarState(avatar);
    },
    steer(right, up) {
      [keyRight, keyUp] = [right, up];
      if (right || up) wake();
    },
    run(on) {
      running = on;
    },
    tap,
    goTo(x, z) {
      const spot = grid.nearest(x, z, PLACE_REACH, true);
      if (!spot) {
        refuse(x, z);
        return;
      }
      jumpTo(...spot);
      recentring = true;
      if (camera.zoom < PLACE_ZOOM) zoomGoal = PLACE_ZOOM;
    },
    recentre() {
      recentring = following = true;
      wake();
    },
    moved() {
      movedAt = performance.now();
      recentring = false;
      zoomGoal = Number.NaN;
    },
    ride(action) {
      loadBikes().then(
        (loaded) => {
          const chores = loaded.act(action, avatar);
          if (chores.walkTo) walkTo(...chores.walkTo);
          wake();
        },
        () => {}, // nothing to ride: the street stays the street
      );
    },
    detail(detail, now) {
      span = now;
      if (detail.avatar === shown) {
        if (dot.visible) dot.scale.setScalar(markerRadius(span) * DOT_SHARE);
        return;
      }
      shown = detail.avatar;
      bikes?.show(shown === 'figure');
      const w = avatar.walker;
      place(w.x, w.z, w.heading, w.phase, 0);
    },
    dispose() {
      cancelAnimationFrame(frame);
      bikes?.dispose();
      for (const mesh of [character.mesh, hint, pin, dot]) scene.remove(mesh);
      hint.geometry.dispose();
      hint.material.dispose();
      pin.geometry.dispose();
      pin.material.dispose();
      dot.geometry.dispose();
      dot.material.dispose();
      ring.material.dispose();
      body.dispose();
      xray.dispose();
    },
  };
}
