/** 24 × 24 stroke icons drawn in currentColor. Decorative: every control carries its own name. */

const base = {
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

export const RotateLeftIcon = () => (
  <svg {...base}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </svg>
);

export const RotateRightIcon = () => (
  <svg {...base}>
    <path d="M21 12a9 9 0 1 1-3-6.7" />
    <path d="M21 4v5h-5" />
  </svg>
);

export const PlusIcon = () => (
  <svg {...base}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const MinusIcon = () => (
  <svg {...base}>
    <path d="M5 12h14" />
  </svg>
);

export const WalkIcon = () => (
  <svg {...base}>
    <circle cx="13" cy="4.5" r="2" />
    <path d="M8 21l3-7 3 3v4" />
    <path d="M11 14l2-6-4 2.5V14" />
    <path d="M13 8l2.5 3.5H18" />
  </svg>
);

export const RunIcon = () => (
  <svg {...base}>
    <circle cx="15" cy="4.5" r="2" />
    <path d="M13 8l-2 5" />
    <path d="M11 13l3 3-1 5" />
    <path d="M11 13l-3 3H4" />
    <path d="M13 8l3 2.5 3-1" />
    <path d="M13 8l-4 1-2 3" />
  </svg>
);

/** Back to the map: a chevron, the way an app steps back up a level. */
export const BackIcon = () => (
  <svg {...base}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
);

export const PinIcon = () => (
  <svg {...base}>
    <path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z" />
    <circle cx="12" cy="10" r="2" />
  </svg>
);

/**
 * A compass needle, north half filled. It turns against the view (CSS `--heading`), so north
 * on it is north on the map.
 */
export const CompassIcon = () => (
  <svg {...base} width={26} height={26} className="compass-needle">
    <path d="M12 3l3.5 9h-7z" fill="currentColor" />
    <path d="M8.5 12h7L12 21z" />
  </svg>
);

/** The brand: a stepped gable, the shape that says "Flemish town" (the app icon's too). */
export const GableIcon = () => (
  <svg
    {...base}
    width={22}
    height={22}
    strokeWidth={2.25}
    strokeLinejoin="miter"
    strokeLinecap="square"
  >
    <path d="M4 21V12h2V9h2.5V6H11V3h2v3h2.5v3H18v3h2v9z" />
    <path d="M10 21v-5h4v5" />
  </svg>
);
