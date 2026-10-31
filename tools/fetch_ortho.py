"""Download the orthophoto tiles that cover the map area, for roof colours.

python3 -I tools/fetch_ortho.py data

Most recent winter mosaic from Digitaal Vlaanderen (WMTS layer omwrgbmrvl), zoom 18 (~0.37 m/px),
into data/ortho/z18/{x}_{y}.png; tiles already there are skipped. About 1000 tiles, 80 MB.
Licence: Modellicentie Gratis Hergebruik v1.0, "Bron: Luchtopnamen Digitaal Vlaanderen".
"""
import math
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ORIGIN = (4.70139, 50.87917)  # Grote Markt (lon, lat), as in build_leuven_data.py
# Keep in step with AREA in src/data/area.ts (local metres, x = east, z = south).
AREA = [(-1400, -1220, 1150, 1250), (-1500, 1250, 1450, 2000)]
MARGIN = 40
Z = 18
URL = ('https://geo.api.vlaanderen.be/OMWRGBMRVL/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0'
       '&LAYER=omwrgbmrvl&STYLE=&FORMAT=image/png&TILEMATRIXSET=GoogleMapsVL&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}')

kx, kz = 111320 * math.cos(math.radians(ORIGIN[1])), 110574


def tile(x, z):
    lon, lat = ORIGIN[0] + x / kx, ORIGIN[1] - z / kz
    n = 2 ** Z
    return int((lon + 180) / 360 * n), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)


tiles = set()
for x0, z0, x1, z1 in AREA:
    (tx0, ty0), (tx1, ty1) = tile(x0 - MARGIN, z0 - MARGIN), tile(x1 + MARGIN, z1 + MARGIN)
    tiles |= {(tx, ty) for tx in range(tx0, tx1 + 1) for ty in range(min(ty0, ty1), max(ty0, ty1) + 1)}

out = Path(sys.argv[1] if len(sys.argv) > 1 else 'data') / f'ortho/z{Z}'
out.mkdir(parents=True, exist_ok=True)


def fetch(t):
    path = out / f'{t[0]}_{t[1]}.png'
    if path.exists() and path.stat().st_size:
        return 0
    with urllib.request.urlopen(URL.format(z=Z, x=t[0], y=t[1]), timeout=30) as r:
        path.write_bytes(r.read())
    return 1


with ThreadPoolExecutor(6) as pool:
    fetched = sum(pool.map(fetch, sorted(tiles)))
print(f'{len(tiles)} tiles, {fetched} downloaded into {out}')
