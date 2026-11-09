import type { Dot } from './minimap.ts';

/**
 * What changes every frame or so and only a few corners of the page draw (the minimap): kept out
 * of React's state, so walking doesn't re-render the app. Whoever draws it listens, and reads.
 */
interface Live {
  /** Where you are (m) and which way you face, once the avatar is on the map. */
  me: { x: number; z: number; facing: number } | null;
  /** Which way the view looks, clockwise from north (radians). */
  heading: number;
  /** Everyone else, as dots in their shirts' colours. */
  others: readonly Dot[];
  /** Says that something changed. */
  changed(): void;
  /** Calls `news` on every change; returns an unsubscribe. */
  listen(news: () => void): () => void;
}

function createLive(): Live {
  const listeners = new Set<() => void>();
  return {
    me: null,
    heading: 0,
    others: [],
    changed() {
      for (const news of listeners) news();
    },
    listen(news) {
      listeners.add(news);
      return () => listeners.delete(news);
    },
  };
}

/** The page's one: the map writes it, the corners that draw it read it. */
export const live = createLive();
