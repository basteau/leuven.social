/**
 * The street the walker is on (or the picking reticle points at), on a plate like Leuven's own
 * street signs: enamel blue, a white rim, two rivets. A new name slides in calmly; screen readers
 * hear it politely, since the region stays in the page while the plate comes and goes.
 */
export function StreetSign(props: { name: string | null }) {
  return (
    <output className="sign-slot">
      {props.name && (
        <span className="sign">
          <span className="sr-only">On </span>
          {/* Keyed, so each new name gets its own entrance. */}
          <span key={props.name} className="sign-name">
            {props.name}
          </span>
        </span>
      )}
    </output>
  );
}
