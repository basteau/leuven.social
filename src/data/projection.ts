/**
 * WGS84 → local metres around Grote Markt, the same frame tools/build_leuven_data.py writes.
 * An equirectangular approximation: within 0.1% over the few kilometres the game covers.
 */

export const ORIGIN = { lon: 4.70139, lat: 50.87917 } as const;

const KX = 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const KZ = 110_574;

export function toLocal(lon: number, lat: number): [x: number, z: number] {
  return [(lon - ORIGIN.lon) * KX, (ORIGIN.lat - lat) * KZ];
}

export function toLonLat(x: number, z: number): [lon: number, lat: number] {
  return [ORIGIN.lon + x / KX, ORIGIN.lat - z / KZ];
}

const RAD = Math.PI / 180;
const ARCSEC = RAD / 3600;

/** Geodetic (radians, on the ellipsoid surface) to earth-centred cartesian metres. */
function toCartesian(lon: number, lat: number, a: number, e2: number): [number, number, number] {
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return [
    n * Math.cos(lat) * Math.cos(lon),
    n * Math.cos(lat) * Math.sin(lon),
    n * (1 - e2) * Math.sin(lat),
  ];
}

/** Cartesian back to geodetic radians, iterating the latitude (converges in a few steps). */
function fromCartesian(x: number, y: number, z: number, a: number, e2: number): [number, number] {
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 6; i++) {
    const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    const h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (e2 * n) / (n + h)));
  }
  return [Math.atan2(y, x), lat];
}

const WGS84_A = 6_378_137;
const WGS84_E2 = (2 - 1 / 298.257223563) / 298.257223563;
const INTL_A = 6_378_388;
const INTL_E = Math.sqrt((2 - 1 / 297) / 297);
/** "BD72 to WGS 84 (3)" (EPSG:15929), coordinate-frame convention, as PROJ writes it. */
const HELMERT = {
  t: [-106.8686, 52.2978, -103.7239],
  r: [-0.3366 * ARCSEC, 0.457 * ARCSEC, -1.8422 * ARCSEC],
  s: -1.2747e-6,
} as const;
/** Lambert conformal conic, two standard parallels, on the International 1924 ellipsoid. */
const lccM = (lat: number) => Math.cos(lat) / Math.sqrt(1 - (INTL_E * Math.sin(lat)) ** 2);
const lccT = (lat: number) =>
  Math.tan(Math.PI / 4 - lat / 2) /
  ((1 - INTL_E * Math.sin(lat)) / (1 + INTL_E * Math.sin(lat))) ** (INTL_E / 2);
const LCC = (() => {
  const lat1 = 51.1666672333333 * RAD;
  const lat2 = 49.8333339 * RAD;
  const n =
    (Math.log(lccM(lat1)) - Math.log(lccM(lat2))) / (Math.log(lccT(lat1)) - Math.log(lccT(lat2)));
  return { n, aF: (INTL_A * lccM(lat1)) / (n * lccT(lat1) ** n), lon0: 4.36748666666667 * RAD };
})();

/**
 * WGS84 → Belgian Lambert 72 (EPSG:31370) metres, the grid the Flemish LiDAR is served on.
 * The same operation pyproj picks (and tools/build_leuven_data.py pins), so the two agree to
 * the millimetre.
 */
export function toLambert72(lon: number, lat: number): [x: number, y: number] {
  const [x, y, z] = toCartesian(lon * RAD, lat * RAD, WGS84_A, WGS84_E2);
  // Inverse Helmert: undo the shift, then the rotation (transposed) and the scale.
  const [tx, ty, tz] = HELMERT.t;
  const [rx, ry, rz] = HELMERT.r;
  const dx = x - tx;
  const dy = y - ty;
  const dz = z - tz;
  const k = 1 + HELMERT.s;
  const [bLon, bLat] = fromCartesian(
    (dx - rz * dy + ry * dz) / k,
    (rz * dx + dy - rx * dz) / k,
    (-ry * dx + rx * dy + dz) / k,
    INTL_A,
    INTL_E ** 2,
  );
  const r = LCC.aF * lccT(bLat) ** LCC.n;
  const theta = LCC.n * (bLon - LCC.lon0);
  return [150_000.013 + r * Math.sin(theta), 5_400_088.438 - r * Math.cos(theta)];
}
