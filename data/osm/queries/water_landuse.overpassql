[out:json][timeout:180];
( way["waterway"](50.866,4.683,50.892,4.722); way["natural"="water"](50.866,4.683,50.892,4.722); relation["natural"="water"](50.866,4.683,50.892,4.722);
  way["leisure"~"park|garden|pitch|playground"](50.866,4.683,50.892,4.722); relation["leisure"~"park|garden"](50.866,4.683,50.892,4.722);
  way["landuse"](50.866,4.683,50.892,4.722); relation["landuse"](50.866,4.683,50.892,4.722);
  way["railway"](50.866,4.683,50.892,4.722); way["amenity"="parking"](50.866,4.683,50.892,4.722); way["place"="square"](50.866,4.683,50.892,4.722); way["area:highway"](50.866,4.683,50.892,4.722); );
out tags geom;
