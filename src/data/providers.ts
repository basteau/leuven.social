/**
 * Who the city's data comes from, under which licence, and the credit each asks for. Every
 * source in src/data/sources.ts names one of these; the HUD shows CREDITS. Kept apart from the
 * source list so the app bundles the credits without the download plan.
 */

export interface Provider {
  name: string;
  /** The attribution the licence asks for, word for word. */
  credit: string;
  licence: string;
  licenceUrl: string;
  /** The short credit the HUD shows, and where it links. Left out when the licence asks none. */
  hud?: string;
  hudUrl?: string;
}

const DIGITAAL_VLAANDEREN = {
  licence: 'Modellicentie Gratis Hergebruik v1.0',
  licenceUrl: 'https://data.vlaanderen.be/id/licentie/modellicentie-gratis-hergebruik/v1.0',
  hud: '© Digitaal Vlaanderen',
  hudUrl: 'https://www.vlaanderen.be/digitaal-vlaanderen',
};

export const PROVIDERS = {
  osm: {
    name: 'OpenStreetMap',
    credit: '© OpenStreetMap contributors',
    licence: 'ODbL 1.0',
    licenceUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
    hud: '© OpenStreetMap',
    hudUrl: 'https://www.openstreetmap.org/copyright',
  },
  grb: {
    name: 'GRB (Grootschalig Referentie Bestand), Digitaal Vlaanderen',
    credit: 'Bron: Grootschalig Referentie Bestand Vlaanderen, Digitaal Vlaanderen',
    ...DIGITAAL_VLAANDEREN,
  },
  dhmv: {
    name: 'DHMV II LiDAR elevation, Digitaal Vlaanderen',
    credit: 'Bron: Digitaal Hoogtemodel Vlaanderen II, Digitaal Vlaanderen',
    ...DIGITAAL_VLAANDEREN,
  },
  ortho: {
    name: 'Orthophoto winter mosaic, Digitaal Vlaanderen',
    credit: 'Bron: Luchtopnamen Digitaal Vlaanderen',
    ...DIGITAAL_VLAANDEREN,
  },
  wikidata: {
    name: 'Wikidata',
    credit: 'Wikidata',
    licence: 'CC0 1.0',
    licenceUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  },
} as const satisfies Record<string, Provider>;

export type ProviderId = keyof typeof PROVIDERS;

/** The HUD's credits: one link per distinct short credit, in manifest order. */
export const CREDITS: readonly { label: string; href: string }[] = [
  ...new Map(
    Object.values(PROVIDERS as Record<ProviderId, Provider>).flatMap((p): [string, string][] =>
      p.hud && p.hudUrl ? [[p.hud, p.hudUrl]] : [],
    ),
  ).entries(),
].map(([label, href]) => ({ label, href }));
