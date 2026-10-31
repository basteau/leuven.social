# Leuven data sources and references

Checked 2026-10-31.

- **Verified** means the endpoint was called and returned real data (HTTP 200 with features, tiles or rasters).
- **Unverified** means the entry comes from search results or memory and was not tested.

Flemish services work natively in **EPSG:31370 (Belgian Lambert 72)**, and most also serve EPSG:4326 or 3857. Leuven's municipality code (NIS) is **24062**. Wikidata ID: **Q118958**.

Everything marked ✅ below has already been downloaded into [`../data`](../data) for the game extent.

---

## 0. Map extents

**Game extent** (the one used in `data/`):
- **lat 50.857–50.892, lon 4.676–4.722**, about 3.3 × 3.9 km. This covers the R23 ring with a buffer of about 150–400 m, plus Heverlee south to Kasteel Arenberg and Heverlee station.
- In Lambert 72: X 171,600–174,900, Y 171,800–175,800.

**R23 ring**, computed from the 183 OSM ways tagged `ref=R23`: S 50.8683, W 4.6821, N 50.8898, E 4.7161.
- Segment names, useful for street signs: Tervuursevest, Rennes-Singel, Geldenaaksevest, Tiensevest, Den Boschsingel, Lüdenscheidsingel, Diestsevest, Naamsevest, Joanna-Maria Artoisplein, plus the Voerviaduct and the Oostertunnel.

**Prototype core box** (Grote Markt + Oude Markt): 50.8755, 4.6960 – 50.8820, 4.7080.

---

## 1. Building footprints and heights

### 1a. GRB (Grootschalig Referentiebestand), Digitaal Vlaanderen: best for footprints ✅
- **What it is:** the official large-scale base map, surveyed to cm accuracy and updated continuously (version date 2026-10-30).
- **Licence:** open data, free reuse. Attribution required: *"Bron: Grootschalig Referentie Bestand Vlaanderen, Digitaal Vlaanderen"*.
  - Terms: https://www.vlaanderen.be/digitaal-vlaanderen/onze-oplossingen/geografische-webdiensten/gebruiksrecht-en-privacyverklaring-geografische-webdiensten
- **WFS (verified, GeoServer, GeoJSON output):** `https://geo.api.vlaanderen.be/GRB/wfs`
- **Layers:**
  - `GRB:GBG` – buildings on the ground
  - `GRB:GBA` – building annexes
  - `GRB:WBN` – road surfaces
  - `GRB:WGO` – road subdivisions
  - `GRB:WGA` – road appurtenances
  - `GRB:TRN` – terrain
  - `GRB:WTZ` – watercourses
  - `GRB:SBN` / `GRB:WRL` – railway
  - `GRB:KNW` – bridges and structures
  - `GRB:Wegsegment`, `GRB:Adres`
- **Attributes:** `OIDN`, `UIDN`, `TYPE`, `LBLTYPE` (e.g. "hoofdgebouw"). **There is no height attribute.**
- **Paging:** the server caps each request at 10,000 matches, so page with `startIndex`.
  ```
  https://geo.api.vlaanderen.be/GRB/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=GRB:GBG&outputFormat=application/json&srsName=EPSG:4326&bbox=50.857,4.676,50.892,4.722,urn:ogc:def:crs:EPSG::4326&count=2500&startIndex=0&sortBy=OIDN
  ```
  - Pages of 2,500 were reliable. Pages of 5,000 sometimes returned a 504 from the Azure gateway.
- **Bulk download (GRBgis):** https://download.vlaanderen.be/Producten/Detail?id=1&title=GRBgis. Shapefile or GML per municipality; requires login.
- **WMTS basemap:** `https://geo.api.vlaanderen.be/GRB/wmts`, layers `grb_bsk`, `grb_bsk_grijs`, `grb_sel`.

### 1b. 3D GRB: building LOD1 from DHMV II, for heights
- **Product page:** https://www.vlaanderen.be/digitaal-vlaanderen/onze-diensten-en-platformen/basiskaart-vlaanderen-grb/3d-grb
- **Content:** LOD1 blocks of GRB buildings, with heights from DHMV II LiDAR (2013–2015) linked to GRB as of spring 2016.
- **LOD:** **only LOD1 exists.** No LOD2, CityGML or 3D Tiles product was found; LOD2 is described as a possible future step.
- **Formats:** KML (1 × 1 km tiles) or Shapefile POLYGON ZM, via download.vlaanderen.be (requires login).
  - Catalogue: https://www.vlaanderen.be/datavindplaats/catalogus/3d-grb-0
- **WMS (verified):** `https://geo.api.vlaanderen.be/3DGRB/wms`, layer `GRBGEBL1D2`. There is no WFS.
  - `GetFeatureInfo` with `INFO_FORMAT=application/geo+json` returns, for example:
    ```
    GRB_OIDN=2874928, HN_MAX=18.96, HN_P99=18.88, H_DTM_GEM=27.27, H_DSM_MAX=46.23
    ```
  - Join `GRB_OIDN` to the `OIDN` of `GRB:GBG`.
- **What we did instead:** computed heights ourselves from DSM − DTM inside each GRB footprint. This gives the same idea as 3D GRB without the login, and it is in `data/derived/`.

### 1c. OpenStreetMap ✅
- **Licence:** ODbL. Attribution: "© OpenStreetMap contributors". Derived databases must stay share-alike.
- **Access:** Overpass, `https://overpass-api.de/api/interpreter`.
  - On 2026-10-31 it was slow and returned 429/502/504.
  - Mirrors that worked: `maps.mail.ru/osm/tools/overpass`, `overpass.private.coffee`.
  - Tile large boxes into smaller requests.
  - Geofabrik Belgium extract + osmium is the robust alternative.
- **Tag coverage in the core box** (1,651 buildings):

  | Tag | Count | Share |
  |---|---|---|
  | `building:levels` | 193 | ≈12% |
  | `height` | 8 | ≈0.5% |
  | `roof:shape` | 91 | ≈5.5% |
  | `building:part` | 118 | — |
  | `natural=tree` nodes | 441 | — |

  - Footprints are good because Belgian OSM imported GRB. **Heights are poor, so use LiDAR.**
  - Across the whole game extent, 797 buildings are tagged `roof:shape=gabled`, 192 `flat` and 90 `hipped`. The other ~19.8k have no roof tag.
- **Queries used** are in [`../data/osm/queries`](../data/osm/queries). The R23 ring query: `way["ref"="R23"](50.86,4.675,50.898,4.73); out geom;`

### 1d. Overture Maps buildings
- Release `2026-10-21.0` (verified via https://stac.overturemaps.org/catalog.json). GeoParquet at `s3://overturemaps-us-west-2/release/2026-10-21.0/theme=buildings/type=building/*`.
- DuckDB query for our extent:
  ```sql
  INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs;
  SELECT id, height, num_floors, roof_shape, ST_AsGeoJSON(geometry)
  FROM read_parquet('s3://overturemaps-us-west-2/release/2026-10-21.0/theme=buildings/type=building/*', hive_partitioning=1)
  WHERE bbox.xmin > 4.676 AND bbox.xmax < 4.722 AND bbox.ymin > 50.857 AND bbox.ymax < 50.892;
  ```
- Mostly OSM/GRB-derived in Flanders, so it adds little.

### 1e. Microsoft and Google footprints
- Microsoft Global ML Building Footprints covers Belgium (index: `https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv`), but GRB is far better.
- Google Open Buildings does not cover Europe.

---

## 2. Elevation ✅

### DHMV II (Digitaal Hoogtemodel Vlaanderen II)
- LiDAR flown 2013–2015, 1 m DTM and DSM, Float32, nodata −9999, heights in m TAW. Free, with attribution to Digitaal Vlaanderen.
- **WCS (verified):** `https://geo.api.vlaanderen.be/DHMV/wcs`
- **Coverages:**
  - `DHMVII_DTM_1m`
  - `DHMVII_DSM_1m`
  - `DHMV_II_HILL_25cm` (multidirectional hillshade)
  - `DHMV_II_SVF_25cm` (sky-view factor)
  - `DHMVI_DTM_5m`
- **Use WCS 1.0.0 for a plain GeoTIFF:**
  ```
  https://geo.api.vlaanderen.be/DHMV/wcs?service=WCS&version=1.0.0&request=GetCoverage&coverage=DHMVII_DTM_1m&crs=EPSG:31370&bbox=171600,171800,173250,172800&width=1650&height=1000&format=GeoTIFF
  ```
  - ⚠️ Requests of about 3000×2600 px fail with an ArcGIS "http.400" error. 1650×1000 tiles work.
- **INSPIRE alternatives:** `https://geo.api.vlaanderen.be/el-dtm/wcs` and `…/el-dsm/wcs`.
- **Uses:**
  - Terrain: the Dijle valley sits at about 20 m TAW, and Keizersberg, Gasthuisberg and Kessel-Lo are higher. The extent's DTM range is 11.3–76.8 m TAW.
  - nDSM (DSM − DTM): building and tree heights.
  - Hillshade: a stylised ground texture.

### Copernicus DEM GLO-30
- https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N50_00_E004_00_DEM/Copernicus_DSM_COG_10_N50_00_E004_00_DEM.tif
- Only useful as a regional backdrop.

---

## 3. Imagery, historic maps and 3D meshes

### Orthophotos
- **Most recent winter mosaic, WMTS (verified):** `https://geo.api.vlaanderen.be/OMWRGBMRVL/wmts`, layer `omwrgbmrvl`.
  ```
  https://geo.api.vlaanderen.be/OMWRGBMRVL/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=omwrgbmrvl&STYLE=&FORMAT=image/png&TILEMATRIXSET=GoogleMapsVL&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}
  ```
  - z17 x=67247 y=43949 is the Grote Markt tile.
- **Yearly archive:** `https://geo.api.vlaanderen.be/omw/wmts`, layers `omwrgb12vl` … `omwrgb25vl`.
- Use them to colour-pick roofs and ground, and to trace squares.

### Historic maps
- WMS `https://geo.api.vlaanderen.be/HISTCART/wms` and WMTS `https://geo.api.vlaanderen.be/HISTCART/wmts`.
- **Layers:**
  - `ferraris` (1777)
  - `popp` (1842–79)
  - `vandermaelen` (1846–54)
  - `abw` (Atlas der Buurtwegen, ~1840)
  - `frickx` (1712)
  - `Villaret` (1745–48)
  - `Masse` (1729–30)
  - `pourbus` (1571)
- Good for an "old Leuven" mode or a parchment-style in-game map.

### Sketchfab
- **Fonske (Jef Claerhout)** by mneuville: **CC-BY, downloadable**, about 893k faces, so decimate it. https://sketchfab.com/3d-models/77718a1606a142d7a97d2c6f90a1ccdc
- **Not downloadable:**
  - "Leuven_Toren_2" and "Leuven 4" (Mapix photogrammetry)
  - Justus Lipsius statue
  - Mariabeeld
- **No Sketchfab models found** of the Stadhuis, University Library, Sint-Pieterskerk or Begijnhof. **Plan to hand-model these as low-poly.**

### Other 3D sources
- Materialise 3D-printed the Stadhuis from scans, but the scan is not public: https://www.materialise.com/en/blog/sustainable-3d-printed-model-Leuven-town-hall
- RenderHub sells a commercial "Cityscape Leuven" model (unverified).
- Google Photorealistic 3D Tiles: reference only. Its terms forbid extraction.

---

## 4. City of Leuven open data
- **No public city open-data catalogue was found.**
  - `opendata.leuven.be`, `data.leuven.be` and `geo.leuven.be` do not resolve.
  - The Stad Leuven ArcGIS hub is empty.
  - Urban Sense (https://www.leuven.be/urbansense) has no public catalogue. Contact: smartcity@leuven.be.
- **Statistics:** https://leuven.be/cijfers
- **Substitutes:**
  - OSM: trees, cafés, bike parking, benches, fountains. These are already in `data/derived/osm_points.geojson`: 3,839 trees, 175 bars/pubs/cafés, 349 restaurants and fast-food places, 1,911 bike parkings.
  - **Telraam:** a citizen traffic-counting project that started in Leuven. Live per-street counts of cars, bikes and pedestrians. https://telraam.net, API https://telraam-api.net
  - Flemish catalogue https://metadata.vlaanderen.be: road signs, the "kotlabel" (student-housing quality label), UNESCO béguinage zones.
  - Heritage inventory: https://inventaris.onroerenderfgoed.be/erfgoedobjecten?gemeente=Leuven (descriptions and photos of listed buildings).

---

## 5. Public transport and bike sharing
- **De Lijn**
  - Portal: https://data.delijn.be/ (free API key).
  - GTFS: `https://api.delijn.be/gtfs/static/v3/gtfs_transit.zip`, which needs the `Ocp-Apim-Subscription-Key` header.
  - Keyless mirror (verified): `https://files.mobilitydatabase.org/mdb-3544/latest.zip` (~186 MB, all of Flanders).
- **NMBS/SNCB:** GTFS at `https://gtfs.irail.be/nmbs/gtfs/latest.zip` (verified, ~44 MB). Mirror: `https://files.mobilitydatabase.org/mdb-686/latest.zip`.
- **Blue-bike GBFS 2.3 (verified):** `https://api.delijn.be/gbfs/gbfs.json` (use GET; HEAD returns 404). 54 stations in the Leuven area, for example:
  - Station Tiensevest (50.87980, 4.71594, cap 148)
  - Kop van Kessel-Lo (50.88249, 4.71664)
  - Rector de Somerplein (50.87911, 4.70280)
  - Parking Vaartkom (50.88867, 4.70215)
  - **Heverlee Station** (50.86262, 4.69544)
- **Getaround Leuven** (car sharing) GBFS: `https://getaround.com/gbfs/v3/leuven/gbfs`

---

## 6. Wikimedia Commons and Wikidata
- **Commons categories:**
  - https://commons.wikimedia.org/wiki/Category:Leuven (subcategories: Heverlee, Kessel-Lo, Squares, Buildings, Streets, Giants of Leuven, Quality images…)
  - https://commons.wikimedia.org/wiki/Category:Town_hall_of_Leuven
  - https://commons.wikimedia.org/wiki/Category:Oude_Markt_(Leuven)
- **Wikidata SPARQL** (https://query.wikidata.org/sparql, send a User-Agent):
  ```sparql
  SELECT ?item ?itemLabel ?coord ?commons WHERE {
    ?item wdt:P131* wd:Q118958; wdt:P625 ?coord.
    OPTIONAL { ?item wdt:P373 ?commons }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "nl,en". } }
  ```

---

## 7. Digital twins and 3D datasets
- No public 3D city model or digital twin of Leuven was found. Digitaal Vlaanderen does run DUET and smart-data-space use cases: https://www.vlaanderen.be/vlaamse-smart-data-space-portaal/use-cases/digital-twin
- The closest thing to a Flemish 3D BAG is **3D GRB LOD1 + DHMV II**.
- To get real LOD2 roofs, run **roofer** (3D BAG) on DHMV II point clouds plus GRB footprints.

---

## 8. Flavour and landmark POIs

### Facts
Figures are approximate.
- **KU Leuven:** founded 1425, so 2025 was its 600th anniversary. Between about 50,000 and 64,500 students, depending on how they are counted.
- **Oude Markt:** "the longest bar in Europe" (a nickname). About 30–40 cafés wall to wall on a square of roughly 174 × 35 m.
- **Stella Artois:** the Brouwerij Artois (AB InBev) brewery sits north-east of the centre near the Vaartkom, the old canal basin that is being redeveloped.
- **Groot Begijnhof:** part of the UNESCO "Flemish Béguinages" listing.
- **Fonske** (Fons Sapientiae): a student pouring wisdom (beer) into his head.
- **Dijle:** runs south to north through the centre, partly vaulted over.
- **R23:** follows the line of the 14th-century second city wall.
- **Districts:** Centrum, Kessel-Lo (east), Heverlee (south: Arenberg castle and campus, Park Abbey), Wilsele and Wijgmaal (north), Gasthuisberg (west, hospital).

### Landmark coordinates
Coordinates come from Wikidata P625.

| # | POI | Wikidata | Lat | Lon |
|---|---|---|---|---|
| 1 | Stadhuis (Town Hall) | Q940882 | 50.87889 | 4.70111 |
| 2 | Sint-Pieterskerk | Q17722 | 50.87944 | 4.70111 |
| 3 | Grote Markt | Q4766627 | 50.87917 | 4.70139 |
| 4 | Fonske | Q2107804 | 50.87917 | 4.70194 |
| 5 | Oude Markt | Q2792167 | 50.87806 | 4.69944 |
| 6 | Universiteitshal | Q1959442 | 50.87806 | 4.70028 |
| 7 | University Library & tower | Q139854572 | 50.87801 | 4.70741 |
| 8 | Ladeuzeplein | Q6469401 | 50.87852 | 4.70647 |
| 9 | M Leuven | Q2362660 | 50.87889 | 4.70444 |
| 10 | Groot Begijnhof | Q1049301 | 50.87167 | 4.69694 |
| 11 | Kasteel van Arenberg (Heverlee) | Q1522076 | 50.86333 | 4.68306 |
| 12 | Leuven station | Q801090 | 50.88083 | 4.71611 |
| 13 | Martelarenplein | Q2658903 | 50.88111 | 4.71500 |
| 14 | Brouwerij Artois | Q2523485 | 50.8871 | 4.7114 |
| 15 | Vaartkom | Q1944313 | 50.88889 | 4.70000 |
| 16 | Sint-Michielskerk | Q1502706 | 50.87611 | 4.70056 |
| 17 | Kruidtuin | Q2565202 | 50.8779 | 4.6901 |
| 18 | Sint-Donatuspark | Q2663022 | 50.87555 | 4.70291 |
| 19 | Herbert Hooverplein | Q2933341 | 50.87750 | 4.70639 |
| 20 | Keizersberg | Q122944371 | 50.88790 | 4.69466 |
| 21 | Abdij van 't Park | Q476178 | 50.86444 | 4.71806 |
| 22 | Klein Begijnhof | Q2491406 | 50.88500 | 4.69889 |
| 23 | Sint-Geertruiabdij | Q29586827 | 50.88396 | 4.69934 |
| 24 | Sint-Jacobskerk | Q18380032 | 50.88050 | 4.69108 |
| 25 | Gasthuisberg (UZ Leuven) | Q2500722 | 50.87921 | 4.67374 |

Notes:
- Gasthuisberg (25) lies just west of the game extent.
- Abdij van 't Park (21) is just inside the south-east corner.
