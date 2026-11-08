import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

import { sound } from '../audio/sound.ts';
import type { City } from '../data/city.ts';
import { clampScale, toCity, toScreen } from '../data/map-view.ts';
import type { Frame } from '../data/map-view.ts';
import { placesOf } from '../data/places.ts';
import type { Place } from '../data/places.ts';
import { selfOf } from '../data/presence.ts';
import {
  addWaypoint,
  removeWaypoint,
  saveWaypoints,
  waypointNear,
  WAYPOINT_COLOURS,
} from '../data/waypoints.ts';
import type { Waypoint, WaypointColour } from '../data/waypoints.ts';
import type { Viewer } from '../scene/viewer.ts';
import { MapIcon } from './icons.tsx';
import { CloseIcon, MinusIcon, PinIcon, PlusIcon, WalkIcon } from './menu-icons.tsx';
import { drawMark, drawPlayer, drawTarget, ensureMarks } from './map-draw.ts';
import { dpr, paintRaster, rasterOf } from './map-raster.ts';
import type { Store } from './store.ts';

/**
 * The full map, GTA style: the whole city drawn from the same raster as the radar, panned and
 * zoomed with a drag, a pinch, the wheel or the keys, with the player's place and heading, the
 * named squares, the end of an active route and the marks someone keeps. A click or tap picks a
 * spot to mark or walk to; a long press drops a mark at once. Marks live in localStorage.
 */

/** A press that moves less than this (px) and ends within the long-press time is a click. */
const CLICK_SLOP = 6;
const LONG_PRESS_MS = 550;
/** A mark within this many px of a click is the one clicked. */
const MARK_REACH = 16;
/** Squares are named from this zoom, in px per metre. */
const LABELS_FROM = 0.2;
/** What it opens at: the city's heart as the player's own part of it, in px per metre. */
const START_SCALE = 0.35;
const KEY_PAN = 80;

interface Props {
  city: City;
  viewer: { current: Viewer | null };
  marks: Store<Waypoint[]>;
  onClose: () => void;
}

type Selection = { kind: 'spot'; x: number; z: number } | { kind: 'mark'; id: string } | null;

let counter = 0;
const newId = () => `w${Date.now().toString(36)}${(counter++).toString(36)}`;

export function MapOverlay(props: Props) {
  const { city, viewer, onClose } = props;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useState(() => ensureMarks(props.marks));
  const marks = useSyncExternalStore(props.marks.subscribe, props.marks.get);
  const [selection, setSelection] = useState<Selection>(null);
  const [listing, setListing] = useState(false);
  const [name, setName] = useState('');
  const [colour, setColour] = useState<WaypointColour>(WAYPOINT_COLOURS[0]);
  const places = useMemo(() => placesOf(city), [city]);
  /** Everything the canvas draws from, kept out of React: panning must not render components. */
  const live = useRef({
    frame: { cx: 0, cz: 0, scale: START_SCALE, turn: 0 } as Frame,
    marks,
    selection: null as Selection,
    squares: places.filter((p) => p.kind === 'square'),
    draw: () => {},
    schedule: () => {},
    size: [1, 1] as [number, number],
  });

  const commit = (next: Waypoint[]) => {
    props.marks.set(next);
    saveWaypoints(next);
  };
  /** The nearest named place to a spot, to suggest a name. */
  const nameFor = (x: number, z: number): string => {
    let best: Place | undefined;
    let nearest = 80 * 80;
    for (const p of places) {
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < nearest) [best, nearest] = [p, d];
    }
    return best?.name ?? '';
  };

  // Open as a modal dialog: it traps focus, takes Escape and keeps the map's own shortcuts out.
  useEffect(() => {
    const dialog = dialogRef.current;
    const canvas = canvasRef.current;
    if (!dialog || !canvas) return;
    dialog.showModal();
    const ctx = canvas.getContext('2d')!;
    const raster = rasterOf(city);
    const state = live.current;
    const me = selfOf(viewer.current?.presences() ?? []);
    if (me) [state.frame.cx, state.frame.cz] = [me.x, me.z];
    const labelFont = '600 12px system-ui, sans-serif';
    let queued = 0;
    state.schedule = () => {
      if (queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        state.draw();
      });
    };
    state.draw = () => {
      const [w, h] = state.size;
      const ratio = dpr();
      const { frame } = state;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.fillStyle = '#ece6d6';
      ctx.fillRect(0, 0, w, h);
      paintRaster(ctx, raster, frame, w / 2, h / 2);
      const at = (x: number, z: number) => {
        const [px, py] = toScreen(frame, x, z);
        return [w / 2 + px, h / 2 + py] as const;
      };
      if (frame.scale >= LABELS_FROM) {
        ctx.font = labelFont;
        ctx.textAlign = 'center';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,253,246,0.9)';
        ctx.fillStyle = '#2b2420';
        // A label that would land on one already drawn waits for a closer zoom.
        const taken: [number, number, number, number][] = [];
        for (const sq of state.squares) {
          const [x, y] = at(sq.x, sq.z);
          if (x < -80 || y < -20 || x > w + 80 || y > h + 20) continue;
          const half = ctx.measureText(sq.name).width / 2 + 3;
          if (taken.some(([l, t, r, b]) => x + half > l && x - half < r && y + 7 > t && y - 15 < b))
            continue;
          taken.push([x - half, y - 15, x + half, y + 7]);
          ctx.strokeText(sq.name, x, y);
          ctx.fillText(sq.name, x, y);
        }
      }
      const picked = state.selection;
      for (const m of state.marks) {
        const [x, y] = at(m.x, m.z);
        drawMark(ctx, x, y, m.colour, picked?.kind === 'mark' && picked.id === m.id ? 10 : 7);
      }
      if (picked?.kind === 'spot') {
        const [x, y] = at(picked.x, picked.z);
        drawMark(ctx, x, y, '#2b2420', 6);
      }
      const route = viewer.current?.routeTarget();
      if (route) drawTarget(ctx, ...at(route[0], route[1]), 10);
      for (const p of viewer.current?.presences() ?? []) {
        drawPlayer(ctx, ...at(p.x, p.z), p.heading, 9, p.self);
      }
    };
    const resize = () => {
      const [w, h] = [canvas.clientWidth, canvas.clientHeight];
      const ratio = dpr();
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
      state.size = [w, h];
      state.draw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    // The player's place changes while it is open only if someone walks on: poll it gently.
    const poll = setInterval(state.schedule, 500);
    return () => {
      observer.disconnect();
      clearInterval(poll);
      cancelAnimationFrame(queued);
      if (dialog.open) dialog.close();
    };
  }, [city, viewer]);
  useEffect(() => {
    live.current.marks = marks;
    live.current.selection = selection;
    live.current.schedule();
  }, [marks, selection]);

  // Pan, pinch, click and long press, on the canvas.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const press = useRef<{ x: number; y: number; at: number; moved: boolean; timer: number } | null>(
    null,
  );
  const local = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const [w, h] = live.current.size;
    return [e.clientX - rect.left - w / 2, e.clientY - rect.top - h / 2] as const;
  };
  const markAt = (px: number, py: number) => {
    const { frame } = live.current;
    const [x, z] = toCity(frame, px, py);
    return waypointNear(live.current.marks, x, z, MARK_REACH / frame.scale);
  };
  const zoomAt = (px: number, py: number, factor: number) => {
    const { frame } = live.current;
    const before = toCity(frame, px, py);
    frame.scale = clampScale(frame.scale * factor);
    const after = toCity(frame, px, py);
    frame.cx += before[0] - after[0];
    frame.cz += before[1] - after[1];
    live.current.schedule();
  };
  const panBy = (dx: number, dy: number) => {
    const { frame } = live.current;
    frame.cx -= dx / frame.scale;
    frame.cz -= dy / frame.scale;
    live.current.schedule();
  };
  const down = (e: ReactPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size > 1) {
      clearTimeout(press.current?.timer);
      if (press.current) press.current.moved = true;
      return;
    }
    const [px, py] = local(e);
    const timer = window.setTimeout(() => {
      if (!press.current || press.current.moved) return;
      press.current.moved = true; // the lift that follows isn't a click as well
      const [x, z] = toCity(live.current.frame, px, py);
      const mark = markAt(px, py);
      if (mark) setSelection({ kind: 'mark', id: mark.id });
      else {
        const id = newId();
        commit(addWaypoint(live.current.marks, { x, z, name: nameFor(x, z) }, id));
        setSelection({ kind: 'mark', id });
      }
      sound.tap();
    }, LONG_PRESS_MS);
    press.current = { x: e.clientX, y: e.clientY, at: performance.now(), moved: false, timer };
  };
  const move = (e: ReactPointerEvent) => {
    const last = pointers.current.get(e.pointerId);
    if (!last) return;
    const other = [...pointers.current].find(([id]) => id !== e.pointerId)?.[1];
    const p = press.current;
    if (p && !p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP) {
      p.moved = true;
      clearTimeout(p.timer);
    }
    if (p && !p.moved) return;
    if (!other) panBy(e.clientX - last.x, e.clientY - last.y);
    else {
      const spread = Math.hypot(last.x - other.x, last.y - other.y);
      const next = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      const [mx, my] = local({
        clientX: (e.clientX + other.x) / 2,
        clientY: (e.clientY + other.y) / 2,
      });
      panBy(e.clientX - last.x, e.clientY - last.y);
      if (spread > 0) zoomAt(mx, my, next / spread);
    }
    [last.x, last.y] = [e.clientX, e.clientY];
  };
  const up = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    const p = press.current;
    if (!p || pointers.current.size) return;
    press.current = null;
    clearTimeout(p.timer);
    if (p.moved || e.type === 'pointercancel') return;
    const [px, py] = local(e);
    const mark = markAt(px, py);
    if (mark) setSelection({ kind: 'mark', id: mark.id });
    else {
      const [x, z] = toCity(live.current.frame, px, py);
      setName('');
      setSelection({ kind: 'spot', x, z });
    }
  };
  // A long press still pending when the map closes must not drop a mark afterwards.
  useEffect(() => () => clearTimeout(press.current?.timer), []);
  // React's wheel listener is passive: the map listens itself, to keep the page from scrolling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [px, py] = local(e);
      zoomAt(px, py, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 16 : 1) * 0.0015));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
    // The helpers read refs only, so the listener is bound once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape steps back: a picked spot or the list first, then the map.
  const back = () => {
    if (selection || listing) {
      setSelection(null);
      setListing(false);
    } else onClose();
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      back();
      return;
    }
    if (e.target instanceof Element && e.target.closest('input')) return;
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [0, KEY_PAN],
      ArrowDown: [0, -KEY_PAN],
      ArrowLeft: [KEY_PAN, 0],
      ArrowRight: [-KEY_PAN, 0],
    };
    const step = arrows[e.key];
    if (step) panBy(...step);
    else if (e.key === '+' || e.key === '=') zoomAt(0, 0, 1.4);
    else if (e.key === '-') zoomAt(0, 0, 1 / 1.4);
    else if (e.key.toLowerCase() === 'm') onClose();
    else return;
    e.preventDefault();
  };

  const goTo = (x: number, z: number) => {
    sound.tap();
    viewer.current?.navigateTo(x, z);
    onClose();
  };
  const centreOn = (x: number, z: number) => {
    const { frame } = live.current;
    [frame.cx, frame.cz] = [x, z];
    live.current.schedule();
  };
  const me = selfOf(viewer.current?.presences() ?? []);
  const picked = selection?.kind === 'mark' ? marks.find((m) => m.id === selection.id) : undefined;
  const spot = selection?.kind === 'spot' ? selection : undefined;
  const suggestion = spot ? nameFor(spot.x, spot.z) : '';

  return (
    <dialog
      ref={dialogRef}
      className="bigmap"
      aria-label="Map of Leuven"
      onKeyDown={keys}
      onCancel={(e) => {
        e.preventDefault();
        back();
      }}
      onClose={onClose}
    >
      <canvas
        ref={canvasRef}
        className="bigmap-canvas"
        aria-label="Map of Leuven. Drag to pan, scroll or pinch to zoom, click to pick a spot, hold to drop a mark."
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="bigmap-top">
        <h2 className="bigmap-title">Leuven</h2>
        <button type="button" className="map-btn" aria-label="Close the map" onClick={onClose}>
          <CloseIcon />
          <kbd aria-hidden="true">M</kbd>
        </button>
      </div>
      <div className="bigmap-tools">
        <button
          type="button"
          className="map-btn"
          aria-label="Zoom in"
          onClick={() => zoomAt(0, 0, 1.5)}
        >
          <PlusIcon />
        </button>
        <button
          type="button"
          className="map-btn"
          aria-label="Zoom out"
          onClick={() => zoomAt(0, 0, 1 / 1.5)}
        >
          <MinusIcon />
        </button>
        {me && (
          <button
            type="button"
            className="map-btn"
            aria-label="Centre on me"
            onClick={() => centreOn(me.x, me.z)}
          >
            <WalkIcon />
          </button>
        )}
        <button
          type="button"
          className="map-btn"
          aria-label={`Marks, ${marks.length}`}
          aria-expanded={listing}
          onClick={() => {
            setListing(!listing);
            setSelection(null);
          }}
        >
          <PinIcon />
          <span className="map-count" aria-hidden="true">
            {marks.length}
          </span>
        </button>
      </div>

      {(picked || spot || listing) && (
        <section className="bigmap-sheet" aria-label={listing ? 'Marks' : 'Mark'}>
          {listing ? (
            marks.length ? (
              <ul className="mark-list">
                {marks.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      className="mark-name"
                      onClick={() => {
                        centreOn(m.x, m.z);
                        setSelection({ kind: 'mark', id: m.id });
                        setListing(false);
                      }}
                    >
                      <span className="swatch" style={{ background: m.colour }} />
                      {m.name}
                    </button>
                    <button
                      type="button"
                      className="map-btn"
                      aria-label={`Navigate to ${m.name}`}
                      onClick={() => goTo(m.x, m.z)}
                    >
                      <MapIcon />
                    </button>
                    <button
                      type="button"
                      className="map-btn"
                      aria-label={`Remove ${m.name}`}
                      onClick={() => commit(removeWaypoint(marks, m.id))}
                    >
                      <CloseIcon />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sheet-note">
                No marks yet. Click or tap the map to pick a spot; press and hold to drop a mark at
                once.
              </p>
            )
          ) : picked ? (
            <>
              <h3 className="sheet-title">
                <span className="swatch" style={{ background: picked.colour }} />
                {picked.name}
              </h3>
              <div className="sheet-actions">
                <button
                  type="button"
                  className="action primary"
                  onClick={() => goTo(picked.x, picked.z)}
                >
                  <MapIcon />
                  <span>Navigate here</span>
                </button>
                <button
                  type="button"
                  className="action"
                  onClick={() => {
                    commit(removeWaypoint(marks, picked.id));
                    setSelection(null);
                  }}
                >
                  <CloseIcon />
                  <span>Remove</span>
                </button>
              </div>
            </>
          ) : spot ? (
            <>
              <label className="sheet-field">
                <span>Name (optional)</span>
                <input
                  value={name}
                  maxLength={40}
                  placeholder={suggestion || 'Mark'}
                  enterKeyHint="done"
                  autoComplete="off"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <fieldset className="swatches">
                <legend className="sr-only">Colour</legend>
                {WAYPOINT_COLOURS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="swatch-btn"
                    aria-pressed={c === colour}
                    aria-label={`Colour ${WAYPOINT_COLOURS.indexOf(c) + 1}`}
                    style={{ background: c }}
                    onClick={() => setColour(c)}
                  />
                ))}
              </fieldset>
              <div className="sheet-actions">
                <button
                  type="button"
                  className="action primary"
                  onClick={() => {
                    const id = newId();
                    commit(
                      addWaypoint(
                        marks,
                        { x: spot.x, z: spot.z, name: name || suggestion, colour },
                        id,
                      ),
                    );
                    setSelection({ kind: 'mark', id });
                  }}
                >
                  <PinIcon />
                  <span>Add mark</span>
                </button>
                <button type="button" className="action" onClick={() => goTo(spot.x, spot.z)}>
                  <MapIcon />
                  <span>Navigate here</span>
                </button>
              </div>
            </>
          ) : null}
        </section>
      )}
    </dialog>
  );
}
