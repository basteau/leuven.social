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

/** A folded map: three panels with a pin's dot on the middle one. */
export const MapIcon = () => (
  <svg {...iconBase}>
    <path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z" />
    <path d="M9 4v14M15 6v14" />
  </svg>
);

/** Stop: a filled square, the one shape that means it everywhere. */
export const StopIcon = () => (
  <svg {...iconBase}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" />
  </svg>
);

/** The menu: three lines, the shape people look for to find everything else. */
export const MenuIcon = () => (
  <svg {...iconBase}>
    <path d="M4 7h16M4 12h16M4 17h10" />
  </svg>
);
