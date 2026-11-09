/** A name this long still reads as one line on the plate. */
const ONE_LINE = 22;
/** A room's name and its floor, which the plate takes apart before anything else. */
const ROOM = ' · ';

/** How a name goes on the street plate: its lines, and what stood where it was broken. */
export interface SignLines {
  first: string;
  second?: string;
  between?: string;
}

/**
 * The name in one line if it's short, else in two as even as its words allow. Chosen here, not by
 * the browser: a plate as wide as the words needs to know them, and wrapped text keeps the width
 * of the line it would have been. A room and its floor part where they meet.
 */
export function signLines(name: string): SignLines {
  if (name.length <= ONE_LINE) return { first: name };
  const room = name.indexOf(ROOM);
  if (room > 0) {
    return { first: name.slice(0, room), second: name.slice(room + ROOM.length), between: ROOM };
  }
  let best = -1;
  for (let i = name.indexOf(' '); i > 0; i = name.indexOf(' ', i + 1)) {
    const longest = (at: number) => Math.max(at, name.length - at - 1);
    if (best < 0 || longest(i) < longest(best)) best = i;
  }
  if (best < 0) return { first: name };
  return { first: name.slice(0, best), second: name.slice(best + 1), between: ' ' };
}
