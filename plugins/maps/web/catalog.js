// The data layers of the map window, shared by the page (its layer panel and how it draws each one) and the plugin (which layers its
// `layers` operation answers for, and the agent's `maps_explore`). Plain data, no DOM: the plugin imports it too.

/**
 * @typedef {'movement' | 'space' | 'events' | 'weather' | 'cameras' | 'audio' | 'imagery'} LayerGroup
 * @typedef {{ id: string, title: string, group: LayerGroup, glyph: string, color: string, refreshS: number, minZoom: number,
 *   about: string, credit: string, needs?: string, world?: boolean }} LayerInfo `world`: one answer for the whole globe (not asked
 *   again when the view moves)
 */

/** @type {Record<LayerGroup, string>} */
export const GROUPS = {
  movement: 'Movement',
  space: 'Space',
  events: 'Events',
  weather: 'Weather',
  cameras: 'Cameras',
  audio: 'Audio',
  imagery: 'Imagery',
}

/**
 * Every layer. `refreshS` is how often the window asks again while the layer is on; `minZoom` the zoom below which it shows nothing
 * (a city-sized layer on a whole globe would be too many points or too many requests); `needs` names a plugin setting without which the
 * layer stays empty and says so.
 * @type {LayerInfo[]}
 */
export const LAYERS = [
  {
    id: 'flights',
    title: 'Flights',
    group: 'movement',
    glyph: '✈',
    color: '#7dd3fc',
    refreshS: 15,
    minZoom: 4,
    about: 'Live aircraft from ADS-B receivers: callsign, altitude, speed, heading',
    credit: 'adsb.lol (ODbL)',
  },
  {
    id: 'vessels',
    title: 'Ships',
    group: 'movement',
    glyph: '⛴',
    color: '#5eead4',
    refreshS: 30,
    minZoom: 5,
    about: 'Live ships from AIS: name, speed, course, destination',
    credit: 'AISStream.io',
    needs: 'aisstreamKey',
  },
  {
    id: 'transit',
    title: 'Transit',
    group: 'movement',
    glyph: '◉',
    color: '#fbbf24',
    refreshS: 20,
    minZoom: 9,
    about: 'Live buses, trams and trains of cities that publish GTFS-Realtime positions',
    credit: 'Operator GTFS-Realtime feeds',
  },
  {
    id: 'receivers',
    world: true,
    title: 'My receivers',
    group: 'movement',
    glyph: '⌁',
    color: '#f472b6',
    refreshS: 5,
    minZoom: 1,
    about: 'Aircraft heard by your own SDR (readsb / dump1090 aircraft.json)',
    credit: 'Your receivers',
    needs: 'receivers',
  },
  {
    id: 'satellites',
    world: true,
    title: 'Satellites',
    group: 'space',
    glyph: '✦',
    color: '#c4b5fd',
    refreshS: 120,
    minZoom: 0,
    about:
      'Space stations, imaging, weather, navigation and bright satellites, propagated with SGP4',
    credit: 'CelesTrak',
  },
  {
    id: 'launches',
    world: true,
    title: 'Launches',
    group: 'space',
    glyph: '⇡',
    color: '#fda4af',
    refreshS: 1800,
    minZoom: 0,
    about: 'Upcoming rocket launches and their pads',
    credit: 'The Space Devs · Launch Library 2',
  },
  {
    id: 'quakes',
    world: true,
    title: 'Earthquakes',
    group: 'events',
    glyph: '◎',
    color: '#fb923c',
    refreshS: 300,
    minZoom: 0,
    about: 'Earthquakes of the last day (USGS) and Indonesia’s latest (BMKG)',
    credit: 'USGS · BMKG',
  },
  {
    id: 'events',
    world: true,
    title: 'Natural events',
    group: 'events',
    glyph: '△',
    color: '#f87171',
    refreshS: 1800,
    minZoom: 0,
    about: 'Open wildfires, storms, volcanoes, floods and ice from NASA EONET',
    credit: 'NASA EONET',
  },
  {
    id: 'weather',
    title: 'Weather',
    group: 'weather',
    glyph: '☁',
    color: '#93c5fd',
    refreshS: 900,
    minZoom: 3,
    about: 'Temperature, wind and rain now on a grid over the view',
    credit: 'Open-Meteo (CC BY 4.0)',
  },
  {
    id: 'air',
    title: 'Air quality',
    group: 'weather',
    glyph: '◍',
    color: '#86efac',
    refreshS: 1800,
    minZoom: 3,
    about: 'US AQI and PM2.5 now on a grid over the view (CAMS model)',
    credit: 'Open-Meteo · Copernicus CAMS',
  },
  {
    id: 'rain',
    world: true,
    title: 'Rain',
    group: 'weather',
    glyph: '☂',
    color: '#60a5fa',
    refreshS: 1800,
    minZoom: 0,
    about: 'Global precipitation rate from satellites (NASA IMERG, a few hours behind)',
    credit: 'NASA GIBS · GPM IMERG',
  },
  {
    id: 'cameras',
    title: 'Public cameras',
    group: 'cameras',
    glyph: '◫',
    color: '#e5e7eb',
    refreshS: 60,
    minZoom: 9,
    about:
      'Public traffic cameras with live snapshots (London, Singapore, Hong Kong, Finland, California) and mapped cameras from OpenStreetMap',
    credit: 'TfL · LTA Singapore · HK TD · Fintraffic · OpenStreetMap',
  },
  {
    id: 'radio',
    title: 'Radio',
    group: 'audio',
    glyph: '♪',
    color: '#facc15',
    refreshS: 3600,
    minZoom: 3,
    about: 'Internet radio stations by where they broadcast from, playable',
    credit: 'Radio Browser',
  },
  {
    id: 'imagery',
    title: 'Recent imagery',
    group: 'imagery',
    glyph: '▦',
    color: '#a3e635',
    refreshS: 3600,
    minZoom: 9,
    about: 'The latest clear Sentinel-2 scenes of the view (last 30 days), draped on the map',
    credit: 'Copernicus Sentinel-2 via Element 84 Earth Search',
  },
]

export const LAYER_IDS = LAYERS.map((l) => l.id)

/** @param {string} id @returns {LayerInfo | undefined} */
export const layerOf = (id) => LAYERS.find((l) => l.id === id)
