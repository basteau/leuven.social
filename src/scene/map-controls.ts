import { Vector3 } from 'three';
import type { OrthographicCamera } from 'three';

/** How far an arrow key pans, as a drag of this many pixels. */
const KEY_PAN = 7;
/** A wheel's zoom per 100 px of scroll, as three's OrbitControls has it. */
const WHEEL_ZOOM = 0.95;

const ARROWS: Record<string, readonly [number, number]> = {
  ArrowUp: [0, KEY_PAN],
  ArrowDown: [0, -KEY_PAN],
  ArrowLeft: [KEY_PAN, 0],
  ArrowRight: [-KEY_PAN, 0],
};

/** The element the controls listen on: the canvas, or a stand-in in tests. */
export type Surface = EventTarget & {
  clientWidth: number;
  clientHeight: number;
  getBoundingClientRect(): { left: number; top: number };
  style: { cursor: string; touchAction: string };
  setPointerCapture?(id: number): void;
};

/**
 * Panning and zooming the map's orthographic camera, which looks at `target` from a fixed angle:
 * one pointer drags the ground along with it, two pinch and drag, the wheel zooms about the
 * cursor, the arrow keys pan. What three's MapControls did for the map with rotation off, in a
 * tenth of its size. Each change calls `onChange`, as `update()` does after a change by hand.
 */
export class MapControls {
  readonly target = new Vector3();
  enabled = true;
  // The viewer sets it for the window (zoom-limit.ts): how far out one frame may reach.
  minZoom = 0.5;
  maxZoom = 4;
  readonly #camera: OrthographicCamera;
  readonly #surface: Surface;
  readonly #onChange: () => void;
  readonly #pointers = new Map<number, { x: number; y: number }>();
  readonly #listening = new AbortController();
  #cursor: 'grab' | 'auto' = 'grab';
  // Scratch, so a drag allocates nothing.
  readonly #from = new Vector3();
  readonly #to = new Vector3();
  readonly #forward = new Vector3();

  constructor(
    camera: OrthographicCamera,
    surface: Surface,
    keys: EventTarget,
    onChange: () => void,
  ) {
    [this.#camera, this.#surface, this.#onChange] = [camera, surface, onChange];
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
    on(keys, 'keydown', (e: KeyboardEvent) => this.#key(e));
  }

  /** 'grab' on the map, 'auto' while walking. */
  get cursorStyle(): 'grab' | 'auto' {
    return this.#cursor;
  }
  set cursorStyle(style: 'grab' | 'auto') {
    this.#cursor = style;
    this.#surface.style.cursor = style;
  }

  /** Tells the viewer the camera was moved by hand. */
  update(): void {
    this.#onChange();
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

  /** Zooms by `factor`, within the limits, keeping the ground under (x, y) where it is. */
  zoomAt(x: number, y: number, factor: number): void {
    const camera = this.#camera;
    const before = this.groundAt(x, y, this.#from);
    camera.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, camera.zoom * factor));
    camera.updateProjectionMatrix();
    const shift = before.sub(this.groundAt(x, y, this.#to));
    this.target.add(shift);
    camera.position.add(shift);
    this.#onChange();
  }

  #down(event: PointerEvent): void {
    if (!this.enabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
    this.#surface.setPointerCapture?.(event.pointerId);
    this.#pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.#cursor === 'grab') this.#surface.style.cursor = 'grabbing';
  }

  #move(event: PointerEvent): void {
    const last = this.#pointers.get(event.pointerId);
    if (!last) return;
    if (!this.enabled) {
      this.#pointers.clear();
      return;
    }
    const [x, y] = [event.clientX, event.clientY];
    const other = [...this.#pointers].find(([id]) => id !== event.pointerId)?.[1];
    if (!other) {
      this.pan(last.x, last.y, x, y);
    } else {
      // Two fingers: the midpoint drags, the spread zooms about it.
      const [mx, my] = [(last.x + other.x) / 2, (last.y + other.y) / 2];
      const [nx, ny] = [(x + other.x) / 2, (y + other.y) / 2];
      const spread = Math.hypot(last.x - other.x, last.y - other.y);
      this.pan(mx, my, nx, ny);
      if (spread > 0) this.zoomAt(nx, ny, Math.hypot(x - other.x, y - other.y) / spread);
    }
    [last.x, last.y] = [x, y];
  }

  #up(event: PointerEvent): void {
    this.#pointers.delete(event.pointerId);
    if (!this.#pointers.size) this.#surface.style.cursor = this.#cursor;
  }

  #wheel(event: WheelEvent): void {
    if (!this.enabled || this.#pointers.size) return;
    event.preventDefault();
    // Lines and pages to pixels; a trackpad's pinch comes as a wheel with Ctrl and small steps.
    let delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
    if (event.ctrlKey) delta *= 10;
    const scale = WHEEL_ZOOM ** Math.abs(delta * 0.01);
    this.zoomAt(event.clientX, event.clientY, delta < 0 ? 1 / scale : scale);
  }

  #key(event: KeyboardEvent): void {
    const step = ARROWS[event.code];
    if (!this.enabled || !step || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    const { left, top } = this.#surface.getBoundingClientRect();
    const [cx, cy] = [left + this.#surface.clientWidth / 2, top + this.#surface.clientHeight / 2];
    this.pan(cx, cy, cx + step[0], cy + step[1]);
  }
}
