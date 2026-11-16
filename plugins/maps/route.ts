import { defineOperation, OperationError } from '@keith/host'
import { z } from '@keith/host/schema'
import { bboxOf, decodePolyline, type LatLon, simplify } from './geo.ts'
import { geocode } from './search.ts'
import { firstOf, type Upstream, UpstreamError } from './upstream.ts'

/** FOSSGIS OSRM (routing.openstreetmap.de): car, bike and foot profiles, one request a second. */
export const OSRM = 'https://routing.openstreetmap.de'
/** FOSSGIS Valhalla: the fallback, and the first choice for a motorcycle (OSRM has no motorcycle profile). */
export const VALHALLA = 'https://valhalla1.openstreetmap.de/route'
/** Points of a route line sent to the map window. */
export const MAX_GEOMETRY = 1_500
const MAX_STEPS = 30

export const Point = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
})
/** A place name to look up, or a position. */
export const Where = z.union([z.string().trim().min(1).max(200), Point])
export type Where = z.infer<typeof Where>
export const MODES = ['car', 'motorcycle', 'bike', 'foot'] as const
export type Mode = (typeof MODES)[number]

export const RouteInput = z.object({
  from: Where,
  to: Where,
  via: z.array(Where).max(3).optional(),
  mode: z.enum(MODES).optional(),
  /** The route line as `[lat, lon]` points; the map window asks for it, a chat answer does not need it. */
  geometry: z.boolean().optional(),
})

const Stop = z.object({ name: z.string().optional(), lat: z.number(), lon: z.number() })
type Stop = z.infer<typeof Stop>
const Step = z.object({
  text: z.string(),
  distanceM: z.number(),
  /** Where the turn is, `[lat, lon]`: sent with `geometry` only (the map window centres on a step). */
  at: z.tuple([z.number(), z.number()]).optional(),
})
type Step = z.infer<typeof Step>

export const RouteOutput = z.object({
  from: Stop,
  to: Stop,
  via: z.array(Stop).optional(),
  mode: z.enum(MODES),
  provider: z.enum(['osrm', 'valhalla']),
  distanceM: z.number(),
  durationS: z.number(),
  /** "12.3 km, 25 min". */
  summary: z.string(),
  steps: z.array(Step),
  /** `[south, north, west, east]` of the route. */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  note: z.string().optional(),
  geometry: z.array(z.tuple([z.number(), z.number()])).optional(),
})
type RouteOutput = z.infer<typeof RouteOutput>

/** What a provider answers, before the stops are added. */
interface Leg {
  provider: 'osrm' | 'valhalla'
  distanceM: number
  durationS: number
  steps: Step[]
  line: LatLon[]
  note?: string
}

/** A place name becomes the first search result; a position stays as it is. */
export async function resolvePlace(up: Upstream, where: Where, signal: AbortSignal): Promise<Stop> {
  if (typeof where !== 'string') return { lat: where.lat, lon: where.lon }
  const found = await geocode(up, where, 1, signal)
  const first = found.results[0]
  if (first === undefined)
    throw new OperationError('CONFLICT', `no place found for "${where.slice(0, 80)}"`)
  return { name: first.name, lat: first.lat, lon: first.lon }
}

export const formatDistance = (m: number) =>
  m < 1_000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1_000).toFixed(m < 10_000 ? 1 : 0)} km`
export const formatDuration = (s: number) => {
  const min = Math.max(1, Math.round(s / 60))
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`
}

// --- OSRM -----------------------------------------------------------------------------------------------------------------------

const OSRM_PROFILE: Record<Exclude<Mode, 'motorcycle'>, string> = {
  car: 'car',
  bike: 'bike',
  foot: 'foot',
}

const OsrmStep = z.object({
  distance: z.number(),
  name: z.string().optional(),
  ref: z.string().optional(),
  maneuver: z.object({
    type: z.string(),
    modifier: z.string().optional(),
    exit: z.number().optional(),
    location: z.tuple([z.number(), z.number()]).optional(),
  }),
})
const OsrmAnswer = z.object({
  code: z.string(),
  routes: z
    .array(
      z.object({
        distance: z.number(),
        duration: z.number(),
        geometry: z.object({ coordinates: z.array(z.tuple([z.number(), z.number()])) }),
        legs: z.array(z.object({ steps: z.array(OsrmStep).default([]) })),
      }),
    )
    .optional(),
})

/** An English line for one OSRM step (OSRM gives maneuvers, not text). */
export function osrmStepText(step: z.infer<typeof OsrmStep>, last: boolean): string {
  const road = [step.name, step.ref ? `(${step.ref})` : ''].filter(Boolean).join(' ').trim()
  const onto = road === '' ? '' : ` onto ${road}`
  const { type, modifier, exit } = step.maneuver
  const way = modifier === undefined ? '' : modifier === 'straight' ? 'straight' : modifier
  switch (type) {
    case 'depart':
      return road === '' ? 'Start' : `Start on ${road}`
    case 'arrive':
      return last ? 'Arrive at the destination' : 'Arrive at the stop'
    case 'roundabout':
    case 'rotary':
    case 'exit roundabout':
    case 'exit rotary':
      return `At the roundabout take exit ${exit ?? 1}${onto}`
    case 'new name':
    case 'continue':
      return `Continue${way && way !== 'straight' ? ` ${way}` : ''}${onto}`
    case 'merge':
      return `Merge${way ? ` ${way}` : ''}${onto}`
    case 'on ramp':
      return `Take the ramp${way ? ` on the ${way}` : ''}${onto}`
    case 'off ramp':
      return `Take the exit${way ? ` on the ${way}` : ''}${onto}`
    case 'fork':
      return `Keep ${way || 'ahead'} at the fork${onto}`
    case 'end of road':
      return `At the end of the road turn ${way || 'ahead'}${onto}`
    default:
      return way === 'uturn' ? `Make a U-turn${onto}` : `Turn ${way || 'ahead'}${onto}`
  }
}

export function osrmLeg(body: unknown): Leg {
  const answer = OsrmAnswer.safeParse(body)
  if (!answer.success) throw new UpstreamError('unreadable')
  const route = answer.data.routes?.[0]
  if (answer.data.code === 'NoRoute' || (answer.data.code === 'Ok' && route === undefined))
    throw new OperationError('CONFLICT', 'no route found between these places')
  if (answer.data.code !== 'Ok' || route === undefined) throw new UpstreamError('unreadable')
  const steps: Step[] = []
  route.legs.forEach((leg, l) => {
    leg.steps.forEach((step, s) => {
      const lastOfLeg = s === leg.steps.length - 1
      if (step.maneuver.type === 'arrive' && !lastOfLeg) return
      const loc = step.maneuver.location
      steps.push({
        text: osrmStepText(step, l === route.legs.length - 1),
        distanceM: Math.round(step.distance),
        ...(loc === undefined ? {} : { at: [loc[1], loc[0]] as [number, number] }),
      })
    })
  })
  return {
    provider: 'osrm',
    distanceM: route.distance,
    durationS: route.duration,
    steps,
    line: route.geometry.coordinates.map(([lon, lat]) => [lat, lon] as LatLon),
  }
}

// --- Valhalla -------------------------------------------------------------------------------------------------------------------

const VALHALLA_COSTING: Record<Mode, string> = {
  car: 'auto',
  // Indonesian motorbikes may not use toll roads: keep a motorcycle off motorways
  motorcycle: 'motorcycle',
  bike: 'bicycle',
  foot: 'pedestrian',
}

const ValhallaAnswer = z.object({
  trip: z.object({
    summary: z.object({ length: z.number(), time: z.number() }),
    legs: z.array(
      z.object({
        shape: z.string(),
        maneuvers: z
          .array(
            z.object({
              instruction: z.string(),
              length: z.number().default(0),
              begin_shape_index: z.number().int().min(0).optional(),
            }),
          )
          .default([]),
      }),
    ),
  }),
})

export function valhallaRequest(stops: Stop[], mode: Mode): string {
  return JSON.stringify({
    locations: stops.map((s) => ({ lat: s.lat, lon: s.lon })),
    costing: VALHALLA_COSTING[mode],
    costing_options: mode === 'motorcycle' ? { motorcycle: { use_highways: 0 } } : undefined,
    units: 'kilometers',
    directions_options: { units: 'kilometers', language: 'en-US' },
  })
}

export function valhallaLeg(body: unknown): Leg {
  const answer = ValhallaAnswer.safeParse(body)
  if (!answer.success) throw new UpstreamError('unreadable')
  const { summary, legs } = answer.data.trip
  const steps: Step[] = []
  const line: LatLon[] = []
  for (const leg of legs) {
    const shape = decodePolyline(leg.shape, 6)
    line.push(...shape)
    for (const m of leg.maneuvers) {
      const at = m.begin_shape_index === undefined ? undefined : shape[m.begin_shape_index]
      steps.push({
        text: m.instruction.slice(0, 200),
        distanceM: Math.round(m.length * 1_000),
        ...(at === undefined ? {} : { at }),
      })
    }
  }
  return {
    provider: 'valhalla',
    distanceM: summary.length * 1_000,
    durationS: summary.time,
    steps,
    line,
  }
}

// --- the operation --------------------------------------------------------------------------------------------------------------

const coord = (s: Stop) => `${s.lon.toFixed(6)},${s.lat.toFixed(6)}`

/** Asks the providers in order: OSRM then Valhalla; for a motorcycle Valhalla, then an OSRM car route (said in `note`). */
export async function findRoute(
  up: Upstream,
  stops: Stop[],
  mode: Mode,
  signal: AbortSignal,
): Promise<Leg> {
  const osrm = (profile: string) => async () =>
    osrmLeg(
      await up.json(
        `${OSRM}/routed-${profile}/route/v1/driving/${stops.map(coord).join(';')}?overview=full&geometries=geojson&steps=true`,
        { signal },
      ),
    )
  const valhalla = async () => {
    try {
      return valhallaLeg(
        await up.json(VALHALLA, {
          signal,
          body: { text: valhallaRequest(stops, mode), type: 'application/json' },
        }),
      )
    } catch (error) {
      // Valhalla answers 400 with an error code when no path exists
      if (error instanceof UpstreamError && error.kind === 'http' && error.status === 400)
        throw new OperationError('CONFLICT', 'no route found between these places')
      throw error
    }
  }
  if (mode === 'motorcycle') {
    return firstOf('the route service', [
      valhalla,
      async () => ({
        ...(await osrm('car')()),
        note: 'a car route: the motorcycle router did not answer',
      }),
    ])
  }
  return firstOf('the route service', [osrm(OSRM_PROFILE[mode]), valhalla])
}

/** Joins short steps so a long route keeps at most MAX_STEPS lines (the last ones stay as they are). */
export function trimSteps(steps: Step[]): Step[] {
  if (steps.length <= MAX_STEPS) return steps
  const kept = steps.slice(0, MAX_STEPS - 1)
  const rest = steps.slice(MAX_STEPS - 1)
  const last = rest[rest.length - 1] as Step
  kept.push({
    text: `${rest.length - 1} more steps, then: ${last.text}`,
    distanceM: rest.reduce((sum, s) => sum + s.distanceM, 0),
    ...(rest[0]?.at === undefined ? {} : { at: rest[0].at }),
  })
  return kept
}

/** The `route` operation (`maps_route`). */
export function routeOperation(up: Upstream) {
  return defineOperation({
    name: 'route',
    description:
      'Find a route between two places (names or positions), optionally through up to 3 stops, by car, motorcycle, bike or foot. Returns the real distance, travel time and turns: call it for every route question, also before drawing one, and never estimate distance or time yourself. To show it, open or update the map window with params { lat, lon, route: { from, to, via?, mode } } using the positions it returns.',
    input: RouteInput,
    output: RouteOutput,
    permission: { capability: 'authenticated' },
    risk: 'read',
    // place and street names come from OpenStreetMap
    source: 'outside',
    rateLimit: { max: 20, windowMs: 60_000 },
    async run(input, k): Promise<RouteOutput> {
      const mode = input.mode ?? 'car'
      const from = await resolvePlace(up, input.from, k.signal)
      const via = []
      for (const v of input.via ?? []) via.push(await resolvePlace(up, v, k.signal))
      const to = await resolvePlace(up, input.to, k.signal)
      const leg = await findRoute(up, [from, ...via, to], mode, k.signal)
      const out: RouteOutput = {
        from,
        to,
        mode,
        provider: leg.provider,
        distanceM: Math.round(leg.distanceM),
        durationS: Math.round(leg.durationS),
        summary: `${formatDistance(leg.distanceM)}, ${formatDuration(leg.durationS)}`,
        // a step's position helps the map window only; a chat answer does without it
        steps: trimSteps(
          input.geometry === true ? leg.steps : leg.steps.map(({ at: _at, ...step }) => step),
        ),
        bbox: bboxOf(leg.line.length > 0 ? leg.line : [from, to].map((s) => [s.lat, s.lon])),
      }
      if (via.length > 0) out.via = via
      if (leg.note !== undefined) out.note = leg.note
      if (input.geometry === true) out.geometry = simplify(leg.line, MAX_GEOMETRY)
      return out
    },
  })
}
