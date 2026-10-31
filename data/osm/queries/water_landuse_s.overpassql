[out:json][timeout:180];
( way["waterway"](50.857,4.676,50.866,4.722); way["natural"="water"](50.857,4.676,50.866,4.722); relation["natural"="water"](50.857,4.676,50.866,4.722);
  way["leisure"~"park|garden|pitch|playground"](50.857,4.676,50.866,4.722); relation["leisure"~"park|garden"](50.857,4.676,50.866,4.722);
  way["landuse"](50.857,4.676,50.866,4.722); relation["landuse"](50.857,4.676,50.866,4.722);
  way["railway"](50.857,4.676,50.866,4.722); way["amenity"="parking"](50.857,4.676,50.866,4.722); way["place"="square"](50.857,4.676,50.866,4.722); way["area:highway"](50.857,4.676,50.866,4.722); );
out tags geom;
