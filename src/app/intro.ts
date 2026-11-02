/**
 * The loading screen is plain HTML and CSS in index.html, so it paints before any script. This
 * is all the app does to it: report each step, fill in the keys this keyboard types, and take it
 * away once the map is drawn (the fade is CSS, keyed to `data-state` on <html>).
 */

import type { Keycaps } from './input.ts';
import type { LoadStep } from './loading.ts';

const byId = (id: string) => document.getElementById(id);

export function showStep({ step, detail, fraction }: LoadStep): void {
  const intro = byId('intro');
  if (!intro) return;
  intro.style.setProperty('--progress', fraction.toFixed(3));
  byId('intro-bar')?.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  const stepLine = byId('intro-step');
  // Only a new step is announced, not every kilobyte.
  if (stepLine && stepLine.textContent !== step) stepLine.textContent = step;
  const detailLine = byId('intro-detail');
  if (detailLine) detailLine.textContent = detail;
}

/** The intro's keycaps as this keyboard types them (Z Q S D on AZERTY), and the menu's chord. */
export function showKeys(keys: Keycaps, mod: string): void {
  for (const kbd of document.querySelectorAll<HTMLElement>('#intro kbd[data-code]')) {
    kbd.textContent = keys[kbd.dataset.code as keyof Keycaps] ?? kbd.textContent;
  }
  for (const kbd of document.querySelectorAll<HTMLElement>('#intro kbd[data-mod]')) {
    kbd.textContent = mod;
  }
}

/** How long the reveal takes in CSS, and a little more: then the intro leaves the page. */
const REVEAL_MS = 700;

/** Once the first frame is drawn: CSS fades the intro off the map, then it goes. */
export function removeIntro(): () => void {
  const timer = setTimeout(() => byId('intro')?.remove(), REVEAL_MS);
  return () => clearTimeout(timer);
}

/** Where the loading screen shows an error and its way out, if it's still there. */
export const introErrorSlot = () => byId('intro-error');
