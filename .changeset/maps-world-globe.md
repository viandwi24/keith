---
"@keith/plugin-maps": minor
"@keith/core": minor
"@keith/host": minor
"@keith/contracts": minor
---

Maps becomes a world view: a CesiumJS globe that morphs to a flat map without losing its state, dark (Esri, keyless), satellite and night
(Black Marble) styles, live data layers (aircraft from adsb.lol, ships from AISStream with a key, live buses and trains from GTFS-Realtime
feeds in Kuala Lumpur, Penang, Johor, Helsinki, Boston, the Netherlands and Brisbane, your own ADS-B receivers, satellites propagated
with SGP4, upcoming launches, earthquakes from USGS and BMKG, NASA EONET events, weather and air quality from Open-Meteo, NASA IMERG
rain, public traffic cameras with live snapshots and cameras mapped in OpenStreetMap, internet radio you can play, recent Sentinel-2
scenes), a detail card with Follow, and director mode (pins, lines and areas Keith and you both see). The agent reads any layer around
a place with `maps_explore`. Window apps may declare `gpu`, `media` and `live`, and a plugin may mount a library folder under its web
bundle (ADR-0040). Plugin settings come from `KEITH_PLUGIN_CONFIG`. `POST /plugins/mcp` offers the plugin operations to outside agents
over MCP, through the same guard.
