import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';

import type { Outfit } from '../scene/viewer.ts';
import { PARTS, css, surprise } from './outfits.ts';
import './account-sheet.css';

/**
 * Who you are on the map, in a sheet like the menu's: a guest, who you are for now and a name and
 * a password to join (or to sign back in); signed in, your look, chosen from a few colours a part
 * and worn at once, and a way out. Its own chunk, fetched when it is first opened.
 */

/** Who you are on the map: signed in, or a guest with the name and look the server gave them. */
export type Account =
  | { signedIn: false; name?: string; outfit?: Outfit; unseen?: boolean }
  | { signedIn: true; name: string; outfit: Outfit };

export interface AccountSheetProps {
  open: boolean;
  onClose(): void;
  account: Account;
  /** How many are on the map now, you included; null while not connected. */
  online: number | null;
  /** Each settles once done, or fails with a message written for the person. */
  signUp(name: string, password: string): Promise<void>;
  signIn(name: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** Wears a look now; it is saved a moment later. */
  dress(outfit: Outfit): void;
}

/** The figure, flat, in a look: what the swatches change, at a glance. */
function Preview({ outfit }: { outfit: Outfit }) {
  const [skin, hair, shirt, shorts] = [outfit.skin, outfit.hair, outfit.shirt, outfit.shorts].map(
    css,
  );
  return (
    <svg className="account-preview" viewBox="0 0 64 96" aria-hidden="true">
      <g stroke="var(--ink)" strokeWidth="2" strokeLinejoin="round">
        <path d="M24 70h7v18h-7zM33 70h7v18h-7z" fill={skin} />
        <path d="M22 88h10v5H20zM32 88h10l2 5H32z" fill="var(--ink)" />
        <path d="M21 58h22l2 15H33l-1-4-1 4H19z" fill={shorts} />
        <path d="M18 34h28l4 14-6 2-1-5v14H21V45l-1 5-6-2z" fill={shirt} />
        <path d="M12 47l3-1 4 12-3 1zM52 47l-3-1-4 12 3 1z" fill={skin} />
        <path d="M24 10h16l4 7v9l-4 7H24l-4-7v-9z" fill={skin} />
        <path d="M21 17c0-8 6-12 12-12 8 0 12 5 11 12l-4-3-6 2-5-3-4 4z" fill={hair} />
      </g>
      <path d="M28 21h2v3h-2zM35 21h2v3h-2z" fill="var(--ink)" />
    </svg>
  );
}

export function AccountSheet(props: AccountSheetProps) {
  const { open, onClose, account, online } = props;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const uid = useId();
  const [joining, setJoining] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const close = () => dialogRef.current?.close();

  // The native dialog traps focus and closes on Escape; a click on the backdrop closes it too.
  // With a keyboard, the name is where typing starts, as the menu's search is.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      if (globalThis.matchMedia?.('(pointer: fine)').matches) nameRef.current?.focus();
    } else if (!open && dialog.open) dialog.close();
  }, [open]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    let pressedBackdrop = false;
    const onPointerDown = (event: PointerEvent) => (pressedBackdrop = event.target === dialog);
    const onClick = (event: MouseEvent) => {
      if (event.target === dialog && pressedBackdrop) dialog.close();
    };
    // Closed, it forgets what went wrong: the next opening starts clean.
    const closed = () => {
      setError(null);
      onClose();
    };
    dialog.addEventListener('pointerdown', onPointerDown);
    dialog.addEventListener('click', onClick);
    dialog.addEventListener('close', closed);
    return () => {
      dialog.removeEventListener('pointerdown', onPointerDown);
      dialog.removeEventListener('click', onClick);
      dialog.removeEventListener('close', closed);
    };
  }, [onClose]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const [name, password] = [
      String(form.get('name') ?? '').trim(),
      String(form.get('password') ?? ''),
    ];
    setBusy(true);
    setError(null);
    try {
      await (joining ? props.signUp(name, password) : props.signIn(name, password));
      // The form went with it: focus to the sheet's new title, which says who you are now.
      titleRef.current?.focus({ focusVisible: true } as FocusOptions);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    setBusy(true);
    try {
      await props.signOut();
      // Nothing left to do here: back to the map, as a guest (the app says so).
      close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  // Everyone else: the count includes you, guest or not.
  const others = online === null ? null : online - 1;
  const here =
    others === null
      ? 'Offline: others can’t see you right now.'
      : others <= 0
        ? 'Nobody else is in Leuven right now.'
        : others === 1
          ? 'One other person is in Leuven right now.'
          : `${others} others are in Leuven right now.`;

  return (
    <dialog ref={dialogRef} className="menu account" aria-labelledby={`${uid}-title`}>
      <div className="menu-panel">
        <header className="menu-head">
          <h2 ref={titleRef} id={`${uid}-title`} className="menu-title" tabIndex={-1}>
            {account.signedIn ? account.name : joining ? 'Join Leuven' : 'Welcome back'}
          </h2>
          <button type="button" className="menu-close" aria-label="Close" onClick={close}>
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
            <kbd aria-hidden="true">Esc</kbd>
          </button>
        </header>
        <div className="menu-body account-body">
          {account.signedIn ? (
            <>
              <div className="account-you">
                <Preview outfit={account.outfit} />
                <p className="menu-lede">
                  This is you on the map. Pick your colours: everyone sees them at once. {here}
                </p>
              </div>
              {PARTS.map(({ part, label, swatches }) => (
                <fieldset key={part} className="swatches">
                  <legend>{label}</legend>
                  <div className="swatch-row">
                    {swatches.map(({ colour, name }) => (
                      <label
                        key={colour}
                        className="swatch"
                        style={{ '--swatch': css(colour) } as CSSProperties}
                      >
                        <input
                          type="radio"
                          name={`${uid}-${part}`}
                          value={colour}
                          checked={account.outfit[part] === colour}
                          onChange={() => props.dress({ ...account.outfit, [part]: colour })}
                        />
                        <span className="sr-only">{name}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
              <div className="account-actions">
                <button
                  type="button"
                  className="action"
                  onClick={() => props.dress(surprise(Math.random, account.outfit))}
                >
                  Surprise me
                </button>
                <button
                  type="button"
                  className="action"
                  disabled={busy}
                  onClick={() => void leave()}
                >
                  Sign out
                </button>
              </div>
              {error && (
                <p className="account-error" role="alert">
                  {error}
                </p>
              )}
            </>
          ) : (
            <form className="account-form" onSubmit={(event) => void submit(event)}>
              <p className="menu-lede">
                {account.name && (
                  <>
                    {account.unseen ? 'For now you’d be ' : 'For now you’re '}
                    <strong>{account.name}</strong>
                    {account.unseen
                      ? ', but so many guests have come from your connection that others can’t see you. '
                      : ', and everyone can see you. '}
                  </>
                )}
                {joining
                  ? 'Pick a name and a password to keep one of your own, in your own colours. You’ll carry on from here, and come back where you left off.'
                  : 'Your name and password, and you’ll carry on from here under your own name.'}{' '}
                {here}
              </p>
              <label className="field">
                <span>Name</span>
                <input
                  ref={nameRef}
                  name="name"
                  required
                  minLength={3}
                  maxLength={20}
                  pattern="[A-Za-z0-9_.\-]+"
                  title="3 to 20 letters, digits, dots, dashes or underscores"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="next"
                />
                <small>3 to 20 letters, digits, dots, dashes or underscores; no spaces.</small>
              </label>
              <label className="field">
                <span>Password</span>
                <input
                  name="password"
                  type="password"
                  required
                  minLength={joining ? 8 : 1}
                  maxLength={128}
                  autoComplete={joining ? 'new-password' : 'current-password'}
                  enterKeyHint="go"
                />
                {joining && <small>At least 8 characters.</small>}
              </label>
              {error && (
                <p className="account-error" role="alert">
                  {error}
                </p>
              )}
              <button type="submit" className="action primary" disabled={busy}>
                {busy ? (joining ? 'Joining…' : 'Signing in…') : joining ? 'Join' : 'Sign in'}
              </button>
              <button
                type="button"
                className="account-switch"
                onClick={() => {
                  setJoining((j) => !j);
                  setError(null);
                }}
              >
                {joining ? 'Already have a name? Sign in' : 'New here? Pick a name'}
              </button>
            </form>
          )}
        </div>
      </div>
    </dialog>
  );
}
