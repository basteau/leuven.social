import type { City } from './city.ts';
import { unpackCity } from './format.ts';

export const CITY_URL = `${import.meta.env.BASE_URL}data/city.bin`;

export class CityLoadError extends Error {
  override name = 'CityLoadError';
}

/** Bytes received so far, and in all; `total` is 0 until known. */
export type LoadProgress = (received: number, total: number) => void;

/**
 * Reads the body as it arrives, saying how much has. The size comes from Content-Length, unless
 * the server compressed the file on the way (the length is then the compressed one): the total
 * is then known only at the end.
 */
async function readCounting(response: Response, onProgress: LoadProgress): Promise<Uint8Array> {
  const encoded = response.headers.has('content-encoding');
  const total = encoded ? 0 : Number(response.headers.get('content-length')) || 0;
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  onProgress(0, total);
  // Each read waits on the network for the next piece: one at a time, by nature.
  const pump = async (): Promise<void> => {
    const read = await reader.read();
    if (read.done) return;
    chunks.push(read.value);
    received += read.value.length;
    onProgress(received, total);
    return pump();
  };
  await pump();
  if (received !== total) onProgress(received, received);
  const bytes = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

export async function loadCity(
  url: string,
  signal?: AbortSignal,
  onProgress?: LoadProgress,
): Promise<City> {
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok)
    throw new CityLoadError(`The city data failed to load (HTTP ${response.status}).`);
  const bytes =
    onProgress && response.body
      ? await readCounting(response, onProgress)
      : new Uint8Array(await response.arrayBuffer());
  return unpackCity(bytes, signal);
}
