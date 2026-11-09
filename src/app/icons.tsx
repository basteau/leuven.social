import { YOU_DEEP, YOU_LIT } from './colours.ts';

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

export const WalkIcon = () => (
  <svg {...iconBase}>
    <circle cx="13" cy="4.5" r="2" />
    <path d="M8 21l3-7 3 3v4" />
    <path d="M11 14l2-6-4 2.5V14" />
    <path d="M13 8l2.5 3.5H18" />
  </svg>
);

export const RotateLeftIcon = () => (
  <svg {...iconBase}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </svg>
);

export const RotateRightIcon = () => (
  <svg {...iconBase}>
    <path d="M21 12a9 9 0 1 1-3-6.7" />
    <path d="M21 4v5h-5" />
  </svg>
);

export const PlusIcon = () => (
  <svg {...iconBase}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const MinusIcon = () => (
  <svg {...iconBase}>
    <path d="M5 12h14" />
  </svg>
);

/** The compass's needle: north in the avatar's coral, south hollow. Turned with the view. */
export const NeedleIcon = () => (
  <svg {...iconBase}>
    <path d="M12 3l4 9h-8z" fill="var(--you)" stroke="var(--ink)" strokeWidth="1.5" />
    <path d="M8 12h8l-4 9z" strokeWidth="1.5" />
  </svg>
);

/** Back to you: a target, hollow while the view is elsewhere and filled while it's on you. */
export const TargetIcon = ({ on }: { on: boolean }) => (
  <svg {...iconBase}>
    <circle cx="12" cy="12" r="6" />
    <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    {on && <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />}
  </svg>
);

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

/**
 * You, as a mark: a cut diamond in the avatar's shirt colour, three flat facets lit from the upper
 * left as the toon ramp would, inked round like everything else on the map. Its long point stays
 * a direction: down at the avatar over its head, turned toward it at the edge of the screen.
 */
export const DiamondIcon = () => (
  <svg width="26" height="34" viewBox="0 0 26 34" aria-hidden="true">
    <path d="M13 2 24 12 13 32 2 12Z" fill="var(--you)" />
    <path d="M13 2 2 12H13Z" fill={YOU_LIT} />
    <path d="M13 12H24L13 32Z" fill={YOU_DEEP} />
    <path
      d="M13 2 24 12 13 32 2 12Z"
      fill="none"
      stroke="var(--ink)"
      strokeWidth="2.4"
      strokeLinejoin="round"
    />
  </svg>
);

/** Two people, a head and shoulders each: how many are here. */
export const PeopleIcon = () => (
  <svg {...iconBase} width="16" height="16" aria-hidden="true">
    <circle cx="9" cy="8" r="3" />
    <path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" />
    <path d="M16 5.5a3 3 0 0 1 0 5.6M18 13.8c1.8.7 3 2.6 3 5.2" />
  </svg>
);
