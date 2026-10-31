import { expect, test } from 'bun:test';

import { unpackCity } from '../data/format.ts';
import { orientedRect } from '../data/geometry.ts';
import { LANDMARK_MODELS } from './landmark-models.ts';

// The models are fitted to footprints in the committed city file. A rebake that drops or
// reshapes one of them must fail here rather than leave a tower floating off its building.
test('every landmark model sits on a hero building in public/data/city.bin', async () => {
  const response = await fetch(new URL('../../public/data/city.bin', import.meta.url));
  const city = await unpackCity(new Uint8Array(await response.arrayBuffer()));
  for (const [id, model] of LANDMARK_MODELS) {
    const building = city.buildings.find((b) => b.id === id);
    expect(building?.tier).toBe('hero');
    const rect = orientedRect(building!.ring);
    expect(model.base).toBeLessThan(building!.height);
    for (const part of model.parts) {
      expect(Math.abs(part.u)).toBeLessThan(rect.halfLength + 1);
      expect(Math.abs(part.v)).toBeLessThan(rect.halfWidth + 1);
      expect(part.type === 'hall' ? (part.ridge ?? part.eave) : part.tip).toBeLessThanOrEqual(90);
    }
  }
});
