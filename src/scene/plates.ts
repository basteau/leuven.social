import type * as Three from 'three';
import type { BufferAttribute, Material, Object3D, Scene, Texture } from 'three';

import type { City } from '../data/city.ts';
import {
  HOUSE_PLATE_HEIGHT,
  PLATE_BUCKET,
  PROUD,
  PlateIndex,
  STREET_PLATE_HEIGHT,
  plateBucket,
  unpackWalk,
} from '../data/plates.ts';
import type { WalkData } from '../data/plates.ts';
import {
  AWNING_REACH,
  PLATE_DEPTH,
  PlateBuffers,
  Walls,
  addPlate,
  boardColour,
  fitBoard,
  linearRgb,
  packCells,
  plateHeights,
  plateWidth,
} from './plate-mesh.ts';
import type { Facade, PlateStyle, Slice } from './plate-mesh.ts';
import { FRONTS } from './palette.ts';
import type { PLATE } from './palette.ts';

/**
 * The enamel plates on the facades while walking: house numbers beside the doors, street names
 * on the corners and the shops' name boards, real geometry in the scene, lit and hidden by
 * buildings like the rest.
 * One mesh and one draw call for every plate near the walker, built again only when the walker
 * steps into another square; nothing per frame. Their letters come from one atlas, drawn once
 * by the browser from the letters the plates use. This module and walk.bin load with the first
 * walk.
 */

export const WALK_URL = `${import.meta.env.BASE_URL}data/walk.bin`;

/** Plates within this distance (m) of the walker are in the mesh: numbers, street names, boards. */
const HOUSE_REACH = 40;
const STREET_REACH = 60;
const BOARD_REACH = 50;
/** The mesh is built round the middle of the walker's square, so it covers the whole square. */
const SLACK = PLATE_BUCKET * Math.SQRT1_2;
/** At most this many of each, nearest first: the densest square in the city has about 86 and 33. */
const MAX_HOUSES = 200;
const MAX_STREETS = 64;
const MAX_BOARDS = 96;
/**
 * A name board's height (m), least and most: on a fascia, the band the facade paints over a shop
 * window; on an awning, a little deeper than its 0.2 m valance. A long name makes it shorter.
 */
const FASCIA: [number, number] = [0.32, 0.5];
const VALANCE: [number, number] = [0.26, 0.4];
/** A board stops this far (m) short of its front's ends, so two side by side don't touch. */
const BOARD_INSET = 0.1;

const ATLAS_WIDTH = 1024;
/** Texels between the atlas's cells, and how far each cell's enamel reaches into them. */
const GUTTER = 16;
const BLEED = GUTTER / 2;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** How a style of plate is drawn: in texels, and in plate heights. */
interface Design {
  height: number;
  /** Texels of the atlas a plate's height spans. */
  texels: number;
  weight: number;
  /** Letter size and spacing, in plate heights and em. */
  size: number;
  spacing: number;
  radius: number;
  cap: number;
  minWidth: number;
  /**
   * A name board's cells are clear where a plate's are enamel: the board's own paint (its
   * kind's) shows through, so one set of letters serves every colour of board.
   */
  clear?: boolean;
}
/**
 * Every kind of plate, drawn into one atlas for one draw call: house numbers, street names and
 * the shops' name boards. Another kind is another row: its letters go into the same atlas.
 */
const STYLES = {
  /** House numbers: a small plate, big bold digits. */
  house: {
    height: HOUSE_PLATE_HEIGHT,
    texels: 80,
    weight: 800,
    size: 0.6,
    spacing: 0,
    radius: 0.2,
    cap: 0.28,
    minWidth: 1.45,
  },
  /**
   * Street names: the HUD plate's letters (weight 750), spaced a little wider than on screen so
   * they stay apart from across the street, on a plate as long as the name.
   */
  street: {
    height: STREET_PLATE_HEIGHT,
    texels: 96,
    weight: 750,
    size: 0.46,
    spacing: 0.03,
    radius: 0.16,
    cap: 0.3,
    minWidth: 2.4,
  },
  /** Shop names: bold paper letters painted on a board, under a thin paper line. */
  board: {
    height: VALANCE[1],
    texels: 56,
    weight: 700,
    size: 0.56,
    spacing: 0.04,
    radius: 0.1,
    cap: 0.16,
    minWidth: 1,
    clear: true,
  },
} satisfies Record<string, Design>;
type Kind = keyof typeof STYLES;
/** The enamel's layers from the edge in, in plate heights: ink, enamel, then the paper rim. */
const INK_EDGE = 0.05;
const RIM_INSET = 0.11;
const RIM = 0.045;

const font = (d: Design) => `${d.weight} ${Math.round(d.size * d.texels)}px ${FONT}`;
const hex = (colour: number) => `#${colour.toString(16).padStart(6, '0')}`;

interface Atlas {
  canvas: HTMLCanvasElement;
  styles: Record<Kind, PlateStyle>;
  ink: [number, number];
}

/** Draws every letter the plates use, once, as slices of enamel plate. */
function drawAtlas(texts: Record<Kind, Iterable<string>>, colours: typeof PLATE): Atlas {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const kinds = Object.keys(STYLES) as Kind[];
  const sets = kinds.map((kind) => ({
    design: STYLES[kind] as Design,
    chars: [...new Set(texts[kind])].toSorted(),
  }));
  // Measure first: the atlas's height follows from the letters.
  type Item = {
    set: number;
    kind: 'left' | 'right' | 'blank' | 'glyph';
    ch: string;
    width: number;
  };
  const items: Item[] = [];
  for (const [set, { design, chars }] of sets.entries()) {
    const capWidth = design.cap * design.texels;
    items.push(
      { set, kind: 'left', ch: '', width: capWidth },
      { set, kind: 'right', ch: '', width: capWidth },
      { set, kind: 'blank', ch: '', width: 4 },
    );
    ctx.font = font(design);
    const spacing = design.spacing * design.size * design.texels;
    for (const ch of chars) {
      items.push({ set, kind: 'glyph', ch, width: ctx.measureText(ch).width + spacing });
    }
  }
  const cells = [
    ...items.map((item) => ({ width: item.width, height: sets[item.set]!.design.texels })),
    { width: 16, height: 16 },
  ];
  const { at, height } = packCells(cells, ATLAS_WIDTH, GUTTER);
  canvas.width = ATLAS_WIDTH;
  canvas.height = height;
  ctx.fillStyle = hex(colours.ink);
  ctx.fillRect(0, 0, ATLAS_WIDTH, height);

  /** Enamel from x0 to x1 (texels), rounded at either end, `h` texels tall from y. */
  const enamel = (x0: number, x1: number, y: number, d: Design, left: boolean, right: boolean) => {
    const h = d.texels;
    const paint = d.clear ? null : colours.enamel;
    const layers: [number, number | null][] = [
      [0, colours.ink],
      [INK_EDGE, paint],
      [RIM_INSET, colours.paper],
      [RIM_INSET + RIM, paint],
    ];
    for (const [inset, colour] of layers) {
      const i = inset * h;
      const r = Math.max(0, d.radius * h - i);
      const [a, b] = [left ? x0 + i : x0, right ? x1 - i : x1];
      // A board's paint: no colour here, only no alpha.
      ctx.globalCompositeOperation = colour === null ? 'destination-out' : 'source-over';
      ctx.fillStyle = hex(colour ?? 0);
      ctx.beginPath();
      ctx.roundRect(a, y + i, b - a, h - 2 * i, [
        left ? r : 0,
        right ? r : 0,
        right ? r : 0,
        left ? r : 0,
      ]);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  };
  const slice = (x: number, y: number, width: number, d: Design): Slice => ({
    u0: x / ATLAS_WIDTH,
    u1: (x + width) / ATLAS_WIDTH,
    v0: 1 - (y + d.texels) / height,
    v1: 1 - y / height,
    width: width / d.texels,
  });

  const styles = sets.map(({ design }) => ({
    height: design.height,
    radius: design.radius,
    minWidth: design.minWidth,
    glyphs: new Map<string, Slice>(),
  })) as (Omit<PlateStyle, 'left' | 'right' | 'blank' | 'glyphs'> &
    Partial<PlateStyle> & { glyphs: Map<string, Slice> })[];
  for (const [n, item] of items.entries()) {
    const [x, y] = at[n]!;
    const { design } = sets[item.set]!;
    const style = styles[item.set]!;
    const w = item.width;
    if (item.kind === 'left') {
      enamel(x, x + w + BLEED, y, design, true, false);
      style.left = slice(x, y, w, design);
    } else if (item.kind === 'right') {
      enamel(x - BLEED, x + w, y, design, false, true);
      style.right = slice(x, y, w, design);
    } else if (item.kind === 'blank') {
      enamel(x - BLEED, x + w + BLEED, y, design, false, false);
      // Its middle only: stretched, it is the same enamel all along.
      style.blank = { ...slice(x + 1, y, 2, design), width: 0 };
    } else {
      enamel(x - BLEED, x + w + BLEED, y, design, false, false);
      ctx.font = font(design);
      ctx.fillStyle = hex(colours.paper);
      ctx.textBaseline = 'alphabetic';
      // Capitals and figures sit in the middle of the enamel; accents and descenders around them.
      const capital = ctx.measureText('H').actualBoundingBoxAscent;
      const spacing = design.spacing * design.size * design.texels;
      ctx.fillText(item.ch, x + spacing / 2, y + (design.texels + capital) / 2);
      style.glyphs.set(item.ch, slice(x, y, w, design));
    }
  }
  const [ix, iy] = at.at(-1)!;
  return {
    canvas,
    styles: Object.fromEntries(
      kinds.map((kind, i) => [kind, styles[i] as PlateStyle]),
    ) as Atlas['styles'],
    ink: [(ix + 8) / ATLAS_WIDTH, 1 - (iy + 8) / height],
  };
}

/**
 * What the plates build with, from the viewer's chunk: imported here, three.js would be shared by
 * two lazy chunks (walk mode's and this one), and the bundler would split it out of the viewer
 * into one more file that every first visit loads. The palette is a chunk of its own, loaded with
 * the engine (vite.config.ts), so the boards' `FRONTS` come from it directly.
 */
export interface PlateKit {
  three: Pick<
    typeof Three,
    'BufferAttribute' | 'BufferGeometry' | 'CanvasTexture' | 'Mesh' | 'MeshToonMaterial'
  > & { SRGBColorSpace: typeof Three.SRGBColorSpace };
  /** `PLATE` from palette.ts. */
  colours: typeof PLATE;
}

export interface PlatesHost {
  kit: PlateKit;
  scene: Scene;
  city: City;
  /** How a building's walls are drawn: a plate hangs on them, over its house's foot. */
  facade(building: City['buildings'][number]): Facade;
  height(x: number, z: number): number;
  /** The ground as drawn, which an awning stands over where it's above its house's foot. */
  ground(x: number, z: number): number;
  gradientMap: Texture;
  /** The most anisotropic filtering the GPU offers, so letters stay sharp at a slant. */
  anisotropy: number;
  /** Compiles the plates' shader off the main thread, before they first show. */
  compile(object: Object3D): Promise<unknown>;
  /** Asks for a frame: the plates are ready to show. */
  changed(): void;
  /** Lets a plate dither away with the wall it's on, where that stands in front of the avatar. */
  dither?(material: Material): void;
}

export interface Plates {
  /** Where the view looks and whether plates show (close to the street). */
  update(x: number, z: number, show: boolean): void;
  /** How many plates the mesh holds now, for the smoke test. */
  readonly shown: number;
  dispose(): void;
}

export async function loadPlates(host: PlatesHost, signal?: AbortSignal): Promise<Plates> {
  const response = await fetch(WALK_URL, signal ? { signal } : {});
  if (!response.ok) throw new Error(`The plates failed to load (HTTP ${response.status}).`);
  return createPlates(host, await unpackWalk(new Uint8Array(await response.arrayBuffer())));
}

export function createPlates(host: PlatesHost, data: WalkData): Plates {
  const names = host.city.streetNames;
  const { BufferAttribute, BufferGeometry, CanvasTexture, Mesh, MeshToonMaterial } = host.kit.three;
  const atlas = drawAtlas(
    {
      house: data.houses.flatMap((h) => [...h.text]),
      street: data.streets.flatMap((s) => [...(names[s.name] ?? '')]),
      board: ['…', ...data.boards.flatMap((b) => [...b.name])],
    },
    host.kit.colours,
  );
  const texture = new CanvasTexture(atlas.canvas);
  texture.colorSpace = host.kit.three.SRGBColorSpace;
  texture.anisotropy = host.anisotropy;
  const material = new MeshToonMaterial({
    map: texture,
    gradientMap: host.gradientMap,
    vertexColors: true,
  });
  host.dither?.(material);
  // Where the atlas is clear (a board's), its paint: the vertex colour, under paper letters.
  const dither = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    dither.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      'diffuseColor = vec4(mix(vColor.rgb, diffuseColor.rgb, diffuseColor.a), 1.0);',
    );
  };
  /** Each kind's board paint, in linear light, as the vertex colours carry it. */
  const paint = Object.fromEntries(
    Object.entries(FRONTS).map(([kind, front]) => [
      kind,
      linearRgb(boardColour(front, host.kit.colours.paper)),
    ]),
  );
  const geometry = new BufferGeometry();
  const mesh = new Mesh(geometry, material);
  // Rebuilt round the walker, so it's always near the view: no bounds to keep up to date.
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  host.scene.add(mesh);

  let ready = false;
  mesh.visible = true; // compiling looks only at what's visible
  const settle = () => {
    ready = true;
    host.changed();
  };
  host.compile(mesh).then(settle, settle);
  mesh.visible = false;

  const houses = new PlateIndex(data.houses);
  const streets = new PlateIndex(data.streets);
  const boards = new PlateIndex(data.boards);
  const buffers = new PlateBuffers();
  let walls: Walls | undefined;
  let built = Number.NaN;
  let shown = 0;

  function rebuild(x: number, z: number): void {
    const cx = (Math.floor(x / PLATE_BUCKET) + 0.5) * PLATE_BUCKET;
    const cz = (Math.floor(z / PLATE_BUCKET) + 0.5) * PLATE_BUCKET;
    buffers.reset();
    const nearHouses = houses.near(cx, cz, HOUSE_REACH + SLACK, MAX_HOUSES);
    const nearStreets = streets.near(cx, cz, STREET_REACH + SLACK, MAX_STREETS);
    const nearBoards = boards.near(cx, cz, BOARD_REACH + SLACK, MAX_BOARDS);
    const { buildings } = host.city;
    walls ??= new Walls(
      buildings.map((b) => b.ring),
      { facade: (b) => host.facade(buildings[b]!), height: host.height },
    );
    /** Settled onto its drawn wall, at its kind's height over the foot of its house. */
    const hang = (
      kind: 'house' | 'street',
      plate: { x: number; z: number; angle: number },
      text: string,
    ) => {
      const style = atlas.styles[kind];
      const half = (plateWidth(text, style) * style.height) / 2;
      const at = walls!.hang(plate.x, plate.z, plate.angle, half);
      const y = at.foot + plateHeights(at.top, at.shop)[kind];
      addPlate(buffers, { ...at, y, text, style }, atlas.ink);
    };
    for (const i of nearHouses) hang('house', data.houses[i]!, data.houses[i]!.text);
    for (const i of nearStreets) {
      const s = data.streets[i]!;
      hang('street', s, names[s.name] ?? '');
    }
    // A shop's name: on its awning's valance where it has one, else on the fascia over its window.
    for (const i of nearBoards) {
      const b = data.boards[i]!;
      const valance = b.awning && FRONTS[b.kind].awning;
      const [low, high] = valance ? VALANCE : FASCIA;
      const width = b.width - 2 * BOARD_INSET;
      const fit = fitBoard(b.name, atlas.styles.board, width, low, high);
      if (!fit) continue;
      const style = { ...atlas.styles.board, height: fit.height, minWidth: width / fit.height };
      const at = walls!.hang(b.x, b.z, b.angle, width / 2);
      const heights = plateHeights(at.top, at.shop);
      // The awning hangs off the surveyed wall, where the bake put the board, not the drawn one.
      const out = AWNING_REACH + PLATE_DEPTH - 0.01 - PROUD;
      const place = valance
        ? { x: b.x + Math.cos(b.angle) * out, z: b.z + Math.sin(b.angle) * out, angle: b.angle }
        : at;
      buffers.tint = paint[b.kind]!;
      // An awning stands over the street in front where that's higher (storefronts.ts).
      const reach = AWNING_REACH - PROUD;
      const foot = valance
        ? Math.max(
            at.foot,
            host.ground(b.x + Math.cos(b.angle) * reach, b.z + Math.sin(b.angle) * reach),
          )
        : at.foot;
      const y = foot + (valance ? heights.valance : heights.fascia);
      addPlate(buffers, { ...place, y, text: fit.text, style }, atlas.ink);
    }
    shown = nearHouses.length + nearStreets.length + nearBoards.length;
    const fill = (name: string, array: Float32Array, size: number) => {
      const current = geometry.getAttribute(name) as BufferAttribute | undefined;
      if (current?.array === array) {
        current.clearUpdateRanges();
        current.addUpdateRange(0, buffers.vertices * size);
        current.needsUpdate = true;
      } else geometry.setAttribute(name, new BufferAttribute(array, size));
    };
    fill('position', buffers.positions, 3);
    fill('normal', buffers.normals, 3);
    fill('uv', buffers.uvs, 2);
    fill('color', buffers.colors, 3);
    const index = geometry.getIndex();
    if (index?.array === buffers.indices) {
      index.clearUpdateRanges();
      index.addUpdateRange(0, buffers.count);
      index.needsUpdate = true;
    } else geometry.setIndex(new BufferAttribute(buffers.indices, 1));
    geometry.setDrawRange(0, buffers.count);
  }

  return {
    update(x, z, show) {
      if (!show || !ready) {
        mesh.visible = false;
        return;
      }
      const bucket = plateBucket(x, z);
      if (bucket !== built) {
        built = bucket;
        rebuild(x, z);
      }
      mesh.visible = shown > 0;
    },
    get shown() {
      return mesh.visible ? shown : 0;
    },
    dispose() {
      host.scene.remove(mesh);
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
