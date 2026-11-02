import { CREDITS } from '../data/providers.ts';

/**
 * Data credits required by the licences (ODbL, GRB): one small line in the corner, always there,
 * like a map's attribution. They come from the source manifest, so a new provider can't ship
 * uncredited; About in the menu says the rest.
 */
export function Credits() {
  return (
    <p id="credits-text" className="credits">
      {CREDITS.map((c) => (
        <a key={c.href} href={c.href}>
          {c.label}
        </a>
      ))}
    </p>
  );
}
