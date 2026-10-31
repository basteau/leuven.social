[out:json][timeout:180];
( node["natural"="tree"](50.857,4.676,50.866,4.722);
  nwr["amenity"~"pub|bar|cafe|restaurant|fast_food|university|library|theatre|cinema|bicycle_parking|bicycle_rental|fountain|bench|place_of_worship|townhall"](50.857,4.676,50.866,4.722);
  nwr["tourism"](50.857,4.676,50.866,4.722); nwr["historic"](50.857,4.676,50.866,4.722); nwr["man_made"~"tower|statue"](50.857,4.676,50.866,4.722); node["highway"~"street_lamp|traffic_signals|bus_stop"](50.857,4.676,50.866,4.722); );
out tags center;
