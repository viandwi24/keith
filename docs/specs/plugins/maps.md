# Maps (plugin)

Code: `plugins/maps` (`plugin.ts`, `upstream.ts`, `search.ts`, `route.ts`, `nearby.ts`, `geo.ts`; data layers in `layers/`: `types.ts`,
`index.ts`, `flights.ts`, `vessels.ts`, `transit.ts`, `space.ts`, `events.ts`, `weather.ts`, `cameras.ts`, `radio.ts`, `imagery.ts`; the
page in `web/`: `map.html`, `boot.js`, `map.js`, `globe.js`, `features.js`, `data.js`, `catalog.js`, `layer-panel.js`, `card.js`,
`draw.js`, `icons.js`, `overlay.js`, `panel.js`, `layers.js`, `styles.js`, `params.js`, `tiles.js`, `calls.js`, `map.css`).
Tests: `plugins/maps/maps.test.ts` (search, the window contribution, `layers` and `explore` through the host kit, fake fetch),
`plugins/maps/route.test.ts` (route, nearby, request spacing, geometry), `plugins/maps/tiles.test.ts` (Web Mercator and camera math, styles,
params and marks, fitting, the page's reading of layer answers, motion between answers), `plugins/maps/panel.test.ts` (the route panel),
`plugins/maps/layers/layers.test.ts` (every source's mapping, GTFS-Realtime decoding, AIS folding, per-layer answers).
ADRs: `docs/decisions/0038-extension-points-and-plugin-window-apps.md`, `docs/decisions/0040-gpu-window-apps-and-live-layers.md`. Plan:
`docs/plans/active/P40-workspace.md` (P40.5). Contracts it relies on: `../plugins.md` (operations, guard, config, MCP), `../thalamus.md`
("Plugin web bundles", "Plugin net route"), `packages/contracts/src/web-apps.ts` (window apps, bridge).

## Purpose

Find places, routes and places nearby on free OpenStreetMap services, and show them in a window of the web workspace. "Where is
Surabaya?" is a `maps_search` call followed by opening `maps:map` on the result; "route from Tunjungan Plaza to Gubeng station by
motorbike" is one `maps_route` call (it looks the names up itself) and a `maps:map` window with the route in its params; "an ATM near
here" is `maps_nearby` and a window with the places as pins. "What is flying over Jakarta?", "cameras near Tunjungan Plaza" or "quakes
today" is `maps_explore` with a layer and a place, and a `maps:map` window with that layer on.

## Manifest

`createMapsPlugin({ fetch?, minGapMs?, socket? })` builds the plugin (tests inject `fetch`, `minGapMs: 0` and a fake AIS socket); the
default export uses the global `fetch`, 1 s and `WebSocket`. Id `maps`, version `0.3.0`, `apiVersion` = `PLUGIN_API_VERSION`,
`web: { dir: <plugin>/web, mounts: { 'vendor/cesium': <node_modules/cesium>/Build/Cesium } }` (`CESIUM_DIR`, resolved from the installed
package; CesiumJS 1.147.0 from the catalog). No tables, no permissions of its own. `config` is `MapsConfig` (`layers/types.ts`), filled
from `KEITH_PLUGIN_CONFIG` `{ "maps": { … } }`:

| Setting | What it turns on |
| --- | --- |
| `aisstreamKey` (8..200 chars) | the Ships layer (a free key from aisstream.io) |
| `receivers` (at most 8 URLs, http or https) | the My receivers layer: readsb / dump1090 `aircraft.json` of the owner's own SDR receivers |

## Upstreams

Every service is free and needs no key. Their public instances are run by volunteers and ask for light use; Keith's use (one person's
questions) stays far below their limits.

| Need | First | Then | Then |
| --- | --- | --- | --- |
| Geocoding (`search`, names in `route` and `nearby`) | Nominatim `nominatim.openstreetmap.org/search` | Photon `photon.komoot.io/api/` (tolerant of typos) | |
| Routing, car, bike, foot | FOSSGIS OSRM `routing.openstreetmap.de/routed-<car|bike|foot>/route/v1/driving/…` | FOSSGIS Valhalla `valhalla1.openstreetmap.de/route` | |
| Routing, motorcycle | FOSSGIS Valhalla (costing `motorcycle`, `use_highways: 0`: motorbikes may not use toll roads in Indonesia) | OSRM car route, said in `note` | |
| Places nearby | Overpass API `overpass-api.de/api/interpreter` | Photon `photon.komoot.io/reverse` with `osm_tag` filters (no opening hours) | Overpass mirror `overpass.kumi.systems` |
| Tiles (window) | Esri Canvas dark and light gray basemaps and their label layers (keyless; CARTO's basemaps ask for a key since 2026), EOX Sentinel-2 cloudless 2024 (satellite; free for non-commercial use, with credit), NASA GIBS VIIRS Black Marble (night), OSM standard, OpenTopoMap, HOT (OSM France), CyclOSM, through the core's net route | | |
| Data layers | see "Data layers" | | |

- **Requests** (`createUpstream`, `upstream.ts`): `User-Agent: keith-maps/0.2 (self-hosted personal agent)` (the software only: never a
  person, an address, an instance or a contact), `Accept: application/json`, `redirect: 'error'`, `credentials: 'omit'`, a timeout (8 s;
  5 s for geocoding; 8 s for each Overpass instance, because on some networks Overpass hosts never answer and the next try should come
  soon) and the call's abort signal. At most one request a second per host (`minGapMs`): a call waits for its host's next slot; a call
  that would wait more than 10 s is refused as busy. A `POST` (Valhalla JSON, Overpass form) carries its content type.
- **Fallback** (`firstOf`): the services are tried in order; a timeout, an unreachable host, HTTP 429 (busy), another HTTP error or an
  unreadable answer passes to the next. A definite answer stops at once: "no route found between these places" (OSRM `NoRoute`, Valhalla
  HTTP 400) and "no place found for …". Geocoding also passes to Photon when Nominatim finds nothing. When every service fails, the first
  failure is told: `<what> did not answer in time; try again`, `could not be reached; try again`, `is busy (rate limited); try again in a
  minute`, `failed (HTTP <status>)`, `gave an unreadable answer`, with `<what>` one of "the map search", "the route service", "the place
  search" (`OperationError('CONFLICT', …)`, safe to show).
- The plugin uses its own `fetch`, not the core's net proxy: these answers describe the person's places and routes, and the net proxy
  keeps what it fetches on disk.
- The positions and names of a route or a search go to the service that answers (FOSSGIS, OSM, komoot); the services log requests. The
  hosts are fixed in code, so a call cannot send anything to a host a page chose.

## Operations

All five are `authenticated`, `risk: read` (consent effect `none`: never asked), `source: outside` (names, streets, opening hours, labels
and facts come from public sources: anyone can have written them). `layers` is for the window only (`expose.ai: false`).

| Operation (tool) | Input -> output | Limit |
| --- | --- | --- |
| `search` (`maps_search`) | `{ query: 1..200 chars, limit?: 1..5 (default 5) }` -> `{ results: { name, lat, lon, bbox?: [south, north, west, east], kind? }[], source: 'nominatim' \| 'photon' }` | 30 a minute |
| `route` (`maps_route`) | `{ from, to, via?: at most 3, mode?: car \| motorcycle \| bike \| foot (default car), geometry?: boolean }`, each place a name (1..200 chars) or `{ lat, lon }` -> `{ from, to, via?, mode, provider: 'osrm' \| 'valhalla', distanceM, durationS, summary, steps: { text, distanceM }[], bbox, note?, geometry? }` | 20 a minute |
| `nearby` (`maps_nearby`) | `{ near: name or { lat, lon }, kind?: a category, tag?: { key, value? }, radius?: 50..5000 m (default 1000), limit?: 1..20 (default 10) }`, a kind or a tag required -> `{ center, results: { name, lat, lon, kind?, distanceM, address?, openingHours? }[], source: 'overpass' \| 'photon' }` | 20 a minute |
| `layers` (window only) | `{ ids: 1..8 layer ids, bbox: [south, north, west, east], zoom: 0..22 }` -> `{ layers: LayerAnswer[] }` ("Data layers") | 90 a minute |
| `explore` (`maps_explore`) | `{ layer, near: name or { lat, lon }, radiusKm?: 0.2..2000 (default 25), limit?: 1..50 (default 15) }` -> `{ layer, center, zoom, total, items: { label, kind?, lat, lon, distanceKm, info?, snapshot?, playable? }[], note? }` | 20 a minute |

- **Search mapping.** Nominatim: `name` is `display_name` (else `name`), trimmed and clipped to 200 characters; `lat`/`lon` parsed numbers in
  range; `bbox` its `boundingbox` when it has four numbers; `kind` `addresstype` (else `type`), at most 40 characters. Photon: `name` joins
  name, street and house number, district, city, county, state and country without repeats; `bbox` from `extent` (`[west, north, east,
  south]`); `kind` `osm_value`. A row without a usable position or name is dropped; at most `limit` results.
- **Route.** A place name becomes the first search result (with its `name`); a position stays as given. OSRM is asked with
  `overview=full&geometries=geojson&steps=true` and gives maneuvers, which `osrmStepText` turns into English lines ("Turn left onto
  Jalan Basuki Rahmat", "At the roundabout take exit 2 onto …"; the arrival of a middle leg is dropped). Valhalla is asked with a JSON
  body (`locations`, `costing` `auto`/`motorcycle`/`bicycle`/`pedestrian`, kilometres, `en-US`) and gives its own instructions; its
  polyline6 shape is decoded. `summary` is "5.1 km, 6 min"; at most 30 steps (the rest joined into "N more steps, then: <last>");
  `bbox` covers the line. With `geometry` each step also has `at` (`[lat, lon]` of its maneuver: OSRM `maneuver.location`, Valhalla
`begin_shape_index` into the leg's shape), so the window can centre on a step; a chat answer has no `at`. `geometry` (`[lat, lon]` points, 5 decimals, Douglas-Peucker down to at most 1500 points) is sent only when
  asked: the window asks, a chat answer does not need it.
- **Nearby.** Categories: pharmacy, hospital, clinic, atm, bank, fuel, ev_charging, restaurant, cafe, fast_food, supermarket, convenience,
  mall, market, mosque, church, place_of_worship, hotel, parking, police, school, university, toilets, bus_stop, train_station, park,
  attraction. Each is a fixed set of Overpass tag filters (`CATEGORIES`) and Photon `osm_tag`s (`PHOTON_TAGS`; a mosque or a church is any
  place of worship there). A `tag` key matches `^[a-z][a-z0-9_:]{0,39}$` and a value `^[A-Za-z0-9_ :;.-]{1,60}$`, so no quote or bracket
  reaches the query. Overpass: `[out:json][timeout:15];(nwr<filter>(around:<r>,<lat>,<lon>);…);out center tags 100;` as a form POST.
  Results are sorted by distance and cut to `limit`; an unnamed place takes its brand, else its kind, as the name.

## Data layers

`web/catalog.js` lists the layers (shared by the page and the plugin): id, title, group, glyph, colour, `refreshS` (how often the window
asks again), `minZoom` (below it the layer answers `note: 'zoom in to <n> to see it'` and fetches nothing), `world` (one answer for the
globe, not asked again on a move), `needs` (a setting). Each has one provider (`layers/index.ts`, `createProviders`) that fetches its source
with the plugin's upstream (generic User-Agent, one request a second per host) and keeps a short cache.

| Layer | Source (keyless unless said) | Notes |
| --- | --- | --- |
| `flights` | adsb.lol `/v2/point/<lat>/<lon>/<nm>` (ODbL), readsb JSON | at most 250 nm around the view's centre, 1500 aircraft, fixes older than 60 s dropped; kind `airborne`, `ground`, `military` (dbFlags bit 1) |
| `vessels` | AISStream.io websocket (`aisstreamKey`) | one socket follows the last view (subscription replaced on a move, two boxes across the antimeridian), ships kept 15 min, closed after 2 min unasked |
| `transit` | GTFS-Realtime vehicle positions: data.gov.my (Rapid KL, MRT feeder, Rapid Penang, myBAS Johor), HSL, MBTA, OVapi, TransLink SEQ | a feed is asked only when the view overlaps its region, every 15 s at most; decoded by a small protobuf reader (`fieldsOf`, `decodeVehicles`) |
| `receivers` | the `receivers` URLs | each `aircraft.json` in turn; a failing one is skipped and noted |
| `satellites` | CelesTrak GP (OMM JSON) groups stations, visual, weather, gps-ops, resource | elements kept 6 h; SGP4 (satellite.js) gives a track every 30 s from −1 to +10 min that the page follows |
| `launches` | Launch Library 2 upcoming (20) | kept 30 min, at the pad |
| `quakes` | USGS 2.5_day GeoJSON and BMKG `gempaterkini.json` | `size` = magnitude; BMKG's tsunami line is kept; one source failing is a note |
| `events` | NASA EONET v3 open events, 30 days | the last point is the place; a storm's points are its `line` |
| `weather` | Open-Meteo forecast `current` on a 6×4 grid over the view | temperature as `value`, the weather code as text, wind as an arrow (`heading` where it blows to) |
| `air` | Open-Meteo air quality `us_aqi`, `pm2_5`, `pm10` on the same grid | kind is the AQI band |
| `rain` | NASA GIBS `IMERG_Precipitation_Rate` (yesterday, UTC: recent hours are not published) | a raster: `{ template: '../net/gibs…/{z}/{y}/{x}.png', maxZoom: 6 }` |
| `cameras` | TfL JamCams, LTA Singapore, HK Transport Department (XML), Fintraffic weather cameras; OpenStreetMap `man_made=surveillance` (Overpass, zoom 13 and closer) | lists kept 10 min and asked only when the view overlaps their region; snapshots as `image: '../net/<host>/<path>'` |
| `radio` | Radio Browser `stations/search` with `geo_*` (de1, then de2) | https streams only, no HLS, one per name and URL, most listened first |
| `imagery` | Element 84 Earth Search STAC, `sentinel-2-l2a`, 45 days | the newest scene under 40 % cloud per tile, at most 8, draped by its `rect` with its `preview.jpg` through the net route |

- **Answers** (`LayerAnswer`): `{ id, features, raster?, note?, error?, at }`. A feature is `{ id, lat, lon, alt?, heading?, speed?, label?,
  kind?, size?, value?, info?, image?, stream?, line?, track?, rect?, at? }` (`layers/types.ts`). An image is only ever a net route path
  (`netPath`: https, plain path characters, no query); a stream only https. A source that fails is that layer's `error` (the `failure`
  wording, with the layer's credit), never the call's.
- **`explore`** resolves `near`, asks the layer for a box of `radiusKm` around it (at the layer's `minZoom` at least), keeps what lies within
  the radius, nearest first, and returns `zoom` for a window that shows the radius. A layer's `error` is a `CONFLICT`. Images and streams
  are not returned, only `snapshot: true` and `playable: true`: the agent opens the window to show them.

## Window app `maps:map`

Contributed to `web.window` (validated by `WindowAppContributionSchema`):

| Field | Value |
| --- | --- |
| `id`, `title`, `icon` | `map`, `World`, `◍` |
| `params` | `{ lat, lon, zoom: 1..19, fractional (default 13), label?: <= 80 chars, style?: dark \| satellite \| night \| standard \| mono \| topo \| humanitarian \| cycle (default dark), view?: 3d \| 2d (default 3d), layers?: <= 8 layer ids, route?: { from, to, via?: <= 3, mode? }, places?: <= 20, marks?: <= 12 { kind: pin \| line \| area, points: [lat, lon][], label?: <= 40, color?: indigo \| red \| amber \| green \| cyan \| white } with at most 40 points in all, fitted?: <= 400 chars }`; a stop or a place is `{ lat, lon, label?: <= 40 chars }`. The largest params stay under the workspace's 4 KB. |
| `entry` | `{ path: './web/map.html' }`, served at `/plugins/maps/web/map.html` |
| `network` | the style origins (`STYLE_ORIGINS`), the camera snapshot hosts (`CAMERA_ORIGINS`) and the imagery host (`IMAGERY_ORIGINS`), at most 32 |
| `live` | `CAMERA_ORIGINS` (kept 20 s by the net route) |
| `gpu`, `media` | true, true (ADR-0040: WebGL, wasm and blob workers for CesiumJS; https audio for radio) |
| `calls` | `search`, `route`, `layers` |
| `singleton` | false |

The page loads CesiumJS from the mount (`./vendor/cesium/Cesium.js`, its CSS from `Widgets/`), after `boot.js`, which sets
`CESIUM_BASE_URL` and wraps `Worker` so a module worker starts from a `data:` shim and a classic one from a `blob:` shim that import the
real file (an opaque-origin frame may not start a worker from the core's URL, nor a module worker from `blob:null`). No CDN, no inline script or style.

- **Globe** (`globe.js`). A `CesiumWidget` with no base layer, no ion, Web Mercator in 2D and `requestRenderMode` (frames only when
  something changes). The style's tiles are a `UrlTemplateImageryProvider` through `../net/<host>/…`, with the labels layer above when the
  style has one; credits are hidden and shown by the page. `view` picks the scene: the first apply switches at once; a later
  change is the page's own switch (`startMorph`), since the engine's morph swings the camera to 0°, 0° and back: the camera flies out
  over the same point to zoom 2.6 (0.45 to 1.6 s by the zoom levels, ease in-out; a tilted 3D view also turns straight down), a snapshot
  of the frame covers the canvas, the scene changes at once (`morphTo2D(0)` / `morphTo3D(0)`, keeping the entities, the route and the
  data) under the camera at the same point, the snapshot fades in 420 ms (shrinking toward the globe, growing toward the map; no motion
  with reduced motion), then the camera flies back in to the stored view. In 2D a view's height is the frustum's width
  (`spanForZoom`), so zoom and centre come back exactly after any number of switches. Inputs pause during a switch; meanwhile the view
  is the stored one, a `setView` changes only where it lands, and a switch asked for meanwhile follows it. The 2D/3D button tells the host at once,
  and for 5 s params that still carry the old scene (the host's copy from before the switch) do not morph back.
- **Far side** (`hideBehindGlobe`, `globe.js`). Points and labels are drawn without the depth test (an icon on the ground must not
  be cut by the surface), so before each 3D frame the page hides every one behind the Earth (`EllipsoidalOccluder`, the camera's
  horizon), for the data layers and the marks; a hidden one cannot be picked. In 2D everything shows.
- **Trackpad pinch** (`pinchGestures`, `zoomScale` in `globe.js`). The engine ignores a ctrl-wheel (how Chrome, Firefox and Edge send a
  pinch) and Safari's `gesture*` events, so the page zooms itself: a ctrl-wheel by `exp(-deltaY / 100)`, a gesture by its scale step,
  toward the pixel under the fingers (in 3D along that pixel's ray, in 2D narrowing the frustum and shifting it), within the camera's
  limits; the browser never zooms the page. A pinch is the person's move (it stops following the route). Plain wheel and touch stay
  the engine's. Zoom is Web Mercator zoom both ways: in 3D it is
  the camera height (`heightForZoom`, `zoomForHeight`: the metres a pixel covers at that latitude), in 2D the frustum's width
  (`zoomForSpan`). The camera flies to a new view in 0.9 s. The view button shows `2D` or `3D` (the other mode); ⌖ looks straight down
  with north up.
- **Look.** Keith's HUD style as before: dark glass panels, hairline borders, corner brackets, mono uppercase labels, indigo accent.
- **Layout** (`map.css`). No panel covers another. The right column (`.controls`) holds the buttons and the open menu: it ends above
  the credits and the open drawing toolbar, and the menu takes what is left and scrolls inside; the style and data menus are one at a
  time. The left column (`.left`) holds the route panel on top and the card under it: it ends above the zoom level and the open
  toolbar (`--draw-h`, set by `draw.js`); the route gives way first (its directions scroll), the card keeps up to two thirds. Only on a
  phone-narrow frame does an open menu sit over the card (it closes on the first touch on the map).
- **Styles** (`styles.js`, `STYLES`: label, base `{ origin, path, maxZoom }`, optional labels, credit, short credit, dark): `dark` (Esri
  dark gray with its labels, default), `satellite` (EOX Sentinel-2 cloudless 2024 with Esri dark labels), `night` (NASA Black Marble 2016, with labels),
  `standard` (OSM), `mono` (Esri light gray), `topo` (OpenTopoMap), `humanitarian` (HOT), `cycle` (CyclOSM). The style button (◫) opens a
  grid with a preview of each (`previewUrl`).
- **Marker, route, pins** (`overlay.js`, `map.js`). Without a route a marker and the label sit on the params point. With a route the page
  calls `route` through the bridge (`{ from, to, via?, mode, geometry: true }`), draws the line on the globe (a glowing polyline clamped to
  the ground) and HTML pins A (green), numbered stops (indigo) and B (red), placed each frame from the scene (`toScreen`, hidden behind the
  globe) with labels that flip left near the right edge. A newer route wins over an older answer. Places are small indigo pins.
- **Route panel** (`panel.js`): unchanged (modes, figures, stops, provider, note, directions; a step with `at` centres on it at zoom 16).
- **Fitting** (`fitKey`, `fitView`, `offsetPoint`): as before, now in camera terms. `fitView` gives the deepest fractional zoom (floored to
  0.05) at which the stops, pins and line fit the free room (the map minus the controls strip and the route panel, beside or below it,
  whichever gives the deeper zoom), and `offsetPoint` moves the centre so the box sits in that room. The room keeps a margin of 12 % of its shorter side (at least 64
  px) on every side (`fitPad`), so the ends of a route never touch the frame. Once `fitted` matches, the params'
  own view is used, so the person's pan and zoom survive a redraw. A pointer or wheel on the globe stops the view from following the line.
- **Data layers** (`catalog.js`, `layer-panel.js`, `data.js`, `features.js`). The ≋ button opens the layer list by group, each with its
  state (count, `…`, a short error or note); the count badge shows how many are on. The params' `layers` are the ones on. The data loop
  (`createDataLoop`) ticks every second and asks `layers` for the due layers in one call at a time, at least 2.5 s apart, 1.2 s after a move
  for layers that are not `world`, each layer again after its `refreshS`; a layer under its `minZoom` is not asked. The view's box comes from
  `computeViewRectangle`. Answers are read by hand (`readAnswers`: finite positions, an image only as a net path without `..` or a query
  (`isNetPath`), a stream only https, labels clipped to 80, a raster template only through the net route). Features are billboards with
  canvas icons (`icons.js`: a badge with the layer's glyph, an arrow turned to the heading for moving things, a dot coloured by `value` for
  weather and air), labels when zoomed in (by layer: satellites within 2500 km of the camera, quakes 4000 km, flights 300 km, ships 60 km, cameras and
  transit 4 km, others 600 km), a moving feature dead-reckoned from its speed and heading for up to 2 minutes (`moveAlong`) and a
  tracked one placed on its track (`trackAt`, satellites at their altitude). A raster is an imagery layer; a `rect` with an image is draped
  on its rectangle. A click picks the nearest feature.
- **Card** (`card.js`). A picked feature opens a card: the layer, the label, the snapshot (refreshed every 20 s with a cache-busting query;
  a snapshot that fails to load shows "No snapshot from this camera right now" until a later frame loads)
  or an `<audio controls>` for a stream (never autoplay), the facts (`info`, at most 12 rows), Zoom to and Follow (a moving feature: the
  camera keeps it centred until the person moves the map or closes the card). The picked feature's line or track is drawn.
- **Director mode** (`draw.js`). ✎ opens the toolbar: Pin, Line, Area, six colours, a label for the next mark, Done (or a double click, or
  Enter in the label) ends a line or an area, Undo and Clear. Marks are drawn on the globe (areas filled at 20 %, lines with a glow, labels)
  and proposed in the params' `marks` (`readMarks`: valid points only, a line two and an area three, within the caps), so Keith can draw
  too ("circle the area hit by the quake") and both see the same marks.
- **Credits.** The style's short credit is always visible at the bottom right, with `+N` when N data layers are on; ⓘ shows the full style
  credit followed by the credit of each layer that is on (`createCredits`, `layers.js`). The OSM and ODbL licences ask for visible
  attribution, so the credit is small, not hidden.

**Bridge** (version 1, `postMessage(msg, '*')`: the frame's origin is opaque):

- On load the page posts `{ v: 1, type: 'ready' }` to `parent`.
- It accepts only messages whose `source` is `window.parent` and whose `v` is 1: `init` (theme, language, params), `params` and
  `result`. Params are validated by hand (`readParams`, `params.js`: finite numbers in range, zoom clamped to 1..19, label trimmed to 80,
  an unknown style is `dark`, an unknown view `3d`, unknown layers dropped (each once, at most 8), a route with an invalid stop dropped,
  invalid pins dropped (at most 20), marks read by `readMarks`); invalid params are ignored.
- It posts `{ v: 1, type: 'call', id, operation: 'route' | 'layers', input }` and settles the call when the `result` with that `id` comes.
- After a move, a style or view change, a layer toggle, a mark or a fit settles it posts `{ v: 1, type: 'setParams', params }` with the
  centre (6 decimals), zoom, label, style (when not `dark`), view (when `2d`), layers, route, places, marks and `fitted`; an echo of the
  params it sent last is not applied again.
- When the label changes it posts `{ v: 1, type: 'setTitle', title: label }`; a Cesium render error is `{ type: 'error', message }` (the title and the error's own message).

`calls` also holds `search` for a later search box; the page does not call it today.
