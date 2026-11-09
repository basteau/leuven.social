import { signLines } from './sign-lines.ts';

/**
 * The street the walker is on, on a plate like Leuven's own street signs (enamel blue under
 * a pale rim), in the start corner: the one thing on screen that says where you are. As wide as
 * its words, on one line or two (`signLines`). A new name
 * slides in calmly from the side; screen readers hear it politely, since the region stays in the
 * page while the plate comes and goes.
 */
export function StreetSign(props: { name: string | null }) {
  // A name breaks between words, never at its own hyphen (Sint-Pieterskerk).
  const name = props.name?.replaceAll('-', '\u2011');
  const lines = name ? signLines(name) : null;
  return (
    <output className="sign-slot">
      {lines && (
        <span className="sign" data-lines={lines.second ? 2 : 1}>
          <span className="sr-only">On </span>
          {/* Keyed, so each new name gets its own entrance. */}
          <span key={name} className="sign-name">
            <span className="sign-line">{lines.first}</span>
            {lines.between === ' ' ? ' ' : <span className="sr-only">{lines.between}</span>}
            {lines.second && <span className="sign-line">{lines.second}</span>}
          </span>
        </span>
      )}
    </output>
  );
}
