[out:json][timeout:180];
( way["waterway"](50.866,4.676,50.892,4.683); way["natural"="water"](50.866,4.676,50.892,4.683); relation["natural"="water"](50.866,4.676,50.892,4.683);
  way["leisure"~"park|garden|pitch|playground"](50.866,4.676,50.892,4.683); relation["leisure"~"park|garden"](50.866,4.676,50.892,4.683);
  way["landuse"](50.866,4.676,50.892,4.683); relation["landuse"](50.866,4.676,50.892,4.683);
  way["railway"](50.866,4.676,50.892,4.683); way["amenity"="parking"](50.866,4.676,50.892,4.683); way["place"="square"](50.866,4.676,50.892,4.683); way["area:highway"](50.866,4.676,50.892,4.683); );
out tags geom;
