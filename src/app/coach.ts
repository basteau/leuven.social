/**
 * The first minute: one line at a time, each until the thing it teaches has been done. Far out,
 * come down to the street; there, take a step; then, for a moment, look around and find the map.
 * Pure, so the shell only says what step it's at.
 */

export type CoachStep = 'zoom' | 'walk' | 'look';

export interface CoachState {
  /** Coached before, on this device, or done just now: nothing to say. */
  done: boolean;
  /** The view has come close enough to show the figure. */
  street: boolean;
  /** A first step has been taken, or a first route walked. */
  stepped: boolean;
  /** That step was a few seconds ago: time to move on to the next thing. */
  settled: boolean;
}

export function coachStep(state: CoachState): CoachStep | null {
  if (state.done) return null;
  if (state.settled) return 'look';
  return state.street || state.stepped ? 'walk' : 'zoom';
}
