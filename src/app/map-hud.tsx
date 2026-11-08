import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';

import { sound } from '../audio/sound.ts';
import type { City } from '../data/city.ts';
import { edgePoint } from '../data/drift.ts';
import { onRadar, toScreen, turnFor } from '../data/map-view.ts';
import { selfOf } from '../data/presence.ts';
import type { Waypoint } from '../data/waypoints.ts';
import type { Viewer } from '../scene/viewer.ts';
import { ArrowIcon } from './menu-icons.tsx';
import { drawMark, drawPlayer, drawTarget, ensureMarks } from './map-draw.ts';
import { dpr, paintRaster, rasterOf } from './map-raster.ts';
import type { Store } from './store.ts';

/**
 * What the map adds over the scene, in a chunk of its own that loads once the city is up: the
 * recentre arrow, and the radar in the corner while walking or riding.
 */

/** The radar: its size (CSS px), how many metres its radius shows, and how often it redraws. */
const SIZE = 116;
const SHOWS = 140;
const REDRAW_MS = 100;

interface Props {
  viewer: RefObject<Viewer | null>;
  city: City;
  walking: boolean;
  /** Where Grote Markt lies as a screen direction once it is out of view, else null. */
  drift: Store<number | null>;
  marks: Store<Waypoint[]>;
  openMap: () => void;
}

export function MapHud(props: Props) {
  useState(() => ensureMarks(props.marks));
  return (
    <>
      <RecentreArrow viewer={props.viewer} drift={props.drift} walking={props.walking} />
      {props.walking && (
        <Radar
          viewer={props.viewer}
          city={props.city}
          marks={props.marks}
          openMap={props.openMap}
        />
      )}
    </>
  );
}

/**
 * Shown only while Grote Markt is out of view on the map: a white rounded button at the screen's
 * edge pointing back. It re-renders for the arrow alone, not for the shell.
 */
function RecentreArrow(props: Pick<Props, 'viewer' | 'drift' | 'walking'>) {
  const direction = useSyncExternalStore(props.drift.subscribe, props.drift.get);
  if (direction === null || props.walking) return null;
  const { x, y } = edgePoint(direction, innerWidth, innerHeight, 64);
  return (
    <button
      type="button"
      className="recentre"
      aria-label="Back to the city centre"
      style={{ left: x, top: y }}
      onClick={() => {
        sound.tap();
        props.viewer.current?.recentre();
      }}
    >
      <span className="recentre-arrow" style={{ rotate: `${direction + Math.PI / 2}rad` }}>
        <ArrowIcon />
      </span>
    </button>
  );
}

/**
 * The radar, GTA style: a disc turning with the view (what is ahead of the camera is up), the
 * player in the middle, waypoints and the end of the route on it, those off its edge clipped to
 * the rim. It repaints ten times a second while mounted, only if something moved, from the shared
 * raster, and is mounted only while walking: the map costs nothing the rest of the time.
 */
function Radar(props: Pick<Props, 'viewer' | 'city' | 'marks' | 'openMap'>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const ratio = dpr();
    canvas.width = canvas.height = Math.round(SIZE * ratio);
    const raster = rasterOf(props.city);
    const [r, scale] = [SIZE / 2, SIZE / 2 / SHOWS];
    let last = '';
    let lastMarks: Waypoint[] = [];
    const draw = () => {
      const viewer = props.viewer.current;
      if (!viewer || document.hidden) return;
      const list = viewer.presences();
      const me = selfOf(list);
      if (!me) return;
      const heading = viewer.heading();
      const route = viewer.routeTarget();
      const marks = props.marks.get();
      const key = [me.x, me.z, heading, route?.join()].join(' ');
      if (key === last && marks === lastMarks) return;
      [last, lastMarks] = [key, marks];
      const frame = { cx: me.x, cz: me.z, scale, turn: turnFor(heading) };
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.save();
      ctx.beginPath();
      ctx.arc(r, r, r, 0, Math.PI * 2);
      ctx.clip();
      paintRaster(ctx, raster, frame, r, r);
      // Off the radar, a mark or the route's end sits on the rim, in its direction.
      const put = (x: number, z: number) => {
        const at = onRadar(toScreen(frame, x, z), r - 5);
        return [r + at.x, r + at.y, at.clipped] as const;
      };
      for (const w of marks) {
        const [x, y, clipped] = put(w.x, w.z);
        drawMark(ctx, x, y, w.colour, clipped ? 3.5 : 5);
      }
      if (route) {
        const [x, y, clipped] = put(route[0], route[1]);
        drawTarget(ctx, x, y, clipped ? 4 : 6);
      }
      for (const p of list) {
        if (p.self) continue;
        const [x, y] = put(p.x, p.z);
        drawPlayer(ctx, x, y, p.heading - heading, 4.5, false);
      }
      ctx.restore();
      drawPlayer(ctx, r, r, me.heading - heading, 6, true);
    };
    draw();
    const timer = setInterval(draw, REDRAW_MS);
    return () => clearInterval(timer);
  }, [props.city, props.viewer, props.marks]);
  return (
    <button
      type="button"
      className="radar"
      aria-label="Open the map"
      aria-keyshortcuts="M"
      style={{ inlineSize: SIZE, blockSize: SIZE }}
      onClick={() => {
        sound.tap();
        props.openMap();
      }}
    >
      <canvas ref={canvasRef} style={{ inlineSize: SIZE, blockSize: SIZE }} />
    </button>
  );
}
