"""Split the GRB road surface into carriageways, pavements and cycle tracks, and lay out road markings.

uv run --with numpy --with shapely python -I tools/build_road_zones.py data

The GRB road surface (WBN) runs from facade to facade. Its subdivision lines (WGO) mark the edge of the
carriageway ("rand van de rijbaan"), the edge of the zone for pedestrians and cyclists ("grens zone zwakke
weggebruiker") and unpaved strips. Noding them together cuts the surface into faces; the OSM ways running through a
face say what it is (a carriageway when a road runs along it, a cycle track when a cycleway does, else a pavement)
and what it's made of. Pavements are left out: the viewer draws the whole surface as pavement and lays these on
top. src/data/roads.ts turns the tags into the kinds the viewer paints.

Inputs (see data/README.md):
  grb/grb_WBN.geojson, grb/grb_WGO.geojson   GRB road surfaces and their subdivision lines (EPSG:4326)
  derived/osm_roads.geojson                  OSM ways (tools/build_leuven_data.py)
Output:
  derived/road_zones.json   local metres (origin Grote Markt, x = east, z = south), like leuven_buildings_local.json:
    faces:     {role, tags, ring}            carriageways and cycle tracks; role: car | pedestrian | cycle
    lines:     {kind, line}                  lane dividers (dashed or solid) and painted cycle lanes
    crossings: {tags, line}                  the part of each OSM crossing way that lies on a carriageway
"""
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import shapely
from shapely import STRtree
from shapely.geometry import LineString, Polygon, box, shape

DATA = Path(sys.argv[1] if len(sys.argv) > 1 else 'data')
ORIGIN = (4.70139, 50.87917)  # Grote Markt (lon, lat), as in build_leuven_data.py and src/data/projection.ts
KX, KZ = 111320 * math.cos(math.radians(ORIGIN[1])), 110574
SIMPLIFY = 0.5  # m; the faces stay a gapless coverage (shapely.coverage_simplify)
LANE = (2.6, 3.2, 3.6)  # narrowest, default and widest lane (m)
CYCLE_LANE = 1.5  # painted cycle lane width (m)
KEEP = ('highway', 'surface', 'service', 'cyclestreet', 'bicycle_road', 'surface:colour', 'crossing',
        'crossing:markings', 'footway', 'cycleway', 'name')
CAR = {'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
       'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service', 'busway', 'road'}
MAIN = {'motorway', 'trunk', 'primary', 'secondary'}


def local(g):
    return shapely.transform(g, lambda a: np.column_stack(((a[:, 0] - ORIGIN[0]) * KX, -(a[:, 1] - ORIGIN[1]) * KZ)))


def coords(line):
    return [[round(x, 1), round(z, 1)] for x, z in line.coords]


def is_crossing(t):
    return 'crossing' in (t.get('footway'), t.get('cycleway'), t.get('path')) or (
        t.get('highway') in ('footway', 'cycleway', 'path') and 'crossing' in t)


def role(t):
    """What a way says about the surface it runs on, or None when it says nothing."""
    h = t.get('highway')
    layer = t.get('layer', '0')
    if t.get('tunnel') in ('yes', 'building_passage') or (layer.lstrip('-').isdigit() and int(layer) < 0):
        return None
    if is_crossing(t):
        return None
    if h in CAR:
        return None if t.get('service') == 'driveway' else 'car'  # driveways cross pavements
    if h == 'pedestrian':
        return 'pedestrian'
    if h == 'cycleway' or (h in ('path', 'footway') and t.get('bicycle') == 'designated' and t.get('segregated') != 'yes'):
        return 'cycle'
    if h in ('footway', 'path', 'steps'):
        return 'foot'
    return None


def parts(g):
    return [p for p in getattr(g, 'geoms', [g]) if not p.is_empty]


def without_holes(poly):
    """Pieces of `poly` without holes (the format stores outer rings only): cut through each hole's centre."""
    if not poly.interiors:
        return [poly]
    hole = poly.interiors[0]
    cx = hole.centroid.x
    x0, z0, x1, z1 = poly.bounds
    out = []
    for half in (box(x0 - 1, z0 - 1, cx, z1 + 1), box(cx, z0 - 1, x1 + 1, z1 + 1)):
        for piece in parts(poly.intersection(half)):
            if piece.geom_type == 'Polygon' and piece.area > 0.01:
                out += without_holes(piece)
    return out


def lane_count(t):
    lanes = t.get('lanes', '')
    if lanes.isdigit() and int(lanes) > 0:
        return int(lanes)
    return 2 if t.get('highway') in MAIN else 0


def lane_layout(t, width):
    """Offsets of each lane divider (m, positive to the right of the way: z points south, so shapely's left is the
    real right) and whether it's solid, plus the centres of painted cycle lanes."""
    n = lane_count(t)
    oneway = t.get('oneway') in ('yes', '-1')
    flip = -1 if t.get('oneway') == '-1' else 1
    cyc = lambda side: t.get(f'cycleway:{side}') == 'lane' or t.get('cycleway:both') == 'lane' or (
        t.get('cycleway') == 'lane' and (side == 'right' or not oneway))
    sides = {'right': flip, 'left': -flip}
    cycle = [(width / 2 - CYCLE_LANE / 2) * sides[s] for s in sides if cyc(s)]
    if n < 2:
        return [], cycle
    lane = min(LANE[2], max(LANE[0], (width - CYCLE_LANE * len(cycle)) / n)) if width > 0 else LANE[1]
    # Cycle lanes on one side push the car lanes to the other.
    shift = -sum(math.copysign(CYCLE_LANE / 2, c) for c in cycle)
    backward = n // 2
    if not oneway and t.get('lanes:backward', '').isdigit():
        backward = int(t['lanes:backward'])
    # Counted from the left kerb: the dividers between lanes, the one between directions solid on wide roads.
    return [((i - n / 2) * lane + shift, not oneway and i == backward and n >= 4) for i in range(1, n)], cycle


def main():
    wbn_features = json.load(open(DATA / 'grb/grb_WBN.geojson'))['features']
    wbn = [local(shapely.make_valid(shape(f['geometry']))) for f in wbn_features]
    junction_zone = [f['properties'].get('TYPE') == 1 for f in wbn_features]  # "kruispuntzone"
    wgo = [local(shape(f['geometry'])) for f in json.load(open(DATA / 'grb/grb_WGO.geojson'))['features']]
    domain = shapely.union_all(wbn)

    noded = shapely.union_all(wgo + [p.boundary for p in wbn])
    faces = [f for f in parts(shapely.polygonize(parts(noded))) if domain.contains(f.representative_point())]
    wbn_tree = STRtree(wbn)
    junction = []
    for f in faces:
        hits = wbn_tree.query(f.representative_point(), predicate='within')
        junction.append(bool(len(hits)) and junction_zone[int(hits[0])])

    ways = []
    for feature in json.load(open(DATA / 'derived/osm_roads.geojson'))['features']:
        t = feature['properties']
        if feature['geometry']['type'] == 'LineString':
            ways.append((role(t), t, local(shape(feature['geometry']))))
    rated = [w for w in ways if w[0]]
    tree = STRtree([g for _, _, g in rated])

    # A face is what runs along it: roads beat footpaths, and at least a car's length of road has to.
    out_faces = []
    for f, at_junction in zip(faces, junction):
        score, best = defaultdict(float), {}
        for i in tree.query(f, predicate='intersects'):
            r, t, g = rated[int(i)]
            length = g.intersection(f).length
            score[r] += length
            if length > best.get(r, (0, None))[0]:
                best[r] = (length, int(i))
        if max(score['car'], score['pedestrian']) >= 1.5:
            r = 'car' if score['car'] >= score['pedestrian'] else 'pedestrian'
        elif score['cycle'] > score['foot']:
            r = 'cycle'
        else:
            r = 'side'
        way = best.get(r, (0, None))[1]
        out_faces.append({'role': r, 'junction': at_junction, 'way': way})

    # Neighbouring faces that src/data/roads.ts would paint alike merge (it reads role, highway and surface), so
    # fewer shared edges are stored. Then the whole coverage is simplified at once, so faces keep sharing edges.
    groups = defaultdict(list)
    for f, face in zip(out_faces, faces):
        t = rated[f['way']][1] if f['way'] is not None and f['role'] in ('car', 'pedestrian') else {}
        groups[(f['role'], t.get('highway'), t.get('surface'))].append((f, face))
    merged = []
    for members in groups.values():
        way = members[0][0]['way']
        union = shapely.union_all([face for _, face in members])
        merged += [({'role': members[0][0]['role'], 'way': way}, p) for p in parts(union) if p.geom_type == 'Polygon']
    simple = shapely.coverage_simplify(np.array([face for _, face in merged], dtype=object), SIMPLIFY)
    zones = []
    for (f, _), s in zip(merged, simple):
        if f['role'] == 'side':
            continue
        tags = rated[f['way']][1] if f['way'] is not None else {}
        for poly in parts(shapely.make_valid(s)):
            if poly.geom_type != 'Polygon':
                continue
            for piece in without_holes(poly):
                if piece.area >= 0.5:
                    zones.append({'role': f['role'], 'tags': {k: tags[k] for k in KEEP if k in tags},
                                  'ring': coords(piece.exterior)[:-1]})

    # Lane dividers and painted cycle lanes, per carriageway face along its road, kept off the kerbs.
    lines = []
    for f, face in zip(out_faces, faces):
        if f['role'] != 'car' or f['junction'] or f['way'] is None:
            continue
        _, t, way = rated[f['way']]
        along = way.intersection(face)
        if along.length < 4:
            continue
        width = face.area / along.length
        dividers, cycle = lane_layout(t, width)
        inner = face.buffer(-0.4)
        for offset, solid in dividers:
            for piece in parts(along):
                if piece.geom_type != 'LineString':
                    continue
                for line in parts(piece.offset_curve(offset).intersection(inner)):
                    if line.geom_type == 'LineString' and line.length >= 2:
                        lines.append({'kind': 'solid' if solid else 'dashed', 'line': coords(line)})
        for offset in cycle:
            for piece in parts(along):
                if piece.geom_type != 'LineString':
                    continue
                for line in parts(piece.offset_curve(offset).intersection(face.buffer(-0.2))):
                    if line.geom_type == 'LineString' and line.length >= 2:
                        lines.append({'kind': 'cycle-lane', 'line': coords(line)})

    # Crossings: the stretch of each crossing way that lies on a carriageway.
    carriageway = shapely.union_all([face for f, face in zip(out_faces, faces) if f['role'] == 'car'])
    crossings = []
    for _, t, g in ways:
        if not is_crossing(t):
            continue
        for piece in parts(g.intersection(carriageway)):
            if piece.geom_type == 'LineString' and piece.length >= 2:
                crossings.append({'tags': {k: t[k] for k in KEEP if k in t},
                                  'line': coords(LineString([piece.coords[0], piece.coords[-1]]))})

    out = DATA / 'derived/road_zones.json'
    json.dump({'attribution': 'GRB (c) Digitaal Vlaanderen; tags (c) OpenStreetMap contributors (ODbL)',
               'faces': zones, 'lines': lines, 'crossings': crossings}, open(out, 'w'), separators=(',', ':'))
    roles = defaultdict(int)
    for z in zones:
        roles[z['role']] += 1
    print(f'{len(zones)} faces {dict(roles)}, {len(lines)} lines, {len(crossings)} crossings -> {out}')


main()
