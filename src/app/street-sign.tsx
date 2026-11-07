/**
 * The street the walker is on, on a plate like Leuven's own street signs (enamel blue under
 * a pale rim), in the start corner: the one thing on screen that says where you are. A new name
 * slides in calmly from the side; screen readers hear it politely, since the region stays in the
 * page while the plate comes and goes.
 */
export function StreetSign(props: { name: string | null }) {
  return (
    <output className="sign-slot">
      {props.name && (
        <span className="sign">
          <span className="sr-only">On </span>
          {/* Keyed, so each new name gets its own entrance. */}
          {/* A name breaks between words, never at its own hyphen (Sint-Pieterskerk). */}
          <span key={props.name} className="sign-name">
            {props.name.replaceAll('-', '\u2011')}
          </span>
        </span>
      )}
    </output>
  );
}
