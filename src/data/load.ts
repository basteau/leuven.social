import type { City } from './city.ts';
import { unpackCity } from './format.ts';

export const CITY_URL = `${import.meta.env.BASE_URL}data/city.bin`;

export class CityLoadError extends Error {
  override name = 'CityLoadError';
}

export async function loadCity(url: string, signal?: AbortSignal): Promise<City> {
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok)
    throw new CityLoadError(`The city data failed to load (HTTP ${response.status}).`);
  return unpackCity(new Uint8Array(await response.arrayBuffer()), signal);
}
