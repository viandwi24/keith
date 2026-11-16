---
"@keith/plugin-maps": minor
"@keith/core": patch
---

Maps: routes between places by car, motorcycle (off toll roads), bike or foot (`maps_route`, FOSSGIS OSRM with Valhalla as the
fallback), places of a kind nearby (`maps_nearby`, Overpass with Photon and a mirror as fallbacks), typo-tolerant search (Photon when
Nominatim fails or finds nothing), and a map window in Keith's HUD style that draws the route and pins, shows a route panel (modes,
time, distance, arrival, average speed, stops, turn-by-turn steps that centre the map; the view zooms between levels so a route fills the free room beside or below the panel) and switches between dark, standard, mono,
satellite (EOX Sentinel-2), terrain, humanitarian and cycling styles with overzoom; the credit is a short line with the full text
behind ⓘ. All free, no key. A window label such as "Route: Surabaya" no longer counts as a URL for consent.
