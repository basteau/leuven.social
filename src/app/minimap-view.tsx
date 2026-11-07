import { useEffect, useMemo, useRef, useState } from 'react';

import type { City } from '../data/city.ts';
import { live } from './live.ts';
import { drawMinimap, indexCity } from './minimap.ts';
import type { MinimapIndex } from './minimap.ts';

/** How much of the city it shows across (m): the streets round you, or the centre. */
const RANGES = [360, 1400] as const;

/** Draws the minimap at the canvas's size on screen, in device pixels. */
function paint(
  canvas: HTMLCanvasElement,
  pen: CanvasRenderingContext2D,
  index: MinimapIndex,
  range: number,
): void {
  const size = Math.round(canvas.clientWidth * Math.min(globalThis.devicePixelRatio || 1, 2));
  if (!size) return;
  if (canvas.width !== size) [canvas.width, canvas.height] = [size, size];
  const me = live.me ?? { x: 0, z: 0, facing: 0 };
  drawMinimap(pen, index, { ...me, heading: live.heading, range, size }, live.others);
}

/**
 * The minimap in the bottom start corner: a round window on the city round you, turned the way
 * the view looks. Pressed, it shows more of the city, or less again. Its own chunk, drawn on the
 * next animation frame after anything moves, and not at all while nothing does.
 */
export function Minimap({ city }: { city: City }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [far, setFar] = useState(false);
  const index = useMemo(() => indexCity(city), [city]);
  const range = RANGES[far ? 1 : 0];

  useEffect(() => {
    const canvas = canvasRef.current;
    const pen = canvas?.getContext('2d');
    if (!canvas || !pen) return;
    let frame = 0;
    const soon = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        paint(canvas, pen, index, range);
      });
    };
    paint(canvas, pen, index, range);
    const unlisten = live.listen(soon);
    const resized = new ResizeObserver(soon);
    resized.observe(canvas);
    return () => {
      unlisten();
      resized.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [index, range]);

  return (
    <button
      type="button"
      className="minimap"
      aria-label="Minimap: show more of the city"
      aria-pressed={far}
      onClick={() => setFar((f) => !f)}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
    </button>
  );
}
