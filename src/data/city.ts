/**
 * The city model the viewer renders. Coordinates are local metres around Grote Markt:
 * x = east, z = south (three.js: north is -z). Rings are flat [x0, z0, x1, z1, …] arrays,
 * counter-clockwise in (x, z), without a closing duplicate point.
 */

export const TIERS = ['hero', 'core', 'fringe'] as const;
export type Tier = (typeof TIERS)[number];

export const KINDS = ['other', 'house', 'apartments', 'retail', 'civic', 'church', 'shed'] as const;
export type Kind = (typeof KINDS)[number];

export const ROOFS = ['auto', 'flat', 'gabled', 'hipped'] as const;
export type Roof = (typeof ROOFS)[number];

export interface Building {
  id: number;
  tier: Tier;
  kind: Kind;
  roof: Roof;
  /** Roof top above ground in metres (LiDAR p90). */
  height: number;
  ring: Float32Array;
}

export interface Label {
  name: string;
  x: number;
  z: number;
}

export interface Bounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface City {
  bounds: Bounds;
  labels: Label[];
  buildings: Building[];
  roads: Float32Array[];
  plazas: Float32Array[];
  green: Float32Array[];
  water: Float32Array[];
  /** Flat [x0, z0, x1, z1, …] tree positions. */
  trees: Float32Array;
}

const KIND_BY_OSM: Record<string, Kind> = {
  house: 'house',
  terrace: 'house',
  detached: 'house',
  semidetached_house: 'house',
  residential: 'house',
  apartments: 'apartments',
  dormitory: 'apartments',
  retail: 'retail',
  commercial: 'retail',
  office: 'retail',
  hotel: 'retail',
  church: 'church',
  cathedral: 'church',
  chapel: 'church',
  university: 'civic',
  college: 'civic',
  school: 'civic',
  public: 'civic',
  civic: 'civic',
  government: 'civic',
  townhall: 'civic',
  museum: 'civic',
  library: 'civic',
  shed: 'shed',
  garage: 'shed',
  garages: 'shed',
  roof: 'shed',
  carport: 'shed',
};

const ROOF_BY_OSM: Record<string, Roof> = {
  flat: 'flat',
  gabled: 'gabled',
  saltbox: 'gabled',
  double_saltbox: 'gabled',
  hipped: 'hipped',
  'half-hipped': 'hipped',
  pyramidal: 'hipped',
  mansard: 'hipped',
};

/** Maps an OSM `building=*` value to the few kinds the renderer styles differently. */
export function kindFromOsm(value: string | null | undefined): Kind {
  return (value && Object.hasOwn(KIND_BY_OSM, value) && KIND_BY_OSM[value]) || 'other';
}

/** Maps an OSM `roof:shape=*` value to the roofs the renderer can draw. */
export function roofFromOsm(value: string | null | undefined): Roof {
  return (value && Object.hasOwn(ROOF_BY_OSM, value) && ROOF_BY_OSM[value]) || 'auto';
}
