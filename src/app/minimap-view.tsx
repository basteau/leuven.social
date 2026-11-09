import { useEffect, useMemo, useRef } from 'react';

import type { City } from '../data/city.ts';
import { MapIcon } from './icons.tsx';
import { live } from './live.ts';
import { NOBODY, covers, createMinimapCrowd, drawCity, drawMinimap, indexCity } from './minimap.ts';
import type { CityImage, MinimapIndex } from './minimap.ts';

/** How much of the city it shows across (m): the streets round you. The rest is the full map. */
const RANGE = 360;
/** How often people are redrawn while nobody needs it sooner (ms): 4 Hz is plenty at this scale. */
const PEOPLE_MS = 250;

/** The city image drawn last, the canvas it was drawn on, and what the last paint showed. */
interface Cache {
  city: CityImage | null;
  canvas: HTMLCanvasElement | null;
  crowd: ReturnType<typeof createMinimapCrowd>;
  /** What the last paint drew, so a repaint can be skipped if none of it changed. */
  x: number;
  z: number;
  facing: number;
  heading: number;
  /** The list's version at the last paint, or -1 with no list: someone came, went, or changed. */
  version: number;
  settling: boolean;
}

/**
 * Draws the minimap at the canvas's size on screen, in device pixels: the city from an image of it
 * drawn once round you (`drawCity`), again only once you've walked far enough from where it was.
 */
function paint(
  canvas: HTMLCanvasElement,
  pen: CanvasRenderingContext2D,
  index: MinimapIndex,
  range: number,
  cache: Cache,
): void {
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const size = Math.round(canvas.clientWidth * dpr);
  if (!size) return;
  if (canvas.width !== size) [canvas.width, canvas.height] = [size, size];
  const me = live.me ?? { x: 0, z: 0, facing: 0 };
  const sharp = cache.canvas?.width === size * 2;
  if (!sharp || !covers(cache.city, me.x, me.z, range)) {
    const image = cache.canvas ?? document.createElement('canvas');
    [image.width, image.height] = [size * 2, size * 2];
    const drawing = image.getContext('2d');
    if (!drawing) return;
    drawCity(drawing, index, me.x, me.z, range * 2, size * 2);
    cache.canvas = image;
    cache.city = { image, x: me.x, z: me.z, span: range * 2 };
  }
  const view = { ...me, heading: live.heading, range, size, dpr };
  const people = live.people;
  people?.sample(performance.now());
  const marks = people ? cache.crowd(people, view) : NOBODY;
  drawMinimap(pen, cache.city!, view, marks);
  cache.x = me.x;
  cache.z = me.z;
  cache.facing = me.facing;
  cache.heading = live.heading;
  cache.version = people?.version ?? -1;
  cache.settling = marks.settling;
}

/**
 * The minimap in the bottom start corner: a round window on the city round you, turned the way
 * the view looks. Pressed, it opens the full map, as a map in the corner of any game does. Its
 * own chunk, drawn on the next animation frame after you move or turn, and at most four times a
 * second for everyone else, not at all while nothing does.
 */
export function Minimap(props: { city: City; onOpen: () => void; onReach: () => void }) {
  const { city } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const index = useMemo(() => indexCity(city), [city]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const pen = canvas?.getContext('2d');
    if (!canvas || !pen) return;
    let frame = 0;
    const cache: Cache = {
      city: null,
      canvas: null,
      crowd: createMinimapCrowd(),
      x: Number.NaN,
      z: 0,
      facing: 0,
      heading: 0,
      version: -1,
      settling: false,
    };
    const soon = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        paint(canvas, pen, index, RANGE, cache);
      });
    };
    paint(canvas, pen, index, RANGE, cache);
    // A change of yours draws on the next frame. Someone else's waits for the timer below, so news
    // of a crowd of thousands can't drive the minimap faster than it reads.
    const unlisten = live.listen(() => {
      const me = live.me;
      if (me?.x !== cache.x || me.z !== cache.z || me.facing !== cache.facing) soon();
      else if (live.heading !== cache.heading) soon();
    });
    const resized = new ResizeObserver(soon);
    resized.observe(canvas);
    const everyone = setInterval(() => {
      const people = live.people;
      if (document.hidden) return;
      // Signed out with the marks still drawn: one more paint takes them away.
      if (!people) {
        if (cache.version !== -1) soon();
        return;
      }
      const busy = people.sample(performance.now());
      if (busy || cache.settling || people.version !== cache.version) soon();
    }, PEOPLE_MS);
    return () => {
      unlisten();
      resized.disconnect();
      clearInterval(everyone);
      cancelAnimationFrame(frame);
    };
  }, [index]);

  return (
    <button
      type="button"
      className="minimap"
      aria-label="Open the map"
      aria-haspopup="dialog"
      aria-keyshortcuts="M"
      onClick={props.onOpen}
      onPointerEnter={props.onReach}
    >
      <span className="minimap-round">
        <canvas ref={canvasRef} aria-hidden="true" />
      </span>
      <span className="minimap-tab" aria-hidden="true">
        <MapIcon />
        Map
        <kbd>M</kbd>
      </span>
    </button>
  );
}
