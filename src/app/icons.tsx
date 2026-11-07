/**
 * 24 × 24 stroke icons drawn in currentColor. Decorative: every control carries its own name.
 * These are the few on the map; the menu's own are in menu-icons.tsx, which loads with it.
 */

export const iconBase = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/** A city bike seen side on: two wheels, the frame between them, the bars up front. */
export const BikeIcon = () => (
  <svg {...iconBase}>
    <circle cx="5.5" cy="16" r="3.5" />
    <circle cx="18.5" cy="16" r="3.5" />
    <path d="M5.5 16L9 9h7l2.5 7M9 9l3 7 4-7M15 6h2.5l-1.5 3M8 6h3" />
  </svg>
);

/** A door in its arch, ajar: going into a building, or out of it. */
export const DoorIcon = () => (
  <svg {...iconBase}>
    <path d="M5 21V10a7 7 0 0 1 14 0v11M3 21h18M12 21V8l5 2v11" />
  </svg>
);

/** The menu: three lines, the shape people look for to find everything else. */
export const MenuIcon = () => (
  <svg {...iconBase}>
    <path d="M4 7h16M4 12h16M4 17h10" />
  </svg>
);

/**
 * The avatar's arrow: a coral arrowhead in ink, pointing down at it (rotated for the edge of
 * the screen), in the avatar's own shirt colour so it reads as "you".
 */
export const ArrowIcon = () => (
  <svg width="26" height="30" viewBox="0 0 26 30" aria-hidden="true">
    <path
      d="M13 28 L3 14 H9 V3 H17 V14 H23 Z"
      fill="var(--you, #fa8064)"
      stroke="var(--ink)"
      strokeWidth="2.5"
      strokeLinejoin="round"
    />
  </svg>
);
