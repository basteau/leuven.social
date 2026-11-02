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

/** The menu: three lines, the shape people look for to find everything else. */
export const MenuIcon = () => (
  <svg {...iconBase}>
    <path d="M4 7h16M4 12h16M4 17h10" />
  </svg>
);
