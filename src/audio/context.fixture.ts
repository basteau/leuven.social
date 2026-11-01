/**
 * Just enough of an AudioContext to hear what the sounds would play: every node, every
 * parameter change and every start and stop is recorded. For tests only.
 */

export interface FakeParam {
  value: number;
  events: [string, number, number][];
}

const param = (value = 0): FakeParam & Record<string, unknown> => {
  const p: FakeParam & Record<string, unknown> = { value, events: [] };
  for (const name of [
    'setValueAtTime',
    'linearRampToValueAtTime',
    'exponentialRampToValueAtTime',
  ]) {
    p[name] = (v: number, t: number) => {
      p.events.push([name, v, t]);
      return p;
    };
  }
  return p;
};

export interface FakeNode {
  kind: string;
  type?: string;
  connected: unknown[];
  disconnected: boolean;
  started?: number[];
  stopped?: number;
  /** Fires the node's `ended` listener, as the context would when it stops. */
  ended?: () => void;
  gain?: FakeParam;
  frequency?: FakeParam;
  Q?: FakeParam;
}

/** `broken` makes resume and suspend fail, as on a context the browser has closed. */
export function fakeContext(state: AudioContextState = 'running', broken = false) {
  const nodes: FakeNode[] = [];
  const node = (kind: string, params: Record<string, FakeParam> = {}) => {
    const n: FakeNode & Record<string, unknown> = {
      kind,
      connected: [],
      disconnected: false,
      ...params,
      connect(to: unknown) {
        n.connected.push(to);
        return to;
      },
      disconnect() {
        n.disconnected = true;
      },
      start(...at: number[]) {
        n.started = at;
      },
      stop(at: number) {
        n.stopped = at;
      },
      addEventListener(_type: 'ended', listener: () => void) {
        n.ended = listener;
      },
    };
    nodes.push(n);
    return n;
  };
  const ctx = {
    state,
    currentTime: 10,
    sampleRate: 1000,
    destination: { kind: 'destination' },
    calls: [] as string[],
    nodes,
    createGain: () => node('gain', { gain: param(1) }),
    createOscillator: () => node('osc', { frequency: param(440) }),
    createBiquadFilter: () => node('filter', { frequency: param(350), Q: param(1) }),
    createBufferSource: () => node('buffer'),
    createBuffer: (_channels: number, length: number) => {
      const data = new Float32Array(length);
      return { length, getChannelData: () => data };
    },
    resume() {
      ctx.calls.push('resume');
      if (broken) return Promise.reject(new Error('closed'));
      ctx.state = 'running';
      return Promise.resolve();
    },
    suspend() {
      ctx.calls.push('suspend');
      if (broken) return Promise.reject(new Error('closed'));
      ctx.state = 'suspended';
      return Promise.resolve();
    },
  };
  return ctx;
}

export type FakeContext = ReturnType<typeof fakeContext>;
