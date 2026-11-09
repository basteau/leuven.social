import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
  updateWaypoint,
  waypointNear,
  WAYPOINT_COLOURS,
} from '../data/waypoints.ts';
import type { Waypoint } from '../data/waypoints.ts';
import type { RoomPlace, Viewer } from '../scene/viewer.ts';
import { MapIcon, MinusIcon, PlusIcon, TargetIcon, WalkIcon } from './icons.tsx';
import { CloseIcon, PinIcon, SearchIcon } from './menu-icons.tsx';
import { ACCENT, drawDoor, drawMark, drawPlayer, drawTarget, ensureMarks } from './map-draw.ts';
import { dpr, paintRaster, rasterOf } from './map-raster.ts';
import { search } from './search.ts';
import type { Store } from './store.ts';
import { RailButton, focusQuietly } from './view-controls.tsx';

/**
 * The full map: the whole city drawn from one raster, panned and
 * zoomed with a drag, a pinch, the wheel or the keys, with the player's place and heading, the
 * named squares, the end of an active route and the marks someone keeps. A click or tap picks a
 * spot to mark or walk to; a long press drops a mark at once. Marks live in localStorage.
 */

/** What the mark colours are called, in the order of `WAYPOINT_COLOURS`. */
const COLOUR_NAMES = ['Red', 'Yellow', 'Green', 'Blue', 'Purple'];
/** A press that moves less than this (px) and ends within the long-press time is a click. */
const CLICK_SLOP = 6;
const LONG_PRESS_MS = 550;
/** A mark within this many px of a click is the one clicked. */
const MARK_REACH = 16;
/** Squares are named from this zoom and streets from this one, in px per metre. */
const LABELS_FROM = 0.2;
const STREETS_FROM = 0.9;
/** Chosen from the search, a place is shown at least this close, in px per metre. */
const FOUND_SCALE = 1.1;
/** The most results listed, and the letters typed before there are any. */
const RESULTS = 6;
const QUERY_FROM = 2;
/** What it opens at: the city's heart as the player's own part of it, in px per metre. */
const START_SCALE = 0.35;
const KEY_PAN = 80;

interface Props {
  city: City;
  viewer: { current: Viewer | null };
  marks: Store<Waypoint[]>;
  onClose: () => void;
  /** Takes the view there, down in the city, and offers to go. */
  onSee: (name: string, x: number, z: number) => void;
}

type Selection =
  { kind: 'spot'; x: number; z: number; name?: string } | { kind: 'mark'; id: string } | null;

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
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const places = useMemo(() => placesOf(city), [city]);
  /** Buildings you can go into, once their data has come: named on the map and found by name. */
  const [rooms, setRooms] = useState<readonly RoomPlace[]>([]);
  /** Everything the canvas draws from, kept out of React: panning must not render components. */
  const live = useRef({
    frame: { cx: 0, cz: 0, scale: START_SCALE } as Frame,
    marks,
    selection: null as Selection,
    // Squares claim their room first; a street's name gives way to them.
    labels: places.toSorted((a, b) => Number(b.kind === 'square') - Number(a.kind === 'square')),
    rooms: [] as readonly RoomPlace[],
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

  // Opaque and over everything, so the city needn't be drawn under it. In a layout effect, so the
  // city is drawn again before the page paints without the map.
  useLayoutEffect(() => {
    const scene = viewer.current;
    scene?.cover(true);
    return () => scene?.cover(false);
  }, [viewer]);

  // Open as a modal dialog: it traps focus, takes Escape and keeps the map's own shortcuts out.
  // Focus on the dialog itself, not its first control: the search would bring up a phone's
  // keyboard over the very map it just opened.
  useEffect(() => {
    const dialog = dialogRef.current;
    const canvas = canvasRef.current;
    if (!dialog || !canvas) return;
    if (!dialog.open) {
      // Out of the running for the dialog's first focus for that one call.
      const input = searchRef.current;
      if (input) input.disabled = true;
      dialog.showModal();
      if (input) input.disabled = false;
      focusQuietly(dialog);
    }
    void viewer.current?.rooms().then(
      (list) => {
        setRooms(list);
        live.current.rooms = list;
        live.current.schedule();
      },
      () => {},
    );
    const ctx = canvas.getContext('2d')!;
    const raster = rasterOf(city);
    const state = live.current;
    const me = selfOf(viewer.current?.presences() ?? []);
    if (me) [state.frame.cx, state.frame.cz] = [me.x, me.z];
    const labelFont = '600 12px system-ui, sans-serif';
    const streetFont = '500 11px system-ui, sans-serif';
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
      const people = viewer.current?.presences() ?? [];
      if (frame.scale >= LABELS_FROM) {
        ctx.textAlign = 'center';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,253,246,0.9)';
        // A label that would land on one already drawn, or on you, waits for a closer zoom.
        const taken: [number, number, number, number][] = [];
        const label = (text: string, x: number, y: number) => {
          if (x < -80 || y < -20 || x > w + 80 || y > h + 20) return;
          const half = ctx.measureText(text).width / 2 + 3;
          const free = (row: number) =>
            !taken.some(
              ([l, t, r, b]) => x + half > l && x - half < r && row + 7 > t && row - 15 < b,
            );
          // Where it belongs, or just under whoever's standing on it.
          const row = free(y) ? y : free(y + 24) ? y + 24 : Number.NaN;
          if (Number.isNaN(row)) return;
          taken.push([x - half, row - 15, x + half, row + 7]);
          ctx.strokeText(text, x, row);
          ctx.fillText(text, x, row);
        };
        // A building you can go into first, in the accent, beside its door: there's little else
        // to tell you it's there.
        ctx.font = labelFont;
        ctx.fillStyle = ACCENT;
        for (const room of state.rooms) {
          const [x, y] = at(room.x, room.z);
          drawDoor(ctx, x, y);
          label(room.name, x, y - 14);
        }
        for (const p of people) {
          const [x, y] = at(p.x, p.z);
          taken.push([x - 14, y - 14, x + 14, y + 14]);
        }
        // A spot just picked and the marks keep their pins clear, or a name would run under them.
        for (const pin of state.selection?.kind === 'spot'
          ? [state.selection, ...state.marks]
          : state.marks) {
          const [x, y] = at(pin.x, pin.z);
          taken.push([x - 10, y - 10, x + 10, y + 10]);
        }
        ctx.fillStyle = '#2b2420';
        for (const place of state.labels) {
          if (place.kind === 'street' && frame.scale < STREETS_FROM) break;
          ctx.font = place.kind === 'street' ? streetFont : labelFont;
          label(place.name, ...at(place.x, place.z));
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
      for (const p of people) {
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
    // People keep walking while it is open: poll them gently, and draw only if someone moved.
    let last = '';
    const poll = setInterval(() => {
      const now = JSON.stringify([viewer.current?.presences(), viewer.current?.routeTarget()]);
      if (now !== last) state.schedule();
      last = now;
    }, 500);
    return () => {
      observer.disconnect();
      clearInterval(poll);
      cancelAnimationFrame(queued);
    };
  }, [city, viewer]);
  // What had focus can go with the sheet: the dialog keeps it, or the keys would stop here.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog?.open && !dialog.contains(document.activeElement)) focusQuietly(dialog);
  }, [marks, selection, listing, query]);
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
  /** A building's door within reach of a press, by where it's drawn on screen. */
  const roomAt = (px: number, py: number) =>
    live.current.rooms.find((room) => {
      const [x, y] = toScreen(live.current.frame, room.x, room.z);
      return Math.hypot(x - px, y - py) <= MARK_REACH;
    });
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
    if (mark) {
      setSelection({ kind: 'mark', id: mark.id });
      return;
    }
    const [x, z] = toCity(live.current.frame, px, py);
    const door = roomAt(px, py);
    setSelection(
      door ? { kind: 'spot', x: door.x, z: door.z, name: door.name } : { kind: 'spot', x, z },
    );
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

  // Escape steps back: what's typed first, a picked spot or the list next, then the map.
  const back = () => {
    if (query) setQuery('');
    else if (selection || listing) {
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
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof Element && e.target.closest('input')) return;
    if (e.key === '/') {
      e.preventDefault();
      searchRef.current?.focus();
      return;
    }
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
    else if (e.key.toLowerCase() === 'm') {
      if (!e.repeat) onClose();
    } else return;
    e.preventDefault();
  };

  const goTo = (x: number, z: number) => {
    sound.tap();
    viewer.current?.navigateTo(x, z);
    onClose();
  };
  const seeIt = (name: string, x: number, z: number) => {
    sound.tap();
    props.onSee(name, x, z);
    onClose();
  };
  const centreOn = (x: number, z: number) => {
    const { frame } = live.current;
    [frame.cx, frame.cz] = [x, z];
    live.current.schedule();
  };
  /** A place from the search: there on the map, close enough to read, offering what to do. */
  const showFound = (found: { label: string; x: number; z: number }) => {
    const { frame } = live.current;
    frame.scale = Math.max(frame.scale, FOUND_SCALE);
    centreOn(found.x, found.z);
    setQuery('');
    setListing(false);
    setSelection({ kind: 'spot', x: found.x, z: found.z, name: found.label });
    searchRef.current?.blur();
  };
  const typed = query.trim();
  const results = useMemo(() => {
    if (typed.length < QUERY_FROM) return [];
    const items = [
      ...rooms.map((room) => ({
        id: `room-${room.id}`,
        group: 'all',
        label: room.name,
        detail: 'Its door is open',
        x: room.x,
        z: room.z,
      })),
      ...live.current.labels.map((place) => ({
        id: place.name,
        group: 'all',
        label: place.name,
        detail: place.kind === 'square' ? 'Square' : 'Street',
        x: place.x,
        z: place.z,
      })),
    ];
    return (search(items, typed)[0]?.items ?? []).slice(0, RESULTS);
  }, [typed, rooms]);
  const me = selfOf(viewer.current?.presences() ?? []);
  const picked = selection?.kind === 'mark' ? marks.find((m) => m.id === selection.id) : undefined;
  const spot = selection?.kind === 'spot' ? selection : undefined;
  const suggestion = spot ? (spot.name ?? nameFor(spot.x, spot.z)) : '';
  const away = (x: number, z: number) => {
    if (!me) return '';
    const metres = Math.hypot(x - me.x, z - me.z);
    return metres < 30 ? 'Right by you' : `${Math.round(metres / 10) * 10} m from you`;
  };

  return (
    <dialog
      ref={dialogRef}
      className="bigmap"
      tabIndex={-1}
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
        aria-label="Map of Leuven. Drag to pan, scroll or pinch to zoom, press a street or square to go there or keep a mark, hold to drop a mark at once. Slash finds a street by name."
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="bigmap-top">
        <h2 className="sr-only">Map of Leuven</h2>
        <div className="map-search">
          {/* oxlint-disable-next-line jsx-a11y/label-has-associated-control -- the input is inside */}
          <label className="map-search-box">
            <SearchIcon />
            <input
              ref={searchRef}
              value={query}
              maxLength={40}
              placeholder="Find a street or square"
              aria-label="Find a street, square or building"
              aria-controls="map-results"
              enterKeyHint="search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && results[0]) {
                  e.preventDefault();
                  showFound(results[0]);
                }
              }}
            />
          </label>
          {typed.length >= QUERY_FROM && (
            <div id="map-results" className="map-results">
              {results.length ? (
                <ul>
                  {results.map((result) => (
                    <li key={result.id}>
                      <button type="button" onClick={() => showFound(result)}>
                        <span>{result.label}</span>
                        <span className="map-result-kind">{result.detail}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="sheet-note">Nothing called “{typed}”. Try a street name.</p>
              )}
              <output className="sr-only">
                {results.length} {results.length === 1 ? 'result' : 'results'}
              </output>
            </div>
          )}
        </div>
        <button type="button" className="map-btn" aria-label="Close the map" onClick={onClose}>
          <CloseIcon />
          <kbd aria-hidden="true">M</kbd>
        </button>
      </div>
      <div className="bigmap-tools">
        <div className="rail-group">
          <RailButton
            label="Zoom in"
            hint={
              <>
                Zoom in <kbd>+</kbd>
              </>
            }
            onClick={() => zoomAt(0, 0, 1.5)}
          >
            <PlusIcon />
          </RailButton>
          <RailButton
            label="Zoom out"
            hint={
              <>
                Zoom out <kbd>−</kbd>
              </>
            }
            onClick={() => zoomAt(0, 0, 1 / 1.5)}
          >
            <MinusIcon />
          </RailButton>
        </div>
        {me && (
          <div className="rail-group">
            <RailButton label="Back to you" hint="Back to you" onClick={() => centreOn(me.x, me.z)}>
              <TargetIcon on={false} />
            </RailButton>
          </div>
        )}
        <div className="rail-group">
          <RailButton
            label={`Marks, ${marks.length}`}
            hint="Your marks"
            expanded={listing}
            onClick={() => {
              setListing(!listing);
              setSelection(null);
            }}
          >
            <PinIcon />
            {marks.length > 0 && <span className="map-count">{marks.length}</span>}
          </RailButton>
        </div>
      </div>

      {!picked && !spot && !listing && !typed && (
        <p className="bigmap-note">
          <span className="hint-keys">Click a street or square to go there or keep a mark.</span>
          <span className="hint-touch">
            Tap a street or square to go there or keep a mark.
          </span>{' '}
          You’re the coral diamond.
        </p>
      )}

      {(picked || spot || listing) && (
        <section
          className="bigmap-sheet"
          aria-label={listing ? 'Marks' : picked ? 'Your mark' : 'Picked spot'}
        >
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
                      <span className="mark-dot" style={{ background: m.colour }} />
                      {m.name || 'Mark'}
                    </button>
                    <button
                      type="button"
                      className="map-btn"
                      aria-label={`Go to ${m.name || 'Mark'}`}
                      onClick={() => goTo(m.x, m.z)}
                    >
                      <WalkIcon />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sheet-note">
                No marks yet. Pick a spot on the map and press Mark, or press and hold to drop one
                at once.
              </p>
            )
          ) : picked ? (
            <>
              <label className="sheet-field">
                <span>Name</span>
                <input
                  value={picked.name}
                  maxLength={40}
                  enterKeyHint="done"
                  autoComplete="off"
                  onChange={(e) =>
                    commit(updateWaypoint(marks, picked.id, { name: e.target.value }))
                  }
                />
              </label>
              <fieldset className="mark-colours">
                <legend className="sr-only">Colour</legend>
                {WAYPOINT_COLOURS.map((c, i) => (
                  <button
                    key={c}
                    type="button"
                    className="swatch-btn"
                    aria-pressed={c === picked.colour}
                    aria-label={COLOUR_NAMES[i]}
                    style={{ background: c }}
                    onClick={() => commit(updateWaypoint(marks, picked.id, { colour: c }))}
                  />
                ))}
              </fieldset>
              <div className="sheet-actions">
                <button
                  type="button"
                  className="action primary"
                  onClick={() => goTo(picked.x, picked.z)}
                >
                  <WalkIcon />
                  <span>Go here</span>
                </button>
                <button
                  type="button"
                  className="action"
                  onClick={() => seeIt(picked.name || 'Mark', picked.x, picked.z)}
                >
                  <MapIcon />
                  <span>See it</span>
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
              <div className="sheet-head">
                <h3 className="sheet-title">{suggestion || 'This spot'}</h3>
                <p className="sheet-away">{away(spot.x, spot.z)}</p>
              </div>
              <div className="sheet-actions">
                <button
                  type="button"
                  className="action primary"
                  onClick={() => goTo(spot.x, spot.z)}
                >
                  <WalkIcon />
                  <span>Go here</span>
                </button>
                <button
                  type="button"
                  className="action"
                  onClick={() => seeIt(suggestion || 'This spot', spot.x, spot.z)}
                >
                  <MapIcon />
                  <span>See it</span>
                </button>
                <button
                  type="button"
                  className="action"
                  onClick={() => {
                    const id = newId();
                    commit(addWaypoint(marks, { x: spot.x, z: spot.z, name: suggestion }, id));
                    setSelection({ kind: 'mark', id });
                  }}
                >
                  <PinIcon />
                  <span>Mark</span>
                </button>
              </div>
            </>
          ) : null}
        </section>
      )}
    </dialog>
  );
}
