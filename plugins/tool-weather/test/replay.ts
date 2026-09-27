/**
 * Replays fixtures through an injected `fetch` (R-13: tests never hit the network).
 *
 * Fixtures in `fixtures/`: `recorded-*` are real Open-Meteo responses captured on 2026-09-26
 * (`recorded-forecast-surabaya-daily.json` on 2026-09-27, with the `daily` block);
 * `synthetic-*` are hand-made from a recorded one (same shape, invented values).
 */
import type { FetchLike } from '../src/index.ts'

export type Route = { fixture: string; status?: number } | { body: unknown; status?: number }

export type Replay = { fetch: FetchLike; urls: URL[] }

const load = (name: string): Promise<unknown> =>
  Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).json()

/** Answers geocoding and forecast requests from the given routes. Later calls reuse the last route. */
export function replay(routes: { geocoding: Route | Route[]; forecast: Route | Route[] }): Replay {
  const urls: URL[] = []
  const calls = { geocoding: 0, forecast: 0 }
  const next = (kind: 'geocoding' | 'forecast'): Route => {
    const list = ([] as Route[]).concat(routes[kind])
    const route = list[Math.min(calls[kind], list.length - 1)]
    calls[kind]++
    if (!route) throw new Error(`no ${kind} route`)
    return route
  }
  return {
    urls,
    async fetch(url, init) {
      init?.signal?.throwIfAborted()
      const u = new URL(url)
      urls.push(u)
      const route = next(u.hostname.startsWith('geocoding') ? 'geocoding' : 'forecast')
      const body = 'fixture' in route ? await load(route.fixture) : route.body
      return new Response(JSON.stringify(body), {
        status: route.status ?? 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  }
}

export const SURABAYA = { fixture: 'recorded-geocoding-surabaya.json' }
export const NO_PLACE = { fixture: 'recorded-geocoding-empty.json' }
export const DRY = { fixture: 'recorded-forecast-surabaya.json' }
export const DRY_IMPERIAL = { fixture: 'recorded-forecast-surabaya-imperial.json' }
export const DAILY = { fixture: 'recorded-forecast-surabaya-daily.json' }
export const RAIN = { fixture: 'synthetic-forecast-surabaya-rain.json' }
export const BAD_REQUEST = { fixture: 'recorded-error-400.json', status: 400 }
