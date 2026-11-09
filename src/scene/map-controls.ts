import { Vector3 } from 'three';
import type { OrthographicCamera } from 'three';

import { TAP_SLOP } from './tap.ts';

/** A wheel's zoom per 100 px of scroll, as three's OrbitControls has it. */
const WHEEL_ZOOM = 0.95;
/** A turning drag's turn (rad per px of it sideways): 0.8°, MapLibre's. */
export const DRAG_TURN = (0.8 * Math.PI) / 180;
/** A sideways scroll's turn (rad per px): a quarter of a drag's, since a swipe runs on far. */
const WHEEL_TURN = DRAG_TURN / 4;
/** How far two fingers must twist along their circle (px), as MapLibre: a pinch wobbles less. */
const TWIST_SLOP = 25;
/** But never more of an angle than this (rad, 20°): fingers close together turn by then. */
const TWIST_MOST = 0.35;
/** A trackpad's own twist has no circle to measure, so an angle (rad): about 8°. */
const GESTURE_SLOP = 0.14;
/** One scroll ends after this long with no event (ms), and shows its way within this much (px). */
const WHEEL_GAP = 150;
const WHEEL_SETTLE = 16;
/** A sideways scroll has to be this much more sideways than up or down: zoom is the default. */
const WHEEL_SIDEWAYS = 2;
/** A hand still for this long (ms) before lifting has stopped: it doesn't flick. */
const FLICK_STALE = 80;

/** Safari's own trackpad event: scale and rotation (degrees) since the gesture began. */
interface GestureEvent extends Event {
  scale: number;
  rotation: number;
  clientX: number;
  clientY: number;
}

/** Whether a mouse press turns the map rather than dragging it. */
const turns = (e: PointerEvent) =>
  e.pointerType === 'mouse' && (e.button > 0 || e.ctrlKey || e.altKey);

/** The element the controls listen on: the canvas, or a stand-in in tests. */
export type Surface = EventTarget & {
  clientWidth: number;
  clientHeight: number;
  getBoundingClientRect(): { left: number; top: number };
  style: { cursor: string; touchAction: string };
  setPointerCapture?(id: number): void;
};

/**
 * Panning, zooming and turning the map's orthographic camera, which looks at `target` from a
 * fixed angle: one pointer drags the ground along with it (and calls `onPan`), two pinch, drag and
 * twist, the wheel zooms about the cursor and a sideways scroll turns. The right or middle mouse
 * button, or the left with Ctrl or Alt, turns by dragging sideways. While `pinned` (the
 * camera keeps the avatar in the middle) a pinch or the wheel zooms about the target instead, so
 * zooming never lets go of it, and nothing that only turns the map does; only a drag does.
 * Each change calls `onChange`; `onTurn` turns the camera, and `onFlick` is told how fast a
 * hand left a turn (rad/s), for it to glide on.
 */
export class MapControls {
  readonly target = new Vector3();
  // The viewer sets it for the window (zoom-limit.ts): how far out one frame may reach.
  minZoom = 0.5;
  maxZoom = 4;
  pinned = false;
  readonly #camera: OrthographicCamera;
  readonly #surface: Surface;
  readonly #onChange: () => void;
  readonly #onPan: () => void;
  readonly #onTurn: (radians: number) => void;
  readonly #onFlick: (rate: number) => void;
  /** Two fingers: how far they've twisted, their closest yet, and whether it counts as a turn. */
  #twist = { swept: 0, tight: Infinity, on: false };
  /** Safari's trackpad: the scale and rotation last seen. */
  #gesture = { scale: 1, rotation: 0, swept: 0, on: false };
  /**
   * The turn's speed (rad/s), smoothed; when it last turned (ms; 0 for no turn under way); and
   * what has turned since, for two fingers report at one stamp.
   */
  #flick = { rate: 0, at: 0, owed: 0 };
  /** The scroll under way: which way it's gone, what's come so far, and its last event (ms). */
  #scroll = { axis: '', x: 0, y: 0, at: Number.NEGATIVE_INFINITY };
  /** Pointers down: where each is, and whether it has moved past a tap's slop yet. */
  readonly #pointers = new Map<
    number,
    { x: number; y: number; x0: number; y0: number; dragging: boolean; turning: boolean }
  >();
  readonly #listening = new AbortController();
  // Scratch, so a drag allocates nothing.
  readonly #from = new Vector3();
  readonly #to = new Vector3();
  readonly #forward = new Vector3();

  constructor(
    camera: OrthographicCamera,
    surface: Surface,
    onChange: () => void,
    onPan: () => void,
    onTurn: (radians: number) => void,
    onFlick: (rate: number) => void,
  ) {
    [this.#camera, this.#surface, this.#onChange, this.#onPan] = [camera, surface, onChange, onPan];
    [this.#onTurn, this.#onFlick] = [onTurn, onFlick];
    surface.style.touchAction = 'none';
    surface.style.cursor = 'grab';
    const on = <E extends Event>(target: EventTarget, type: string, handle: (event: E) => void) =>
      target.addEventListener(type, handle as EventListener, {
        signal: this.#listening.signal,
        passive: false,
      });
    on(surface, 'pointerdown', (e: PointerEvent) => this.#down(e));
    on(surface, 'pointermove', (e: PointerEvent) => this.#move(e));
    for (const type of ['pointerup', 'pointercancel'])
      on(surface, type, (e: PointerEvent) => this.#up(e));
    on(surface, 'wheel', (e: WheelEvent) => this.#wheel(e));
    on(surface, 'contextmenu', (e: Event) => e.preventDefault());
    on(surface, 'gesturestart', (e: GestureEvent) => this.#gestureStart(e));
    on(surface, 'gesturechange', (e: GestureEvent) => this.#gestureChange(e));
  }

  dispose(): void {
    this.#listening.abort();
    this.#surface.style.touchAction = '';
  }

  /**
   * The point on the ground plane through the target under a point on screen (client pixels).
   * Moving the camera along its view doesn't change what an orthographic camera shows, so the
   * plane can be the target's.
   */
  groundAt(x: number, y: number, out: Vector3): Vector3 {
    const { left, top } = this.#surface.getBoundingClientRect();
    const camera = this.#camera;
    camera.updateMatrixWorld();
    out
      .set(
        ((x - left) / this.#surface.clientWidth) * 2 - 1,
        1 - ((y - top) / this.#surface.clientHeight) * 2,
        -1,
      )
      .unproject(camera);
    camera.getWorldDirection(this.#forward);
    return out.addScaledVector(this.#forward, (this.target.y - out.y) / this.#forward.y);
  }

  /** Slides the view so the ground under (x0, y0) comes under (x1, y1). */
  pan(x0: number, y0: number, x1: number, y1: number): void {
    const shift = this.groundAt(x0, y0, this.#from).sub(this.groundAt(x1, y1, this.#to));
    this.target.add(shift);
    this.#camera.position.add(shift);
    this.#onChange();
  }

  /**
   * Zooms by `factor`, within the limits, keeping the ground under (x, y) where it is; pinned,
   * keeping the target in the middle.
   */
  zoomAt(x: number, y: number, factor: number): void {
    const camera = this.#camera;
    const before = this.groundAt(x, y, this.#from);
    camera.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, camera.zoom * factor));
    camera.updateProjectionMatrix();
    if (this.pinned) {
      this.#onChange();
      return;
    }
    const shift = before.sub(this.groundAt(x, y, this.#to));
    this.target.add(shift);
    camera.position.add(shift);
    this.#onChange();
  }

  /**
   * Turns by `radians` while keeping the ground under (x, y) where it is; pinned, about the
   * target. Remembers how fast, for a flick.
   */
  #turnAt(x: number, y: number, radians: number, stamp: number): void {
    const flick = this.#flick;
    const ms = stamp - flick.at;
    flick.owed += radians;
    if (ms > 0) {
      // Finger events come in bursts, so what a flick was is taken over the last few.
      const rate = flick.owed / (ms / 1000);
      flick.rate = ms > FLICK_STALE ? rate : flick.rate * 0.6 + rate * 0.4;
      flick.at = stamp;
      flick.owed = 0;
    }
    if (this.pinned) {
      this.#onTurn(radians);
      return;
    }
    const before = this.groundAt(x, y, this.#from);
    this.#onTurn(radians);
    const shift = before.sub(this.groundAt(x, y, this.#to));
    this.target.add(shift);
    this.#camera.position.add(shift);
    this.#onChange();
  }

  #down(event: PointerEvent): void {
    this.#surface.setPointerCapture?.(event.pointerId);
    const [x, y] = [event.clientX, event.clientY];
    this.#pointers.set(event.pointerId, {
      x,
      y,
      x0: x,
      y0: y,
      dragging: false,
      turning: turns(event),
    });
    if (this.#pointers.size === 2) this.#twist = { swept: 0, tight: Infinity, on: false };
    this.#surface.style.cursor = 'grabbing';
  }

  #move(event: PointerEvent): void {
    const last = this.#pointers.get(event.pointerId);
    if (!last) return;
    const [x, y] = [event.clientX, event.clientY];
    const other = [...this.#pointers].find(([id]) => id !== event.pointerId)?.[1];
    if (!other) {
      // A tap's wobble isn't a pan: the map holds still until the pointer passes the slop.
      if (!last.dragging && Math.hypot(x - last.x0, y - last.y0) < TAP_SLOP) return;
      if (last.turning) {
        // Sideways turns, as a grab of the near side of the map would; it starts from where the
        // slop was passed, without a jump, and it stays pinned.
        if (last.dragging) this.#turnAt(x, y, -(x - last.x) * DRAG_TURN, event.timeStamp);
        last.dragging = true;
        [last.x, last.y] = [x, y];
        return;
      }
      if (!last.dragging) {
        last.dragging = true;
        // Grabbing the map lets go of the avatar.
        this.pinned = false;
        this.#onPan();
      }
      this.pan(last.x, last.y, x, y);
    } else {
      // Two fingers: the midpoint drags, the spread zooms about it, a twist turns about it
      // (pinned, about the target).
      const [mx, my] = [(last.x + other.x) / 2, (last.y + other.y) / 2];
      const [nx, ny] = [(x + other.x) / 2, (y + other.y) / 2];
      const spread = Math.hypot(last.x - other.x, last.y - other.y);
      const reach = Math.hypot(x - other.x, y - other.y);
      if (!this.pinned) this.pan(mx, my, nx, ny);
      if (spread > 0) this.zoomAt(nx, ny, reach / spread);
      const twisted = Math.atan2(
        (last.x - other.x) * (y - other.y) - (last.y - other.y) * (x - other.x),
        (last.x - other.x) * (x - other.x) + (last.y - other.y) * (y - other.y),
      );
      const twist = this.#twist;
      twist.swept += twisted;
      twist.tight = Math.min(twist.tight, reach);
      // The slop is along the circle the fingers make, so close together it takes more of an
      // angle, and a pinch's own wobble doesn't turn the map. Past it, no catching up: no jump.
      twist.on ||= Math.abs(twist.swept) >= Math.min(TWIST_SLOP / (twist.tight / 2), TWIST_MOST);
      if (twist.on) this.#turnAt(nx, ny, twisted, event.timeStamp);
    }
    [last.x, last.y] = [x, y];
  }

  #up(event: PointerEvent): void {
    this.#pointers.delete(event.pointerId);
    if (this.#pointers.size === 1) {
      // The finger left behind is far from where it came down: it starts over, or the first
      // tremble of it would be a drag, and let go of the avatar.
      for (const held of this.#pointers.values()) {
        [held.x0, held.y0, held.dragging] = [held.x, held.y, false];
      }
    }
    if (this.#pointers.size) return;
    this.#surface.style.cursor = 'grab';
    const { rate, at } = this.#flick;
    this.#flick = { rate: 0, at: 0, owed: 0 };
    if (at && event.type === 'pointerup' && event.timeStamp - at < FLICK_STALE) this.#onFlick(rate);
  }

  #wheel(event: WheelEvent): void {
    if (this.#pointers.size) return;
    event.preventDefault();
    // Lines and pages to pixels; a trackpad's pinch comes as a wheel with Ctrl and small steps.
    const px = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
    if (event.ctrlKey) {
      this.#wheelZoom(event, event.deltaY * px * 10);
      return;
    }
    const [dx, dy] = [event.deltaX * px, event.deltaY * px];
    const scroll = this.#scroll;
    // One scroll, one meaning: a finger's drift mustn't turn a zoom, or zoom a turn.
    if (event.timeStamp - scroll.at > WHEEL_GAP) Object.assign(scroll, { axis: '', x: 0, y: 0 });
    scroll.at = event.timeStamp;
    scroll.x += dx;
    scroll.y += dy;
    if (!scroll.axis) {
      if (Math.abs(scroll.x) + Math.abs(scroll.y) < WHEEL_SETTLE) return;
      scroll.axis = Math.abs(scroll.x) > WHEEL_SIDEWAYS * Math.abs(scroll.y) ? 'turn' : 'zoom';
    }
    if (scroll.axis === 'turn') this.#onTurn(scroll.x * WHEEL_TURN);
    else this.#wheelZoom(event, scroll.y);
    [scroll.x, scroll.y] = [0, 0];
  }

  #wheelZoom(event: WheelEvent, delta: number): void {
    const scale = WHEEL_ZOOM ** Math.abs(delta * 0.01);
    this.zoomAt(event.clientX, event.clientY, delta < 0 ? 1 / scale : scale);
  }

  // Safari alone says what two fingers do on a trackpad, as a gesture, and it pinches no other
  // way. On iOS the same events come along with the pointers', which have already said it.
  #gestureStart(event: GestureEvent): void {
    event.preventDefault();
    this.#gesture = { scale: 1, rotation: 0, swept: 0, on: false };
  }

  #gestureChange(event: GestureEvent): void {
    event.preventDefault();
    if (this.#pointers.size) return;
    const gesture = this.#gesture;
    const twisted = ((event.rotation - gesture.rotation) * Math.PI) / 180;
    this.zoomAt(event.clientX, event.clientY, event.scale / gesture.scale);
    [gesture.scale, gesture.rotation] = [event.scale, event.rotation];
    gesture.swept += twisted;
    gesture.on ||= Math.abs(gesture.swept) >= GESTURE_SLOP;
    if (gesture.on) this.#turnAt(event.clientX, event.clientY, twisted, event.timeStamp);
  }
}
