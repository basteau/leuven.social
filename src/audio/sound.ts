/**
 * A few quiet, warm sounds, synthesised with Web Audio rather than downloaded, so there is
 * nothing to fetch. One context, made on the first gesture after sound is on (browsers allow
 * audio only after one) and suspended while sound is off or the tab is hidden. Every voice is
 * filtered, rises over a few milliseconds and falls exponentially, so nothing clicks; callers
 * vary its pitch a little, so repeats don't sound mechanical.
 */

/** The loudest voice peaks around a sixteenth of full scale: felt more than heard. */
export const MASTER = 0.4;
const KEY = 'leuven.sound';
/** Exponential ramps can't reach zero; this is silence to the ear. */
const SILENT = 1e-4;
/** A rise any shorter clicks. */
const MIN_ATTACK = 0.003;
/** Seconds of white noise, enough for the longest scuff from any offset. */
const NOISE_SECONDS = 0.5;

/** One sound: a waveform or noise through a filter, with a quick rise and an exponential fall. */
export interface Voice {
  /** A waveform for tones; noise for scuffs and knocks. */
  wave: 'sine' | 'triangle' | 'noise';
  /** Hz, or a glide from the first to the second; for noise, the centre of its band. */
  pitch: number | readonly [number, number];
  /** Peak level before the master. */
  gain: number;
  /** Seconds to fall to silence. */
  decay: number;
  /** Seconds to rise. */
  attack?: number;
  /** A tone's lowpass cutoff (Hz): the lower, the more felt than wood. */
  cutoff?: number;
  /** Resonance of the band (noise) or the cutoff (tones). */
  q?: number;
  /** Seconds from now. */
  delay?: number;
}

/** What the sounds need from storage, a context and the page; tests hand in fakes. */
export interface SoundEnv {
  context: () => AudioContext;
  storage: () => Pick<Storage, 'getItem' | 'setItem'> | undefined;
}

export interface Sound {
  /** Whether sound is on: people's own choice, remembered between visits. */
  readonly on: boolean;
  setOn(on: boolean): void;
  /**
   * Listens for gestures on `target` and for `page` hiding. A gesture makes or resumes the
   * context. Returns a function that stops listening.
   */
  attach(target?: EventTarget, page?: EventTarget & { readonly hidden: boolean }): () => void;
  /** Plays voices now, if sound is on, a gesture has unlocked it and the tab is visible. */
  play(voices: readonly Voice[]): void;
  /** A HUD button. */
  tap(): void;
  /** A toggle turning on or off. */
  toggle(on: boolean): void;
}

/** `value` nudged up or down by up to `spread` of itself. */
export const vary = (value: number, spread: number, random = Math.random) =>
  value * (1 + spread * (random() * 2 - 1));

/** A soft wooden knock: a stick of noise over a short, falling, felted tone. */
const knock = (): Voice[] => [
  { wave: 'triangle', pitch: [vary(820, 0.04), 560], gain: 0.15, decay: 0.05, cutoff: 2200 },
  { wave: 'noise', pitch: vary(2800, 0.1), gain: 0.04, decay: 0.012, q: 1.5 },
];

/** Two notes a fifth apart: rising turns on, falling turns off. */
const fifth = (on: boolean): Voice[] => {
  const [first, second] = on ? [587, 880] : [880, 587];
  const note = { wave: 'triangle', decay: 0.08, cutoff: 2400 } as const;
  return [
    { ...note, pitch: first, gain: 0.12 },
    { ...note, pitch: second, gain: 0.1, delay: 0.05 },
  ];
};

/** A context that won't resume or suspend (closed by the browser) just stays silent. */
const ignore = () => {};

const browserEnv: SoundEnv = {
  context: () => new AudioContext(),
  // Reading it can throw where storage is blocked: callers catch that.
  storage: () => globalThis.localStorage,
};

export function createSound(env: SoundEnv = browserEnv): Sound {
  let on = true;
  try {
    on = env.storage()?.getItem(KEY) !== 'off';
  } catch {} // storage blocked: sound still works, the choice just isn't remembered
  let hidden = false;
  let ctx: AudioContext | undefined;
  let master: GainNode | undefined;
  let noise: AudioBuffer | undefined;

  /** In a gesture, or once the page has had one: makes the context or wakes it. */
  function wake(): void {
    if (!on || hidden) return;
    if (!ctx) {
      ctx = env.context();
      master = ctx.createGain();
      master.gain.value = MASTER;
      master.connect(ctx.destination);
      noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * NOISE_SECONDS), ctx.sampleRate);
      const samples = noise.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume().catch(ignore);
  }

  function sleep(): void {
    if (ctx?.state === 'running') ctx.suspend().catch(ignore);
  }

  function voice(context: AudioContext, out: AudioNode, v: Voice): void {
    const start = context.currentTime + (v.delay ?? 0);
    const peak = start + Math.max(MIN_ATTACK, v.attack ?? 0);
    const end = peak + v.decay;
    const [from, to] = typeof v.pitch === 'number' ? [v.pitch, v.pitch] : v.pitch;
    const filter = context.createBiquadFilter();
    let source: AudioScheduledSourceNode;
    let pitch: AudioParam;
    if (v.wave === 'noise') {
      const buffer = context.createBufferSource();
      buffer.buffer = noise!;
      filter.type = 'bandpass';
      filter.Q.value = v.q ?? 1;
      // Each scuff starts somewhere else in the noise, so no two have the same grain.
      buffer.start(start, Math.random() * Math.max(0, NOISE_SECONDS - v.decay - 0.05));
      [source, pitch] = [buffer, filter.frequency];
    } else {
      const osc = context.createOscillator();
      osc.type = v.wave;
      filter.type = 'lowpass';
      filter.frequency.value = v.cutoff ?? 2500;
      filter.Q.value = v.q ?? 0.7;
      osc.start(start);
      [source, pitch] = [osc, osc.frequency];
    }
    pitch.setValueAtTime(from, start);
    if (to !== from) pitch.exponentialRampToValueAtTime(to, end);
    const level = context.createGain();
    level.gain.setValueAtTime(SILENT, start);
    level.gain.linearRampToValueAtTime(v.gain, peak);
    level.gain.exponentialRampToValueAtTime(SILENT, end);
    source.connect(filter).connect(level).connect(out);
    source.addEventListener(
      'ended',
      () => {
        source.disconnect();
        filter.disconnect();
        level.disconnect();
      },
      { once: true },
    );
    source.stop(end + 0.02);
  }

  const sound: Sound = {
    get on() {
      return on;
    },
    setOn(next) {
      on = next;
      try {
        env.storage()?.setItem(KEY, next ? 'on' : 'off');
      } catch {}
      if (next) wake();
      else sleep();
    },
    attach(target = globalThis, page = document) {
      hidden = page.hidden;
      const onVisibility = () => {
        hidden = page.hidden;
        if (hidden) sleep();
        // Waking without a gesture is allowed once there has been one, and only then is there a context.
        else if (ctx) wake();
      };
      const gestures = ['pointerdown', 'keydown', 'touchend'] as const;
      for (const type of gestures) target.addEventListener(type, wake, { capture: true });
      page.addEventListener('visibilitychange', onVisibility);
      return () => {
        for (const type of gestures) target.removeEventListener(type, wake, { capture: true });
        page.removeEventListener('visibilitychange', onVisibility);
      };
    },
    play(voices) {
      if (!ctx || !master || !on || hidden) return;
      for (const v of voices) voice(ctx, master, v);
    },
    tap() {
      sound.play(knock());
    },
    toggle(next) {
      sound.play(fifth(next));
    },
  };
  return sound;
}

/** The page's one sound engine, shared by the HUD and walk mode. */
export const sound = createSound();
