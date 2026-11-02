# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "matplotlib==3.11.2",
#   "numpy==2.5.4",
#   "pillow==13.0.0",
#   "pyproj==3.8.0",
#   "shapely==2.2.0",
#   "tifffile==2026.10.15",
# ]
# ///
"""Build game-ready Leuven data from the raw downloads in data/ (`bun run data:fetch`).

bun run data:build    (uv run --locked --script tools/build_leuven_data.py data)

The same downloads give the same bytes: inputs are read in a fixed order, numbers are rounded
before they are written, and the map projection is pinned below rather than left to PROJ.

Inputs (src/data/sources.ts lists each one's source and licence):
  grb/grb_GBG.geojson, grb/grb_GBA.geojson   GRB buildings and annexes (EPSG:4326)
  grb/grb_WBN.geojson, grb/grb_WGO.geojson   GRB road surfaces and their subdivision lines, for the road zones
  grb/grb_KNW.geojson                       GRB structures: bridges, tanks and silos, and the plinths under buildings
  elevation/{DTM,DSM}/*.tif                 DHMV II 1 m rasters (EPSG:31370), tiled
  osm/{buildings,ring_r23,roads,areas,points,furniture_ways}.json   Overpass answers (out geom / center)
  ortho/z18/{x}_{y}.png                     optional: orthophoto tiles for roof colours
Outputs (data/derived/):
  leuven_buildings.geojson   footprint + ground (m TAW) + height (m) + roof shape and colour + OSM tags
  leuven_buildings_local.json  compact game format: local metres, origin Grote Markt, x=east, z=south; with the axis
                             the roof slopes face (`facing`) and a church's tower (`tower`)
  lidar_trees.json           tree crowns found in the LiDAR canopy, with their heights
  grb_structures.json        GRB structures (bridges, tanks and silos) in local metres, with tank heights from the LiDAR
  road_zones.json            carriageways, cycle tracks, lane lines and crossings (tools/build_road_zones.py)
  terrain.json               the landform: the DTM smoothed (sigma ~37 m), every 60 m on a grid anchored at the origin
  osm_roads.geojson, osm_points.geojson
  preview_heights.png
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
import shapely
import tifffile
from pyproj import Transformer
from pyproj.enums import TransformDirection
from shapely import STRtree, contains_xy, make_valid
from shapely.geometry import LineString, Point, Polygon, mapping, shape

DATA = Path(sys.argv[1] if len(sys.argv) > 1 else 'data')
OUT = DATA / 'derived'
OUT.mkdir(exist_ok=True)
ORIGIN = (4.70139, 50.87917)  # Grote Markt (lon, lat)
# WGS84 -> Belgian Lambert 72 through "BD72 to WGS 84 (3)": what PROJ picks for EPSG:4326 -> 31370
# when no grid files are installed. Spelled out so an installed grid can't change the result;
# src/data/projection.ts implements the same operation.
LAMBERT72 = Transformer.from_pipeline(
    '+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad +step +proj=push +v_3 '
    '+step +proj=cart +ellps=WGS84 +step +inv +proj=helmert +x=-106.8686 +y=52.2978 +z=-103.7239 '
    '+rx=-0.3366 +ry=0.457 +rz=-1.8422 +s=-1.2747 +convention=coordinate_frame '
    '+step +inv +proj=cart +ellps=intl +step +proj=pop +v_3 +step +proj=lcc +lat_0=90 '
    '+lon_0=4.36748666666667 +lat_1=51.1666672333333 +lat_2=49.8333339 +x_0=150000.013 '
    '+y_0=5400088.438 +ellps=intl')
to_lambert = LAMBERT72.transform


def to_wgs(x, y):
    return LAMBERT72.transform(x, y, direction=TransformDirection.INVERSE)


# --- Rasters: mosaic the tiles using their GeoTIFF tie points ----------------------------------------------------------
def load_mosaic(kind):
    tiles = []
    for path in sorted(DATA.glob(f'elevation/{kind}/*.tif')):
        with tifffile.TiffFile(path) as tif:
            page = tif.pages[0]
            tie = page.tags['ModelTiepointTag'].value  # (i, j, k, x, y, z)
            scale = page.tags['ModelPixelScaleTag'].value
            tiles.append((tie[3], tie[4], scale[0], page.asarray().astype(np.float32)))
    x0 = min(t[0] for t in tiles)
    y1 = max(t[1] for t in tiles)
    res = tiles[0][2]
    w = int(round((max(t[0] + t[3].shape[1] * res for t in tiles) - x0) / res))
    h = int(round((y1 - min(t[1] - t[3].shape[0] * res for t in tiles)) / res))
    out = np.full((h, w), np.nan, np.float32)
    for tx, ty, _, a in tiles:
        c, r = int(round((tx - x0) / res)), int(round((y1 - ty) / res))
        out[r:r + a.shape[0], c:c + a.shape[1]] = a
    out[out < -1000] = np.nan
    return out, x0, y1, res


dtm, X0, Y1, RES = load_mosaic('DTM')
dsm, *_ = load_mosaic('DSM')
ndsm = dsm - dtm
# Roof slope from the surface model: pitched roofs sit at 15-60 degrees, flat ones under ~8.
_gy, _gx = np.gradient(dsm, RES)
slope = np.degrees(np.arctan(np.hypot(_gx, _gy)))
# Pixels covered by a building (grown later, footprint by footprint): trees are what's left.
built = np.zeros(dtm.shape, bool)
print(f'raster {dtm.shape}, origin {X0},{Y1}, res {RES}, DTM {np.nanmin(dtm):.1f}..{np.nanmax(dtm):.1f} m TAW')


def sample(poly_l72):
    """Ground, height percentiles, eave and the share of pitched roof pixels inside a footprint."""
    minx, miny, maxx, maxy = poly_l72.bounds
    c0, c1 = max(0, int((minx - X0) / RES)), min(dtm.shape[1], int((maxx - X0) / RES) + 1)
    r0, r1 = max(0, int((Y1 - maxy) / RES)), min(dtm.shape[0], int((Y1 - miny) / RES) + 1)
    if c1 <= c0 or r1 <= r0:
        return None
    cs, rs = np.meshgrid(np.arange(c0, c1), np.arange(r0, r1))
    xs, ys = X0 + (cs + 0.5) * RES, Y1 - (rs + 0.5) * RES
    m = contains_xy(poly_l72, xs, ys)
    if not m.any():  # tiny footprint: nearest pixel to the centroid
        p = poly_l72.representative_point()
        r, c = int((Y1 - p.y) / RES), int((p.x - X0) / RES)
        m = np.zeros_like(cs, bool)
        if 0 <= r - r0 < m.shape[0] and 0 <= c - c0 < m.shape[1]:
            m[r - r0, c - c0] = True
    grown = contains_xy(poly_l72.buffer(1.5), xs, ys)
    built[r0:r1, c0:c1] |= grown
    g, h = dtm[r0:r1, c0:c1][m], ndsm[r0:r1, c0:c1][m]
    g, h = g[~np.isnan(g)], h[~np.isnan(h)]
    if not len(g) or not len(h):
        return None
    # Slopes 1 m in from the walls, so the drop off the eaves doesn't count as roof.
    inner = poly_l72.buffer(-1.0)
    mi = contains_xy(inner, xs, ys) if not inner.is_empty else m
    roof = mi if mi.sum() >= 3 else m
    s = slope[r0:r1, c0:c1][roof]
    s = s[~np.isnan(s)]
    pitch = float(((s > 15) & (s < 60)).mean()) if len(s) else 0.0
    return (float(np.median(g)), float(np.percentile(h, 90)), float(np.median(h)), float(h.max()),
            float(np.percentile(h, 15)), pitch, facing(r0, r1, c0, c1, roof))


def facing(r0, r1, c0, c1, roof):
    """Which way the roof's slopes face: the main axis of the slope vectors of its pitched pixels (15-60 degrees),
    each weighted by its steepness squared (their structure tensor). Returns that axis in degrees from local x (east)
    towards z (south), 0-180, and how strongly the slopes keep to it, 0 (every way, or flat) to 1 (one axis: a
    gable). Raster rows run south, so a row step is a step in local z; Lambert's grid is within 0.3 degrees of it."""
    gx, gz = _gx[r0:r1, c0:c1][roof], _gy[r0:r1, c0:c1][roof]
    s = np.hypot(gx, gz)
    k = (s > math.tan(math.radians(15))) & (s < math.tan(math.radians(60)))
    if k.sum() < 4:
        return None
    gx, gz = gx[k].astype(np.float64), gz[k].astype(np.float64)
    xx, zz, xz = (gx * gx).sum(), (gz * gz).sum(), (gx * gz).sum()
    angle = math.degrees(0.5 * math.atan2(2 * xz, xx - zz)) % 180
    return round(angle) % 180, round(math.hypot(xx - zz, 2 * xz) / (xx + zz), 2)


# --- Church towers: what the p90 height leaves out ----------------------------------------------------------------------
# A church's p90 is its nave roof; its tower or spire is a few dozen pixels that rise far above it. OSM building values
# that the viewer draws as a church (KIND_BY_OSM in src/data/city.ts).
CHURCHES = {'church', 'cathedral', 'chapel'}
TOWER_RISE = 8.0  # m over the p90: a tower or spire, not a ridge, a dormer or a chimney
TOWER_BODY = 1.5  # m over the p90: what the tower's body is grown into, below its spire
TOWER_MIN_PIXELS = 4  # a ridge turret's spire is 2 x 2 m; less is a chimney or noise
TOWER_PIXELS = 6  # from here the group is a tower's top, with a body of its own under it


def components(mask):
    """8-connected pixel groups of a small boolean array, in raster order of their first pixel."""
    seen = np.zeros_like(mask)
    groups = []
    for r, c in zip(*np.nonzero(mask)):
        if seen[r, c]:
            continue
        seen[r, c] = True
        group, todo = [], [(int(r), int(c))]
        while todo:
            y, x = todo.pop()
            group.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    v, u = y + dy, x + dx
                    if 0 <= v < mask.shape[0] and 0 <= u < mask.shape[1] and mask[v, u] and not seen[v, u]:
                        seen[v, u] = True
                        todo.append((v, u))
        groups.append(sorted(group))
    return groups


def church_tower(poly_l72):
    """The tower (or ridge turret) of a church footprint, as (x, y) in Lambert 72, the radius of a square tower of its
    area (centre to corner), the top of its walls and the tip of its spire, in m above ground; None without one.

    Seeds are the pixels over p90 + TOWER_RISE. Only a compact group counts: at least TOWER_MIN_PIXELS, filling 40% of
    its bounding box, no more than 2.5 times as long as wide. A crane's jib is a thin line and fails; so does the
    scatter of a tree's tips. A group under TOWER_PIXELS is a slender spire on the ridge: its walls end at the p90.
    A tower's body is its group grown into its neighbours over p90 + TOWER_BODY, within twice its own radius plus
    2 m (so never into the whole nave), and its walls end at the lowest quarter of that body's heights."""
    minx, miny, maxx, maxy = poly_l72.bounds
    c0, c1 = max(0, int((minx - X0) / RES)), min(dtm.shape[1], int((maxx - X0) / RES) + 1)
    r0, r1 = max(0, int((Y1 - maxy) / RES)), min(dtm.shape[0], int((Y1 - miny) / RES) + 1)
    if c1 <= c0 or r1 <= r0:
        return None
    cs, rs = np.meshgrid(np.arange(c0, c1), np.arange(r0, r1))
    h = ndsm[r0:r1, c0:c1]
    m = contains_xy(poly_l72, X0 + (cs + 0.5) * RES, Y1 - (rs + 0.5) * RES) & ~np.isnan(h)
    if m.sum() < 20:
        return None
    h = np.where(m, h, -np.inf)
    p90 = float(np.percentile(h[m], 90))
    best = None
    for group in components(h > p90 + TOWER_RISE):
        ys, xs = np.array([g[0] for g in group]), np.array([g[1] for g in group])
        long, short = sorted((int(ys.max() - ys.min()) + 1, int(xs.max() - xs.min()) + 1), reverse=True)
        if len(group) >= TOWER_MIN_PIXELS and len(group) >= 0.4 * long * short and long <= 2.5 * short:
            if best is None or len(group) > len(best):
                best = group
    if best is None:
        return None
    cy, cx = np.mean([g[0] for g in best]), np.mean([g[1] for g in best])
    body, top = best, p90
    if len(best) >= TOWER_PIXELS:
        reach = (2 * math.sqrt(len(best) / math.pi) + 2) / RES
        near = (rs - r0 - cy) ** 2 + (cs - c0 - cx) ** 2 <= reach ** 2
        seed = max(best, key=lambda g: h[g])  # the tip: the first of equals, in raster order
        body = next(g for g in components((h > p90 + TOWER_BODY) & near) if seed in set(g))
        top = max(float(np.percentile([h[g] for g in body], 25)), p90)
        cy, cx = np.mean([g[0] for g in body]), np.mean([g[1] for g in body])
    tip = max(float(h[g]) for g in body)
    return X0 + (c0 + cx + 0.5) * RES, Y1 - (r0 + cy + 0.5) * RES, math.sqrt(len(body) / 2) * RES, top, tip


# --- Orthophoto roof colours: the median of each roof's sunlit pixels -------------------------------------------------
ORTHO_Z = 18
ortho_tiles = {}
for path in sorted(DATA.glob(f'ortho/z{ORTHO_Z}/*_*.png')):
    tx, ty = map(int, path.stem.split('_'))
    ortho_tiles[(tx, ty)] = path
if ortho_tiles:
    from PIL import Image
    tx0, tx1 = min(k[0] for k in ortho_tiles), max(k[0] for k in ortho_tiles)
    ty0, ty1 = min(k[1] for k in ortho_tiles), max(k[1] for k in ortho_tiles)
    ortho = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256, 3), np.uint8)
    for (tx, ty), path in ortho_tiles.items():
        ortho[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = np.asarray(Image.open(path).convert('RGB'))
    print(f'orthophoto {ortho.shape[1]}x{ortho.shape[0]} px from {len(ortho_tiles)} tiles')


def to_ortho_px(lon, lat):
    n = 2 ** ORTHO_Z * 256
    lat = np.radians(lat)
    return (lon + 180) / 360 * n - tx0 * 256, (1 - np.arcsinh(np.tan(lat)) / np.pi) / 2 * n - ty0 * 256


def roof_colour(poly_ll):
    """Median colour of the brighter half of a roof's orthophoto pixels: shadows and dark
    gutters drop out, so a slope in shade doesn't turn a red roof brown."""
    if not ortho_tiles:
        return None
    px = shapely.transform(poly_ll, lambda a: np.column_stack(to_ortho_px(a[:, 0], a[:, 1])))
    inner = px.buffer(-2.5)  # ~1 m: walls, gutters and the lean of tall buildings
    if inner.is_empty or inner.area < 12:
        inner = px
    minx, miny, maxx, maxy = inner.bounds
    c0, c1 = max(0, int(minx)), min(ortho.shape[1], int(maxx) + 1)
    r0, r1 = max(0, int(miny)), min(ortho.shape[0], int(maxy) + 1)
    if c1 <= c0 or r1 <= r0:
        return None
    cs, rs = np.meshgrid(np.arange(c0, c1), np.arange(r0, r1))
    m = contains_xy(inner, cs + 0.5, rs + 0.5)
    rgb = ortho[r0:r1, c0:c1][m].astype(np.float32)
    rgb = rgb[rgb.sum(1) > 0]  # outside the downloaded tiles
    if len(rgb) < 6:
        return None
    lum = rgb @ np.array([0.299, 0.587, 0.114], np.float32)
    bright = rgb[lum >= np.median(lum)]
    return [int(round(v)) for v in np.median(bright, axis=0)]


# --- OSM building tags, joined by representative point -------------------------------------------------------------
def osm_elements(name):
    """One Overpass layer, already deduplicated and in type and id order (scripts/fetch.ts)."""
    return json.load(open(DATA / f'osm/{name}.json'))['elements']


def way_geom(e):
    pts = [(p['lon'], p['lat']) for p in e.get('geometry', []) if p]
    if len(pts) < 2:
        return None
    if len(pts) >= 4 and pts[0] == pts[-1]:
        return make_valid(Polygon(pts))
    return LineString(pts)


osm_b = [(e, way_geom(e)) for e in osm_elements('buildings') if e['type'] == 'way' and 'building' in e.get('tags', {})]
osm_b = [(e, g) for e, g in osm_b if g is not None and g.geom_type in ('Polygon', 'MultiPolygon')]
osm_pts = [g.representative_point() for _, g in osm_b]
KEEP = ['building', 'name', 'building:levels', 'roof:shape', 'roof:levels', 'amenity', 'shop', 'historic', 'building:colour', 'roof:colour']

# --- Detail tiers: hand-built hero zones > generic but faithful core inside R23 > cheap fringe outside it ---------------
# Which neighbourhoods get the most detail is a design choice, not data (docs/DATA.md, Exceptions). Centres are the
# Wikidata coordinates (P625) of each square or landmark, except Ladeuzeplein and Martelarenplein, moved between the
# square and its library or station so one circle holds both.
HERO_ZONES = {  # name: (lon, lat, radius m)
    'Grote Markt (Stadhuis, Sint-Pieterskerk)': (4.70139, 50.87917, 170),  # Q4766627
    'Oude Markt': (4.69944, 50.87806, 120),  # Q2792167
    'Ladeuzeplein (Universiteitsbibliotheek)': (4.70690, 50.87820, 140),  # Q6469401, Q139854572
    'Martelarenplein (station)': (4.71560, 50.88100, 150),  # Q2658903, Q801090
    'Groot Begijnhof': (4.69694, 50.87167, 170),  # Q1049301
    'Kasteel van Arenberg (Heverlee)': (4.68306, 50.86333, 220),  # Q1522076
}
ring_pts = [(p['lon'], p['lat']) for e in osm_elements('ring_r23') for p in e.get('geometry', []) if p]
RING = make_valid(Polygon(ring_pts).convex_hull)  # R23 is close to convex; hull is fine for tiering

# --- Buildings ------------------------------------------------------------------------------------------------------
grb = json.load(open(DATA / 'grb/grb_GBG.geojson'))['features']
geoms = [make_valid(shape(f['geometry'])) for f in grb]
tree = STRtree(geoms)
osm_for = {}
for idx in range(len(osm_pts)):
    hits = tree.query(osm_pts[idx], predicate='within')
    for h in hits:
        osm_for.setdefault(int(h), osm_b[idx][0]['tags'])

lat0 = math.radians(ORIGIN[1])
kx, kz = 111320 * math.cos(lat0), 110574  # metres per degree: good to ~0.1% over 3 km
feats, local, skipped = [], [], 0
towers = []
for i, (f, g) in enumerate(zip(grb, geoms)):
    g_l72 = shapely.transform(g, lambda a: np.column_stack(to_lambert(a[:, 0], a[:, 1])))
    s = sample(g_l72)
    if s is None:
        skipped += 1
        continue
    ground, h90, hmed, hmax, h15, pitch, faces = s
    tags = osm_for.get(i, {})
    tower = church_tower(g_l72) if tags.get('building') in CHURCHES else None
    rgb = roof_colour(g)
    props = {
        'oidn': f['properties']['OIDN'], 'grb_type': f['properties']['LBLTYPE'],
        'ground_taw': round(ground, 2), 'height': round(max(h90, 2.5), 1),
        'height_median': round(hmed, 1), 'height_max': round(hmax, 1),
        'eave': round(max(min(h15, h90), 2.5), 1), 'roof_pitch': round(pitch, 2),
        **({'roof_rgb': rgb} if rgb else {}),
        **{k: tags[k] for k in KEEP if k in tags},
    }
    if 'height' in tags:
        props['osm_height'] = tags['height']
    c = g.representative_point()
    hero = next((n for n, (lo, la, r) in HERO_ZONES.items() if math.hypot((c.x - lo) * kx, (c.y - la) * kz) < r), None)
    props['tier'] = 'hero' if hero else 'core' if RING.contains(c) else 'fringe'
    if hero:
        props['zone'] = hero
    feats.append({'type': 'Feature', 'properties': props, 'geometry': mapping(g)})
    polys = [g] if g.geom_type == 'Polygon' else [p for p in getattr(g, 'geoms', []) if p.geom_type == 'Polygon']
    to_local = lambda coords: [[round((x - ORIGIN[0]) * kx, 1), round(-(y - ORIGIN[1]) * kz, 1)] for x, y in coords[:-1]]
    if tower:
        lon, lat = to_wgs(tower[0], tower[1])
        towers.append((props.get('name') or props['oidn'], round(h90, 1), [round(v, 1) for v in tower[2:]]))
    for p in polys:
        entry = {'id': props['oidn'], 'h': props['height'], 'eave': props['eave'], 'pitch': props['roof_pitch'],
                 'rgb': props.get('roof_rgb'), 'g': props['ground_taw'], 'kind': tags.get('building', 'yes'),
                 'roof': tags.get('roof:shape'), 'name': tags.get('name'), 'tier': props['tier'],
                 'ring': to_local(p.exterior.coords), 'holes': [to_local(h.coords) for h in p.interiors]}
        if faces:
            entry['facing'] = list(faces)
        if tower and p.contains(Point(lon, lat)):
            entry['tower'] = [round((lon - ORIGIN[0]) * kx, 1), round(-(lat - ORIGIN[1]) * kz, 1),
                              *(round(v, 1) for v in tower[2:])]
        local.append(entry)

# Annexes (GRB GBA: garages, sheds, extensions) are not drawn, but they aren't trees either.
for f in json.load(open(DATA / 'grb/grb_GBA.geojson'))['features']:
    g = make_valid(shape(f['geometry']))
    pl = shapely.transform(g, lambda a: np.column_stack(to_lambert(a[:, 0], a[:, 1])))
    minx, miny, maxx, maxy = pl.bounds
    c0, c1 = max(0, int((minx - X0) / RES) - 2), min(dtm.shape[1], int((maxx - X0) / RES) + 3)
    r0, r1 = max(0, int((Y1 - maxy) / RES) - 2), min(dtm.shape[0], int((Y1 - miny) / RES) + 3)
    if c1 > c0 and r1 > r0:
        cs, rs = np.meshgrid(np.arange(c0, c1), np.arange(r0, r1))
        built[r0:r1, c0:c1] |= contains_xy(pl.buffer(1.0), X0 + (cs + 0.5) * RES, Y1 - (rs + 0.5) * RES)

# Grey-world white balance over the sampled roofs in the ring and hero zones: the winter mosaic has a cool cast, and the
# viewer snaps these colours to its palette, which expects neutral slate to come out neutral.
# Fringe roofs don't count, so how far past the map the downloads reach doesn't shift every colour.
rgbs = np.array([f['properties']['roof_rgb'] for f in feats if 'roof_rgb' in f['properties'] and f['properties']['tier'] != 'fringe'], np.float32)
if len(rgbs):
    balance = rgbs.mean(0).mean() / rgbs.mean(0)
    for f in feats:
        rgb = f['properties'].get('roof_rgb')
        if rgb:  # the same list object sits in `local`, so both outputs get it
            rgb[:] = [int(min(255, round(v * k))) for v, k in zip(rgb, balance)]
    print(f'roof colours: {len(rgbs)} sampled, white balance {np.round(balance, 3).tolist()}')
json.dump({'type': 'FeatureCollection', 'features': feats}, open(OUT / 'leuven_buildings.geojson', 'w'), separators=(',', ':'))
json.dump({'origin_lonlat': ORIGIN, 'units': 'm', 'axes': 'x=east, z=south (three.js: north = -z)',
           'height': 'p90 of DHMV II DSM-DTM inside footprint (LiDAR 2013-15)', 'ground': 'median DTM, m TAW',
           'attribution': 'GRB & DHMV II (c) Digitaal Vlaanderen; tags (c) OpenStreetMap contributors (ODbL)',
           'hero_zones': {n: [round((lo - ORIGIN[0]) * kx), round(-(la - ORIGIN[1]) * kz), r] for n, (lo, la, r) in HERO_ZONES.items()},
           'buildings': local}, open(OUT / 'leuven_buildings_local.json', 'w'), separators=(',', ':'))
# --- Trees from the LiDAR canopy: local maxima of what stands tall outside every building -------------------------
def lidar_trees(min_height=10.0, max_height=35.0):
    """Crown tops: pixels that are the highest within 3 m, at least 10 m tall and off any building.
    A crown claims about the room the viewer's tree of that height fills (src/scene/trees.ts: crown
    radius 2.6 m x 1.2 x (h / 6.8)^0.8), so a canopy reads closed with as few trees as possible:
    each costs 28 triangles, twice over in the shadow pass."""
    canopy = np.where(built | np.isnan(ndsm), 0, ndsm)
    canopy[canopy > max_height] = 0  # cranes, masts and LiDAR noise
    r = 3
    pad = np.pad(canopy, r, constant_values=0)
    peak = np.ones(canopy.shape, bool)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy <= r * r and (dx or dy):
                peak &= canopy >= pad[r + dy:r + dy + canopy.shape[0], r + dx:r + dx + canopy.shape[1]]
    # A crown is rough: a smooth peak is more likely a wall, a shed or a bus shelter missing from GRB.
    rough = slope > 25
    rough_near = sum(np.roll(np.roll(rough, dy, 0), dx, 1) for dy in (-1, 0, 1) for dx in (-1, 0, 1)) >= 3
    rows, cols = np.nonzero(peak & (canopy >= min_height) & rough_near)
    # Stable, so equal heights go in raster order (north to south, west to east) whatever the raster's extent.
    order = np.argsort(-canopy[rows, cols], kind='stable')
    # Buckets as wide as the largest room, so looking one bucket around finds every clash and the result doesn't
    # depend on where the raster happens to start.
    bucket = math.ceil(2.1 * 2.6 * (max_height / 6.8) ** 0.8 / RES)
    kept, grid = [], {}
    for k in order:
        r_, c_ = int(rows[k]), int(cols[k])
        h = float(canopy[r_, c_])
        room = max(6.0, 2.1 * 2.6 * (h / 6.8) ** 0.8)
        cell = (r_ // bucket, c_ // bucket)
        clash = any(math.hypot(r_ - r2, c_ - c2) * RES < max(room, room2)
                    for dy in (-1, 0, 1) for dx in (-1, 0, 1) for r2, c2, room2 in grid.get((cell[0] + dy, cell[1] + dx), ()))
        if clash:
            continue
        grid.setdefault(cell, []).append((r_, c_, room))
        kept.append((X0 + (c_ + 0.5) * RES, Y1 - (r_ + 0.5) * RES, h))
    return kept


crowns = lidar_trees()
trees_local = []
for x, y, h in crowns:
    lon, lat = to_wgs(x, y)
    trees_local.append([round((lon - ORIGIN[0]) * kx, 1), round(-(lat - ORIGIN[1]) * kz, 1), round(h, 1)])
json.dump({'units': 'm', 'axes': 'x=east, z=south', 'source': 'DHMV II DSM-DTM local maxima outside GRB buildings',
           'trees': trees_local}, open(OUT / 'lidar_trees.json', 'w'), separators=(',', ':'))
print(f'lidar trees: {len(trees_local)}')

# --- Structures (GRB KNW): what stands tall but isn't a building ---------------------------------------------------
# Silos, tanks and chemical plant (most of them the brewery's) get their LiDAR height; bridges keep their outline
# only, for their parapets. Pillars, grates, cabins, masts (a lattice the LiDAR sees through) and monuments (mostly
# a statue's plinth, which OSM already has) are left out.
KNW_KINDS = {1: 'bridge', 9: 'tank', 13: 'tank'}
structures = []
for f in json.load(open(DATA / 'grb/grb_KNW.geojson'))['features']:
    kind = KNW_KINDS.get(f['properties']['TYPE'])
    g = make_valid(shape(f['geometry'])) if kind else None
    for p in [] if g is None else [g] if g.geom_type == 'Polygon' else [q for q in getattr(g, 'geoms', []) if q.geom_type == 'Polygon']:
        height = 0.0
        if kind != 'bridge':
            # The top of a thin tank can fall between LiDAR pixels: look a metre around it.
            pl = shapely.transform(p.buffer(0.00001), lambda a: np.column_stack(to_lambert(a[:, 0], a[:, 1])))
            minx, miny, maxx, maxy = pl.bounds
            c0, c1 = max(0, int((minx - X0) / RES)), min(dtm.shape[1], int((maxx - X0) / RES) + 1)
            r0, r1 = max(0, int((Y1 - maxy) / RES)), min(dtm.shape[0], int((Y1 - miny) / RES) + 1)
            if c1 <= c0 or r1 <= r0:
                continue
            cs, rs = np.meshgrid(np.arange(c0, c1), np.arange(r0, r1))
            h = ndsm[r0:r1, c0:c1][contains_xy(pl, X0 + (cs + 0.5) * RES, Y1 - (rs + 0.5) * RES)]
            h = h[~np.isnan(h)]
            if not len(h):
                continue
            height = round(float(np.percentile(h, 90)), 1)
        structures.append({'kind': kind, 'h': height, 'ring': [[round((x - ORIGIN[0]) * kx, 1), round(-(y - ORIGIN[1]) * kz, 1)]
                                                                for x, y in p.exterior.coords[:-1]]})
json.dump({'units': 'm', 'axes': 'x=east, z=south', 'source': 'GRB KNW structures, heights DHMV II DSM-DTM p90',
           'structures': structures}, open(OUT / 'grb_structures.json', 'w'), separators=(',', ':'))
print(f'structures: {len(structures)}')

# --- Terrain: the lie of the land, without the city's kerbs, quays and cuttings -----------------------------------------
# The DTM averaged into 5 m blocks, then smoothed by three box passes 75 m wide (a near-Gaussian, sigma ~37 m): what's
# left is the landform (the Dijle valley, the slopes up to Kessel-Lo and Heverlee), not the quay walls, railway
# cuttings or embankments, so roads stay at grade the way bridges already do. Sampled every TERRAIN_STEP metres on a
# grid anchored at the origin (Grote Markt), over the whole raster; the bake keeps the part over the map.
TERRAIN_STEP = 60
TERRAIN_BLOCK = 5
TERRAIN_BOX = 7  # blocks either side: 15 x 5 = 75 m


def box_sum(a, r, axis):
    """Sums over a window of 2r + 1 along `axis`, counting nothing beyond the edges."""
    pad = [(0, 0)] * a.ndim
    pad[axis] = (r + 1, r)
    c = np.cumsum(np.pad(a, pad), axis=axis)
    n = a.shape[axis]
    return np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis) - np.take(c, np.arange(n), axis)


def landform():
    b = TERRAIN_BLOCK
    h, w = dtm.shape[0] // b * b, dtm.shape[1] // b * b
    known = ~np.isnan(dtm[:h, :w])
    total = np.where(known, dtm[:h, :w], 0).astype(np.float64).reshape(h // b, b, w // b, b).sum((1, 3))
    count = known.astype(np.float64).reshape(h // b, b, w // b, b).sum((1, 3))
    # Smoothing the sums and the counts alike keeps the DTM's holes (no ground return) out of the mean.
    for _ in range(3):
        for axis in (0, 1):
            total, count = box_sum(total, TERRAIN_BOX, axis), box_sum(count, TERRAIN_BOX, axis)
    with np.errstate(invalid='ignore', divide='ignore'):
        return total / count


def terrain_grid():
    smooth = landform()
    rows, cols = smooth.shape
    # The raster's corners in local metres: nodes inside all four are sampled.
    corners = [to_wgs(X0 + c * RES, Y1 - r * RES) for r in (0, rows * TERRAIN_BLOCK) for c in (0, cols * TERRAIN_BLOCK)]
    xs = [(lon - ORIGIN[0]) * kx for lon, _ in corners]
    zs = [-(lat - ORIGIN[1]) * kz for _, lat in corners]
    g = TERRAIN_STEP
    i0, i1 = math.ceil(max(xs[0], xs[2]) / g), math.floor(min(xs[1], xs[3]) / g)
    j0, j1 = math.ceil(max(zs[0], zs[1]) / g), math.floor(min(zs[2], zs[3]) / g)
    nx, nz = np.meshgrid(np.arange(i0, i1 + 1) * g, np.arange(j0, j1 + 1) * g)
    lx, ly = to_lambert(ORIGIN[0] + nx / kx, ORIGIN[1] - nz / kz)
    # Bilinear between block centres.
    fc = (lx - X0) / RES / TERRAIN_BLOCK - 0.5
    fr = (Y1 - ly) / RES / TERRAIN_BLOCK - 0.5
    c0 = np.clip(np.floor(fc).astype(int), 0, cols - 2)
    r0 = np.clip(np.floor(fr).astype(int), 0, rows - 2)
    u, v = np.clip(fc - c0, 0, 1), np.clip(fr - r0, 0, 1)
    heights = (smooth[r0, c0] * (1 - u) * (1 - v) + smooth[r0, c0 + 1] * u * (1 - v)
               + smooth[r0 + 1, c0] * (1 - u) * v + smooth[r0 + 1, c0 + 1] * u * v)
    return {'step': g, 'i0': i0, 'j0': j0, 'cols': i1 - i0 + 1, 'rows': j1 - j0 + 1,
            'heights': [round(float(v), 2) for v in heights.ravel()]}


terrain = terrain_grid()
json.dump({'units': 'm TAW', 'axes': 'x=east, z=south; node (i, j) at x = (i0 + i) step, z = (j0 + j) step, rows along z',
           'source': 'DHMV II DTM, 5 m blocks smoothed by three 75 m box passes', **terrain},
          open(OUT / 'terrain.json', 'w'), separators=(',', ':'))
print(f"terrain: {terrain['cols']} x {terrain['rows']} nodes every {TERRAIN_STEP} m, "
      f"{min(terrain['heights']):.1f}..{max(terrain['heights']):.1f} m TAW")

hs = np.array([f['properties']['height'] for f in feats])
print(f'church towers: {len(towers)} (name, p90, [radius, top, tip])')
for t in towers:
    print('  ', *t)
print(f'buildings: {len(feats)} (skipped {skipped}), with OSM tags: {len(osm_for)}; height median {np.median(hs):.1f} m, p99 {np.percentile(hs, 99):.1f} m, max {hs.max():.1f} m')
tallest = sorted(feats, key=lambda f: -f['properties']['height_max'])[:12]
for f in tallest:
    p = f['properties']
    print(f"  {p['height_max']:5.1f} m max / {p['height']:5.1f} p90  {p.get('name') or p.get('building') or p['grb_type']}")
for t in ('hero', 'core', 'fringe'):
    sel = [f['properties'] for f in feats if f['properties']['tier'] == t]
    print(f'  tier {t}: {len(sel)} buildings, median height {np.median([p["height"] for p in sel]):.1f} m')

# --- Other OSM layers -----------------------------------------------------------------------------------------------
roads = [{'type': 'Feature', 'properties': e['tags'], 'geometry': mapping(LineString([(p['lon'], p['lat']) for p in e['geometry']]))}
         for e in osm_elements('roads') + osm_elements('ring_r23') if e['type'] == 'way' and len(e.get('geometry', [])) >= 2]
json.dump({'type': 'FeatureCollection', 'features': roads}, open(OUT / 'osm_roads.geojson', 'w'), separators=(',', ':'))
# The parks and water under the preview; the bake reads land use from osm/areas.json itself.
areas = []
for e in osm_elements('areas'):
    if e['type'] == 'way':
        g = way_geom(e)
        if g is not None:
            areas.append({'type': 'Feature', 'properties': e.get('tags', {}), 'geometry': mapping(g)})
    elif e['type'] == 'relation':  # outer members only: good enough for parks/water at game scale
        for m in e.get('members', []):
            if m.get('role') == 'outer' and m.get('geometry'):
                g = way_geom(m)
                if g is not None:
                    areas.append({'type': 'Feature', 'properties': {**e.get('tags', {}), '_relation': e['id']}, 'geometry': mapping(g)})


def furniture_shape(e):
    """A bench or rack drawn as a way: a point on it, the bearing it runs along (degrees clockwise from north) and its
    length (m). A line runs along its longest stretch, first node to last, and stands at its middle; an area along the
    long side of the rectangle round it, from its centre (None: Overpass's centre is kept)."""
    xy = [((p['lon'] - ORIGIN[0]) * kx, (p['lat'] - ORIGIN[1]) * kz) for p in e['geometry']]  # x east, y north
    if len(xy) >= 4 and xy[0] == xy[-1]:
        box = shapely.oriented_envelope(Polygon(xy))
        if box.geom_type != 'Polygon':
            return None
        c = box.exterior.coords
        (ax, ay), (bx, by) = max([(c[0], c[1]), (c[1], c[2])], key=lambda s: math.dist(*s))
        return None, math.degrees(math.atan2(bx - ax, by - ay)) % 180, math.dist((ax, ay), (bx, by))
    segments = [(a, b) for a, b in zip(xy, xy[1:]) if a != b]
    if not segments:
        return None
    (ax, ay), (bx, by) = max(segments, key=lambda s: math.dist(*s))  # the first of equals
    middle = (ORIGIN[0] + (ax + bx) / 2 / kx, ORIGIN[1] + (ay + by) / 2 / kz)
    return middle, math.degrees(math.atan2(bx - ax, by - ay)) % 360, sum(math.dist(a, b) for a, b in segments)


# --- Monuments: the plinth the GRB maps under each, and its height in the LiDAR ---------------------------------------
# GRB structures of type 3 ("cultuur-historisch monument") are the plinths and basins of statues and fountains. A
# monument point within 2 m of one takes its rectangle: the bearing of its long side, its length and width (m). The
# LiDAR's height (DSM - DTM, plinth included) counts only for a compact object with open ground round it: on its plinth,
# or within 1.5 m of the point, its highest pixel of 0.8 m and up; then, under 12 m without a plinth (a taller one is a
# crown), at most 8 pixels within 2.5 m above 0.3 of that (no crown, no wall), and under a quarter of the ring 2-4 m out
# from it (3.5-5.5 m without one) over 1.5 m. Statues set up after the 2013-15 flight, or under a tree, get none.
MONUMENT_POINT = lambda t: (t.get('tourism') == 'artwork' or 'memorial' in t or t.get('amenity') == 'fountain'
                            or t.get('man_made') == 'water_well' or t.get('historic') in ('memorial', 'monument', 'wayside_shrine', 'wayside_cross'))
plinths = [make_valid(shape(f['geometry'])) for f in json.load(open(DATA / 'grb/grb_KNW.geojson'))['features']
           if f['properties']['TYPE'] == 3]
plinths = [g for g in plinths if g.geom_type == 'Polygon']
plinths_local = [shapely.transform(g, lambda a: np.column_stack(((a[:, 0] - ORIGIN[0]) * kx, (a[:, 1] - ORIGIN[1]) * kz)))
                 for g in plinths]  # x east, y north
plinths_l72 = [shapely.transform(g, lambda a: np.column_stack(to_lambert(a[:, 0], a[:, 1]))) for g in plinths]
plinth_index = STRtree(plinths_local)


def heights_in(area):
    """LiDAR heights (DSM - DTM, m, gaps as 0) of the pixels whose centres lie in an area (Lambert 72)."""
    minx, miny, maxx, maxy = area.bounds
    c0, c1 = max(0, int((minx - X0) / RES)), min(dtm.shape[1], int((maxx - X0) / RES) + 1)
    r0, r1 = max(0, int((Y1 - maxy) / RES)), min(dtm.shape[0], int((Y1 - miny) / RES) + 1)
    if c1 <= c0 or r1 <= r0:
        return np.zeros(0, np.float32)
    cs, rs = np.meshgrid(np.arange(c0, c1), np.arange(r0, r1))
    h = np.nan_to_num(ndsm[r0:r1, c0:c1][contains_xy(area, X0 + (cs + 0.5) * RES, Y1 - (rs + 0.5) * RES)])
    return h


def monument_survey(lon, lat):
    """`_bearing`, `_length` and `_width` of the GRB plinth under a monument, and its LiDAR `_height`, as tags."""
    tags = {}
    here = Point((lon - ORIGIN[0]) * kx, (lat - ORIGIN[1]) * kz)
    near = sorted(((plinths_local[i].distance(here), int(i)) for i in plinth_index.query(here.buffer(2))))
    x, y = to_lambert(lon, lat)
    if near and near[0][0] <= 2:
        i = near[0][1]
        box = shapely.oriented_envelope(plinths_local[i])
        c = box.exterior.coords
        (ax, ay), (bx, by) = max([(c[0], c[1]), (c[1], c[2])], key=lambda s: math.dist(*s))
        tags |= {'_bearing': f'{math.degrees(math.atan2(bx - ax, by - ay)) % 180:.1f}', '_length': f'{math.dist((ax, ay), (bx, by)):.1f}',
                 '_width': f'{min(math.dist(c[0], c[1]), math.dist(c[1], c[2])):.1f}'}
        g = plinths_l72[i]
        top, body, ring, most = g.buffer(0.5), None, g.buffer(4).difference(g.buffer(2)), 40
    else:
        p = Point(x, y)
        top, body, ring, most = p.buffer(1.5), p.buffer(2.5), p.buffer(5.5).difference(p.buffer(3.5)), 12
    h = heights_in(top)
    peak = float(h.max()) if len(h) else 0.0
    around = heights_in(ring)
    open_round = len(around) and float((around > 1.5).mean()) < 0.25
    compact = body is None or int((heights_in(body) > max(0.5, 0.3 * peak)).sum()) <= 8
    if 0.8 <= peak <= most and open_round and compact:
        tags['_height'] = f'{peak:.1f}'
    return tags


furniture = {e['id']: e for e in osm_elements('furniture_ways')}
pts = []
for e in osm_elements('points'):
    ll = (e['lon'], e['lat']) if 'lon' in e else (e['center']['lon'], e['center']['lat']) if 'center' in e else None
    if not ll:
        continue
    props = {**e.get('tags', {}), '_osm': f"{e['type']}/{e['id']}"}
    shaped = furniture_shape(furniture[e['id']]) if e['type'] == 'way' and e['id'] in furniture else None
    if shaped:  # as strings, like the tags they sit among
        ll = shaped[0] or ll
        props |= {'_bearing': f'{shaped[1]:.1f}', '_length': f'{shaped[2]:.1f}'}
    if MONUMENT_POINT(props):
        props |= monument_survey(*ll)
    pts.append({'type': 'Feature', 'properties': props, 'geometry': mapping(Point(ll))})
json.dump({'type': 'FeatureCollection', 'features': pts}, open(OUT / 'osm_points.geojson', 'w'), separators=(',', ':'))
cnt = lambda k, v=None: sum(1 for p in pts if (k in p['properties']) and (v is None or p['properties'][k] in v))
print(f'roads {len(roads)}, areas {len(areas)}, points {len(pts)}: trees {cnt("natural", ["tree"])}, '
      f'bars/pubs/cafes {cnt("amenity", ["bar", "pub", "cafe"])}, restaurants {cnt("amenity", ["restaurant", "fast_food"])}, '
      f'bike parkings {cnt("amenity", ["bicycle_parking"])}, historic {cnt("historic")}, tourism {cnt("tourism")}, '
      f'monuments on a GRB plinth {cnt("_width")}, with a LiDAR height {cnt("_height")}')

# --- Road surfaces ---------------------------------------------------------------------------------------------------
import build_road_zones  # tools/build_road_zones.py, beside this script

build_road_zones.main(DATA)

# --- Preview --------------------------------------------------------------------------------------------------------
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection, LineCollection

fig, ax = plt.subplots(figsize=(12, 12), dpi=130)
fig.patch.set_facecolor('#f4efe6')
ax.set_facecolor('#f4efe6')
for a in areas:
    t = a['properties']
    col = '#9cc9e6' if t.get('natural') == 'water' or 'waterway' in t else '#c8dcb0' if t.get('leisure') in ('park', 'garden') or t.get('landuse') in ('grass', 'forest', 'meadow', 'cemetery') else None
    g = shape(a['geometry'])
    if col and g.geom_type == 'Polygon':
        xs, ys = g.exterior.xy
        ax.fill([(x - ORIGIN[0]) * kx for x in xs], [(y - ORIGIN[1]) * kz for y in ys], color=col, lw=0, zorder=1)
segs, widths = [], []
for r in roads:
    hw = r['properties'].get('highway')
    if hw in ('primary', 'secondary', 'tertiary', 'residential', 'pedestrian', 'living_street', 'unclassified', 'trunk', 'cycleway'):
        segs.append([((x - ORIGIN[0]) * kx, (y - ORIGIN[1]) * kz) for x, y in r['geometry']['coordinates']])
        widths.append(2.2 if hw in ('primary', 'trunk', 'secondary') else 1.0)
ax.add_collection(LineCollection(segs, colors='#d9cfbf', linewidths=widths, zorder=2))
polys = [[(x, -z) for x, z in b['ring']] for b in local]
pc = PolyCollection(polys, array=np.clip([b['h'] for b in local], 0, 40), cmap='magma_r', linewidths=0, zorder=3)
ax.add_collection(pc)
cb = fig.colorbar(pc, ax=ax, shrink=0.6, pad=0.01)
cb.set_label('building height (m, DSM−DTM p90), capped at 40')
ax.set_aspect('equal')
rx, ry = RING.exterior.xy
ax.plot([(x - ORIGIN[0]) * kx for x in rx], [(y - ORIGIN[1]) * kz for y in ry], color='#3a6ea5', lw=1.2, ls='--', zorder=4)
for n, (lo, la, r) in HERO_ZONES.items():
    cx, cy = (lo - ORIGIN[0]) * kx, (la - ORIGIN[1]) * kz
    ax.add_patch(plt.Circle((cx, cy), r, fill=False, ec='#1f8a4c', lw=1.6, zorder=5))
    ax.text(cx + r * 0.75, cy + r * 0.75, n.split(' (')[0], fontsize=8, color='#1f8a4c', zorder=6)
ax.set_xlim(-1790, 1450)
ax.set_ylim(-2460, 1430)
ax.set_title('Leuven: R23 ring (dashed) + Heverlee — GRB footprints × DHMV II heights; green = hero zones', fontsize=12)
ax.set_xlabel('metres east of Grote Markt')
ax.set_ylabel('metres north of Grote Markt')
fig.text(0.01, 0.005, 'GRB & DHMV II © Digitaal Vlaanderen · © OpenStreetMap contributors (ODbL)', fontsize=7, color='#666')
fig.savefig(OUT / 'preview_heights.png', bbox_inches='tight', facecolor=fig.get_facecolor())
print('wrote', sorted(p.name for p in OUT.iterdir()))
