/**
 * When the browser sends its own state. The avatar changes every frame, but the server ticks
 * at 10 Hz, so sending more often only costs bandwidth; a change others would notice at once
 * (getting on a bike, a door, a jump across the map) goes out straight away instead of up to a
 * tick late; and an idle player still says so every few seconds, so the server and the proxies
 * in between know the connection is alive.
 */

import type { PlayerState } from './protocol.ts';

/** The shortest gap between two ordinary sends (ms): 10 Hz. */
export const SEND_INTERVAL = 100;
/** How often an unchanged state is sent again (ms). */
export const HEARTBEAT = 3000;
/** A move further than this (m) since the last send is a jump, sent at once. */
const JUMP = 4;

export interface Sent {
  state: PlayerState;
  /** When it was sent (ms). */
  at: number;
}

/** Smaller differences than these are rounding, not movement. */
const SAME_POSITION = 0.01;
const SAME_HEADING = 0.005;
const SAME_SPEED = 0.05;

/** Whether others would see a figure in a different place, room or way of moving. */
export function bigChange(a: PlayerState, b: PlayerState): boolean {
  return (
    a.mode !== b.mode ||
    a.place !== b.place ||
    a.floor !== b.floor ||
    Math.hypot(b.x - a.x, b.z - a.z) > JUMP
  );
}

/** Whether two states would look the same on someone else's screen. */
export function sameState(a: PlayerState, b: PlayerState): boolean {
  return (
    !bigChange(a, b) &&
    Math.abs(b.x - a.x) < SAME_POSITION &&
    Math.abs(b.z - a.z) < SAME_POSITION &&
    Math.abs(b.heading - a.heading) < SAME_HEADING &&
    Math.abs(b.speed - a.speed) < SAME_SPEED
  );
}

/**
 * How long to wait (ms) before sending `latest`, given what was sent last: 0 means now. Ask
 * again after that long, with whatever is latest by then.
 */
export function sendDelay(sent: Sent | null, latest: PlayerState, now: number): number {
  if (!sent || bigChange(sent.state, latest)) return 0;
  const gap = sameState(sent.state, latest) ? HEARTBEAT : SEND_INTERVAL;
  return Math.max(0, sent.at + gap - now);
}
