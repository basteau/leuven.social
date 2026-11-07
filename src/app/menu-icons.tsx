/** The menu's icons, in its own chunk: one for each command, in the map's icons' style. */

import { iconBase as base } from './icons.tsx';

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

/** Back: a chevron, the way an app steps back up a level. */
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

/** A compass needle, north half filled: the view as first seen. */
export const CompassIcon = () => (
  <svg {...base}>
    <path d="M12 3l3.5 9h-7z" fill="currentColor" />
    <path d="M8.5 12h7L12 21z" />
  </svg>
);

/** A folded map: three panels. */
export const MapIcon = () => (
  <svg {...base}>
    <path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z" />
    <path d="M9 3v15M15 6v15" />
  </svg>
);

/** A speaker with sound coming out (on), or crossed out (off). */
export const SoundIcon = (props: { on: boolean }) => (
  <svg {...base}>
    <path d="M4 9h3l5-4v14l-5-4H4z" />
    {props.on ? (
      <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" />
    ) : (
      <path d="M16 9.5l5 5M21 9.5l-5 5" />
    )}
  </svg>
);

export const SearchIcon = () => (
  <svg {...base}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </svg>
);

export const CloseIcon = () => (
  <svg {...base}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

/** A keyboard, for the controls and the shortcuts. */
export const KeysIcon = () => (
  <svg {...base}>
    <rect x="3" y="6" width="18" height="12" rx="2.5" />
    <path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" />
  </svg>
);

export const InfoIcon = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
);

/** A street plate, for a place found by name. */
export const PlaceIcon = () => (
  <svg {...base}>
    <rect x="3" y="7" width="18" height="9" rx="2" />
    <path d="M7 11.5h10M12 16v4" />
  </svg>
);

/** A bike's bell: a dome on a stalk, struck. */
export const BellIcon = () => (
  <svg {...base}>
    <path d="M5 17a7 7 0 0 1 14 0z" />
    <path d="M12 10V7M10 21h4" />
  </svg>
);

/** The sun: a disc and its rays. */
export const SunIcon = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
  </svg>
);

/** The moon: a crescent. */
export const MoonIcon = () => (
  <svg {...base}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
  </svg>
);

/** A clock, for the day passing. */
export const ClockIcon = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
