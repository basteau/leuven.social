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
