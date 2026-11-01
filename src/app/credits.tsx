import { CREDITS } from '../data/providers.ts';

/**
 * Data credits required by the licences (ODbL, GRB), in the least space that stays legible.
 * They come from the source manifest, so a new provider can't ship uncredited.
 */
export function Credits(props: { open: boolean; onToggle: () => void }) {
  return (
    <div className="credits">
      <p id="credits-text" hidden={!props.open}>
        {CREDITS.map((c) => (
          <a key={c.href} href={c.href}>
            {c.label}
          </a>
        ))}
      </p>
      <button
        type="button"
        className="credits-toggle"
        aria-expanded={props.open}
        aria-controls="credits-text"
        aria-label="Map data credits"
        onClick={props.onToggle}
      >
        ©
      </button>
    </div>
  );
}
