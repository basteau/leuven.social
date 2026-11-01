/** 24 × 24 stroke icons drawn in currentColor. Decorative: buttons carry the visible label. */

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

export const ResetIcon = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="7" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
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

export const MapIcon = () => (
  <svg {...base}>
    <path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z" />
    <path d="M9 3v15M15 6v15" />
  </svg>
);

export const PinIcon = () => (
  <svg {...base}>
    <path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z" />
    <circle cx="12" cy="10" r="2" />
  </svg>
);

export const CloseIcon = () => (
  <svg {...base}>
    <path d="M6 6l12 12M18 6L6 18" />
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
