/**
 * Draws the app icon (a pixel-art Flemish stepped gable) and writes the PWA icons to
 * public/icons/. The art lives here as text, so changing the icon is a code review.
 *
 *   bun run icons
 */

import * as Png from '@portable/png';

const ART = [
  '................',
  '.......##.......',
  '.......##.......',
  '.....######.....',
  '.....######.....',
  '...##########...',
  '...##w####w##...',
  '...##w####w##...',
  '...##########...',
  '...##w####w##...',
  '...##w####w##...',
  '...##########...',
  '...####dd####...',
  '...####dd####...',
  'cccccccccccccccc',
  'cccccccccccccccc',
];

const COLORS: Record<string, [number, number, number]> = {
  '.': [188, 214, 234], // sky
  '#': [181, 82, 59], // brick
  w: [240, 230, 208], // window frames
  d: [43, 36, 32], // door
  c: [215, 198, 163], // cobbles
};

/** Renders the art scaled up with nearest-neighbour, centred on a sky-filled square. */
function draw(size: number, artCells: number): Uint8Array {
  const cell = Math.floor(size / artCells);
  const offset = Math.floor((size - cell * ART.length) / 2);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const row = ART[Math.floor((y - offset) / cell)];
      const ch = y < offset || x < offset ? '.' : (row?.[Math.floor((x - offset) / cell)] ?? '.');
      // The ground runs to the bottom edge so the maskable icon has no sky strip under it.
      const key = y >= offset + cell * 14 ? 'c' : ch;
      data.set([...COLORS[key]!, 255], (y * size + x) * 4);
    }
  }
  return data;
}

const icons: [name: string, size: number, cells: number][] = [
  ['favicon-32.png', 32, 16],
  ['apple-touch-icon.png', 180, 18],
  ['icon-192.png', 192, 16],
  ['icon-512.png', 512, 16],
  // Maskable icons need their content inside the centre 80%.
  ['icon-maskable-512.png', 512, 20],
];

await Promise.all(
  icons.map(async ([name, size, cells]) => {
    const png = await Png.encode({ width: size, height: size, data: draw(size, cells) });
    await Bun.write(new URL(`../public/icons/${name}`, import.meta.url), png);
    console.log(`public/icons/${name} ${png.length} bytes`);
  }),
);
