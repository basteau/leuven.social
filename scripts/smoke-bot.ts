/**
 * Another player for the smoke test: an account made over HTTP and a presence socket that walks a
 * slow circle round a spot and writes down what it hears. It is first on the map at its address, so
 * its tab drives the figure without needing to say so. Headless browsers side by side don't
 * animate (their pages count as hidden), so the second player is this script, speaking the same
 * protocol the page does (src/net/protocol.ts).
 */

import { decodeServerMessage, encodeClientMessage } from '../src/net/protocol.ts';
import type { Outfit, ServerMessage } from '../src/net/protocol.ts';

export interface Bot {
  /** Everything the server said to it, oldest first. */
  heard: ServerMessage[];
  /** The players it saw join or become someone, by name, as they now are. */
  joined(): string[];
  /** The id of the player called `name`, if it has heard of one. */
  idOf(name: string): number | undefined;
  /** The name of figure `id`, as it was last heard. */
  nameOf(id: number): string | undefined;
  /** The latest outfit it heard for the player called `name`, if any. */
  outfitOf(name: string): Outfit | null;
  close(): void;
}

/** Signs up as `name` on the server at `api` (as the page at `origin` would) and walks round (x, z). */
export async function startBot(
  api: string,
  origin: string,
  name: string,
  [x, z]: [number, number],
): Promise<Bot> {
  const headers = { 'content-type': 'application/json', origin };
  const response = await fetch(`${api}/api/account`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: name, password: 'smoke-test-password' }),
  });
  if (!response.ok) throw new Error(`the bot couldn't sign up: ${response.status}`);
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const socket = new WebSocket(`${api.replace(/^http/, 'ws')}/ws`, {
    headers: { cookie, origin },
  } as unknown as string[]);
  socket.binaryType = 'arraybuffer';
  const heard: ServerMessage[] = [];
  socket.addEventListener('message', (event) => {
    const message = decodeServerMessage(new Uint8Array(event.data as ArrayBuffer));
    if (message) heard.push(message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('the bot’s socket failed')), {
      once: true,
    });
  });
  const start = performance.now();
  const walk = setInterval(() => {
    const a = ((performance.now() - start) / 1000) * 0.5;
    const state = {
      x: x + Math.cos(a) * 5,
      z: z + Math.sin(a) * 5,
      heading: Math.atan2(-Math.sin(a), Math.cos(a)),
      speed: 2.5,
      mode: 'foot' as const,
      place: '',
      floor: 0,
    };
    socket.send(encodeClientMessage({ type: 'state', state }));
  }, 100);
  const ids = new Map<number, string>();
  const joined = () => {
    for (const m of heard) {
      if (m.type === 'joins') for (const p of m.players) ids.set(p.id, p.name);
      if (m.type === 'renamed') ids.set(m.id, m.name);
    }
    return [...ids.values()];
  };
  return {
    heard,
    joined,
    idOf(wanted) {
      joined();
      return [...ids].find(([, n]) => n === wanted)?.[0];
    },
    nameOf(id) {
      joined();
      return ids.get(id);
    },
    outfitOf(who) {
      joined();
      let outfit: Outfit | null = null;
      for (const m of heard) {
        if (m.type === 'joins') {
          for (const p of m.players) if (p.name === who) outfit = p.outfit;
        }
        if (m.type === 'outfit' && ids.get(m.id) === who) outfit = m.outfit;
        if (m.type === 'renamed' && m.name === who) outfit = m.outfit;
      }
      return outfit;
    },
    close() {
      clearInterval(walk);
      socket.close();
    },
  };
}
