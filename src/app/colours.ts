/**
 * The colours the shell, the minimap and the full map draw alike. The shell imports this, so the
 * lazy chunks take it from the shell's chunk and the bundler has nothing to split off.
 */

/** A 24-bit colour as CSS. */
export const css = (colour: number) => `#${colour.toString(16).padStart(6, '0')}`;

/** You, on every map: the avatar's coral (`--you` in index.html) and the diamond's other facets. */
export const YOU = '#fa8064';
export const YOU_LIT = '#ffb7a1';
export const YOU_DEEP = '#dc6147';
