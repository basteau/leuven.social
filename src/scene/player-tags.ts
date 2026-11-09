/**
 * The other players' names, over their heads, as tags in the page. Who shows when several would
 * overlap is a greedy pass by rank (the nearest first), a pure function so it is tested; a tag
 * that loses its place fades out rather than jumps away, and the nearest are on top.
 */

/** Tags closer than this to each other (px) count as touching. */
const GAP = 2;

/**
 * Which of `n` tags to show: flat [x, y, width, height, …] boxes in rank order (the nearest
 * first; (x, y) the bottom middle, where a tag is hung from), writing 1 into `keep[i]` for each
 * that overlaps none shown before it and 0 otherwise. A tag with no width isn't there.
 */
export function declutter(boxes: ArrayLike<number>, n: number, keep: Uint8Array): void {
  for (let i = 0; i < n; i++) {
    const [x, y, w, h] = [boxes[i * 4]!, boxes[i * 4 + 1]!, boxes[i * 4 + 2]!, boxes[i * 4 + 3]!];
    let clear = w > 0;
    for (let j = 0; clear && j < i; j++) {
      if (!keep[j]) continue;
      const [ox, oy, ow, oh] = [
        boxes[j * 4]!,
        boxes[j * 4 + 1]!,
        boxes[j * 4 + 2]!,
        boxes[j * 4 + 3]!,
      ];
      const apartX = Math.abs(x - ox) > (w + ow) / 2 + GAP;
      const apartY = y + GAP < oy - oh || oy + GAP < y - h;
      clear = apartX || apartY;
    }
    keep[i] = clear ? 1 : 0;
  }
}

/** One tag: an element kept for whoever wears the figure it belongs to. */
export interface Tag {
  el: HTMLElement;
  /** Its size, measured once its name is written. */
  width: number;
  height: number;
  x: number;
  y: number;
  opacity: number;
  order: number;
  shown: boolean;
}

const hex = (colour: number) => `#${colour.toString(16).padStart(6, '0')}`;

export function createTag(parent: HTMLElement, colour: number): Tag {
  const el = document.createElement('div');
  el.className = 'player-tag';
  el.dataset.shown = '0';
  el.style.setProperty('--shirt', hex(colour));
  parent.append(el);
  return {
    el,
    width: 0,
    height: 0,
    x: Number.NaN,
    y: Number.NaN,
    opacity: -1,
    order: -1,
    shown: false,
  };
}

/** Writes a name and how wide it is: the only layout a tag ever asks for. */
export function nameTag(tag: Tag, name: string, colour: number): void {
  tag.el.textContent = name;
  tag.el.style.setProperty('--shirt', hex(colour));
  const { offsetWidth, offsetHeight } = tag.el;
  tag.width = offsetWidth || name.length * 7;
  tag.height = offsetHeight || 18;
}

/** Hung at (x, y), written only as it moves by half a pixel. */
export function moveTag(tag: Tag, x: number, y: number): void {
  if (Math.abs(x - tag.x) < 0.5 && Math.abs(y - tag.y) < 0.5) return;
  [tag.x, tag.y] = [x, y];
  tag.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
}

/** Fades the tag to `opacity` (0 hides it), with `order` on top of those behind it. */
export function showTag(tag: Tag, opacity: number, order: number): void {
  const rounded = Math.round(opacity * 20) / 20;
  const shown = rounded > 0;
  if (shown !== tag.shown) {
    tag.shown = shown;
    tag.el.dataset.shown = shown ? '1' : '0';
    if (!shown) tag.x = Number.NaN;
  }
  if (rounded !== tag.opacity) {
    tag.opacity = rounded;
    tag.el.style.opacity = String(rounded);
  }
  if (order !== tag.order) {
    tag.order = order;
    tag.el.style.zIndex = String(order);
  }
}
