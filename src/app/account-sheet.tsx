import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, RefObject } from 'react';

import {
  CODE_COOLDOWN_SECONDS,
  CODE_LENGTH,
  CODE_MINUTES,
  MAX_EMAIL,
  MAX_NAME,
  MIN_NAME,
  isUsername,
} from '../net/rules.ts';
import type { Outfit } from '../scene/viewer.ts';
import { css } from './colours.ts';
import { PARTS, surprise } from './outfits.ts';
import './account-sheet.css';

/**
 * Who you are on the map, in a sheet like the menu's. A guest: who you are for now, and one flow
 * to join or come back: an email, then the code it was sent, then, only for a new account, a name.
 * Signed in: your name and your look, chosen from a few colours a part and worn at once, and a way
 * out. Its own chunk, fetched when it is first opened. It stays mounted once opened, so a code
 * asked for a moment ago is still waiting when the sheet is opened again.
 */

/** Who you are on the map: signed in, or a guest with the name and look the server gave them. */
export type Account =
  | { signedIn: false; name?: string; outfit?: Outfit; unseen?: boolean; mailOff?: boolean }
  | { signedIn: true; name: string; outfit: Outfit; fresh?: boolean };

export interface AccountSheetProps {
  open: boolean;
  onClose(): void;
  account: Account;
  /** How many are on the map now, you included; null while not connected. */
  online: number | null;
  /** Each settles once done, or fails with a message written for the person. */
  sendCode(email: string): Promise<void>;
  verifyCode(email: string, code: string): Promise<void>;
  rename(name: string): Promise<void>;
  /** Whether a name is free; null when that can't be told. */
  nameFree(name: string): Promise<boolean | null>;
  signOut(): Promise<void>;
  /** Wears a look now; it is saved a moment later. */
  dress(outfit: Outfit): void;
}

const messageOf = (failure: unknown) =>
  failure instanceof Error ? failure.message : 'That didn’t work. Try again.';

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

/** What went wrong, said at once to a screen reader; nothing while all is well. */
const Problem = ({ text }: { text: string | null }) =>
  text && (
    <p className="account-error" role="alert">
      {text}
    </p>
  );

const nameRules = `${MIN_NAME} to ${MAX_NAME} letters, digits, dots, dashes or underscores.`;

interface NameFormProps {
  /** The name on the account now, which the field starts with. */
  current: string;
  /** A new account: the name is a suggestion and keeping it counts as choosing. */
  fresh: boolean;
  fieldRef?: RefObject<HTMLInputElement | null>;
  save(name: string): Promise<void>;
  nameFree(name: string): Promise<boolean | null>;
  /** Saved: where focus and the news go next. */
  onSaved?(): void;
}

/** A name to keep or change, said to be free or taken while it is typed. */
function NameForm({ current, fresh, fieldRef, save, nameFree, onSaved }: NameFormProps) {
  const uid = useId();
  const [name, setName] = useState(current);
  const [free, setFree] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The check under way, and what was last typed: only its answer counts. */
  const checking = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef(current);
  const same = name.toLowerCase() === current.toLowerCase();

  function typed(next: string) {
    setName(next);
    setFree(null);
    setError(null);
    latest.current = next;
    clearTimeout(checking.current);
    if (!isUsername(next) || next.toLowerCase() === current.toLowerCase()) return;
    checking.current = setTimeout(() => {
      void nameFree(next).then((answer) => {
        if (latest.current === next) setFree(answer);
      });
    }, 250);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await save(name.trim());
      onSaved?.();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }

  const hint =
    free === false ? 'That name is taken.' : free === true ? 'That name is free.' : nameRules;
  return (
    <form className="account-form" onSubmit={(event) => void submit(event)}>
      <div className="field">
        <label htmlFor={`${uid}-name`}>{fresh ? 'Your name' : 'Name'}</label>
        <div className="name-row">
          <input
            ref={fieldRef}
            id={`${uid}-name`}
            name="username"
            required
            minLength={MIN_NAME}
            maxLength={MAX_NAME}
            pattern="[A-Za-z0-9_.\-]+"
            title={nameRules}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            aria-describedby={`${uid}-hint`}
            aria-invalid={free === false}
            value={name}
            onChange={(event) => typed(event.target.value)}
          />
          {!fresh && (
            <button type="submit" className="action" disabled={busy || same}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
        <small id={`${uid}-hint`} aria-live="polite">
          {hint}
        </small>
      </div>
      <Problem text={error} />
      {fresh && (
        <button type="submit" className="action primary" disabled={busy || free === false}>
          {busy ? 'Saving…' : 'Use this name'}
        </button>
      )}
    </form>
  );
}

export function AccountSheet(props: AccountSheetProps) {
  const { open, onClose, account, online } = props;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const uid = useId();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Said to a screen reader as each step arrives. */
  const [news, setNews] = useState('');
  /** Seconds until another code may go out, counted down from when that is (ms). */
  const [left, setLeft] = useState(0);
  const waitUntil = useRef(0);
  /** Takes the code's step away once the code has run out. */
  const runningOut = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Who this sheet last saw: signed in or out by another tab, a code in progress is moot. */
  const [wasSignedIn, setWasSignedIn] = useState(account.signedIn);
  if (wasSignedIn !== account.signedIn) {
    setWasSignedIn(account.signedIn);
    setStep('email');
    setCode('');
    setNews('');
  }
  /** A code tried already isn't sent again by itself; retyping it is on purpose. */
  const lastTried = useRef('');
  /** The next render should move focus: to the field of the new step, or the title. */
  const focusNext = useRef(false);
  const fieldRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const close = () => dialogRef.current?.close();

  // The native dialog traps focus and closes on Escape; a click on the backdrop closes it too.
  // With a keyboard, the field is where typing starts, as the menu's search is.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      if (globalThis.matchMedia?.('(pointer: fine)').matches) fieldRef.current?.focus();
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
  // After each step: into its field, or to the title once there's no field left to type in.
  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    if (fieldRef.current) {
      fieldRef.current.focus();
      fieldRef.current.select();
    } else titleRef.current?.focus();
  });
  // The wait before another code, in seconds, while it can be seen.
  useEffect(() => {
    if (!open || step !== 'code') return;
    // Reopened mid-wait, the count is right at once, not a second later.
    const tick = () => setLeft(Math.max(0, Math.ceil((waitUntil.current - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [open, step]);

  async function send(address: string) {
    setBusy(true);
    setError(null);
    try {
      await props.sendCode(address);
      waiting(address, CODE_COOLDOWN_SECONDS);
    } catch (failure) {
      const { code: why, retryAfter = 0 } = failure as { code?: string; retryAfter?: number };
      // One went out a moment ago and is still good: on to where it can be typed.
      if (why === 'sent') waiting(address, retryAfter);
      else setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }

  /** A code is on its way to `address`: the step to type it, and the wait for another. */
  function waiting(address: string, seconds: number) {
    setEmail(address);
    waitUntil.current = Date.now() + seconds * 1000;
    setLeft(seconds);
    setStep('code');
    setCode('');
    lastTried.current = '';
    setNews(`We sent a code to ${address}.`);
    focusNext.current = true;
    // Run out, it starts over with the address still there, whether the sheet is open or not.
    clearTimeout(runningOut.current);
    runningOut.current = setTimeout(() => {
      setStep('email');
      setCode('');
      setError('That code has expired. Send a new one.');
    }, CODE_MINUTES * 60_000);
  }

  async function verify(digits: string) {
    if (digits.length !== CODE_LENGTH || busy) return;
    lastTried.current = digits;
    setBusy(true);
    setError(null);
    try {
      await props.verifyCode(email, digits);
      clearTimeout(runningOut.current);
      focusNext.current = true;
    } catch (failure) {
      setError(messageOf(failure));
      fieldRef.current?.select();
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
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }

  const fresh = account.signedIn && account.fresh;
  const title = account.signedIn
    ? fresh
      ? 'Pick your name'
      : account.name
    : account.mailOff
      ? (account.name ?? 'Join Leuven')
      : step === 'code'
        ? 'Check your email'
        : 'Join Leuven';

  return (
    <dialog ref={dialogRef} className="menu account" aria-labelledby={`${uid}-title`}>
      <div className="menu-panel">
        <header className="menu-head">
          <h2 ref={titleRef} id={`${uid}-title`} className="menu-title" tabIndex={-1}>
            {title}
          </h2>
          <button type="button" className="menu-close" aria-label="Close" onClick={close}>
            {/* Inline, not menu-icons': sharing that chunk moves React's runtime into the shell. */}
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
          <output className="sr-only">{news}</output>
          {account.signedIn && fresh && (
            <>
              <p className="menu-lede">
                This is the name everyone sees over your head. Keep it, or pick another that’s yours
                alone.
              </p>
              <NameForm
                key={account.name}
                current={account.name}
                fresh
                fieldRef={fieldRef}
                save={props.rename}
                nameFree={props.nameFree}
                onSaved={() => (focusNext.current = true)}
              />
            </>
          )}
          {account.signedIn && !fresh && (
            <>
              <div className="account-you">
                <Preview outfit={account.outfit} />
                <p className="menu-lede">
                  This is you on the map. Pick your colours: everyone sees them at once.
                  {online === null && ' You’re offline: nobody else can see you right now.'}
                </p>
              </div>
              <NameForm
                key={account.name}
                current={account.name}
                fresh={false}
                save={props.rename}
                nameFree={props.nameFree}
              />
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
              <Problem text={error} />
            </>
          )}
          {!account.signedIn && account.mailOff && (
            <p className="menu-lede">
              Joining isn’t switched on yet. Keep exploring
              {account.name && (
                <>
                  {' '}
                  as <strong>{account.name}</strong>
                </>
              )}
              .
            </p>
          )}
          {!account.signedIn && !account.mailOff && step === 'email' && (
            <form
              className="account-form"
              onSubmit={(event) => {
                event.preventDefault();
                void send(email.trim());
              }}
            >
              <p className="menu-lede">
                {account.name && (
                  <>
                    {account.unseen ? 'For now you’d be ' : 'For now you’re '}
                    <strong>{account.name}</strong>
                    {account.unseen
                      ? ', but too many people on your connection are on the map for others to see you. '
                      : '. '}
                  </>
                )}
                Use your email to keep a name and colours of your own, or to come back to them.
                We’ll send a code; no password.
              </p>
              <label className="field">
                <span>Email</span>
                <input
                  ref={fieldRef}
                  name="email"
                  type="email"
                  required
                  maxLength={MAX_EMAIL}
                  autoComplete="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  inputMode="email"
                  enterKeyHint="send"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <Problem text={error} />
              <button type="submit" className="action primary" disabled={busy}>
                {busy ? 'Sending…' : 'Send code'}
              </button>
            </form>
          )}
          {!account.signedIn && !account.mailOff && step === 'code' && (
            <form
              className="account-form"
              onSubmit={(event) => {
                event.preventDefault();
                void verify(code);
              }}
            >
              <p className="menu-lede">
                We sent a six-digit code to <strong>{email}</strong>. It works for {CODE_MINUTES}{' '}
                minutes.
              </p>
              <label className="field">
                <span>Code</span>
                <input
                  ref={fieldRef}
                  className="code-field"
                  name="code"
                  required
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  enterKeyHint="go"
                  value={code}
                  onChange={(event) => {
                    // Not `maxLength`: a pasted "123 456" must arrive whole to be cleaned up.
                    const digits = event.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH);
                    setCode(digits);
                    setError(null);
                    if (digits.length === CODE_LENGTH && digits !== lastTried.current) {
                      void verify(digits);
                    }
                  }}
                />
              </label>
              <Problem text={error} />
              <button type="submit" className="action primary" disabled={busy}>
                {busy ? 'Checking…' : 'Continue'}
              </button>
              <div className="account-links">
                <button
                  type="button"
                  className="account-switch"
                  disabled={busy || left > 0}
                  onClick={() => void send(email)}
                >
                  {left > 0 ? `Send a new code in ${left} s` : 'Send a new code'}
                </button>
                <button
                  type="button"
                  className="account-switch"
                  onClick={() => {
                    clearTimeout(runningOut.current);
                    setStep('email');
                    setError(null);
                    setNews('');
                    focusNext.current = true;
                  }}
                >
                  Use a different email
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </dialog>
  );
}
