import { useEffect, useMemo, useRef } from 'react';

import type { City } from '../data/city.ts';
import { MapIcon } from './icons.tsx';
import { live } from './live.ts';
import { covers, drawCity, drawMinimap, indexCity } from './minimap.ts';
import type { CityImage, MinimapIndex } from './minimap.ts';

/** How much of the city it shows across (m): the streets round you. The rest is the full map. */
const RANGE = 360;

/** The city image drawn last, and the canvas it was drawn on. */
interface Cache {
  city: CityImage | null;
  canvas: HTMLCanvasElement | null;
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
  const size = Math.round(canvas.clientWidth * Math.min(globalThis.devicePixelRatio || 1, 2));
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
  drawMinimap(pen, cache.city!, { ...me, heading: live.heading, range, size }, live.others);
}

/**
 * The minimap in the bottom start corner: a round window on the city round you, turned the way
 * the view looks. Pressed, it opens the full map, as a map in the corner of any game does. Its
 * own chunk, drawn on the next animation frame after anything moves, and not at all while nothing
 * does.
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
    const cache: Cache = { city: null, canvas: null };
    const soon = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        paint(canvas, pen, index, RANGE, cache);
      });
    };
    paint(canvas, pen, index, RANGE, cache);
    const unlisten = live.listen(soon);
    const resized = new ResizeObserver(soon);
    resized.observe(canvas);
    return () => {
      unlisten();
      resized.disconnect();
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
