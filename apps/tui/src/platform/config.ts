import { resolve } from 'node:path'
import type { ColorDepth, ThemeName } from '@keith/ui'
import { z } from 'zod'

const optional = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v))

const EnvSchema = z.object({
  /** Where the TUI login (`{ core, token }`) lives; default `~/.keith/client.json`. */
  KEITH_CLIENT_CONFIG: z.string().min(1).optional(),
  /** One folder that moves every default: the login file becomes `<home>/client.json`, the data dir `<home>/data`. */
  KEITH_HOME: optional,
  /** The core's data folder, where its local socket lives. Wins over `KEITH_HOME`. */
  KEITH_DATA_DIR: optional,
  /** `dark`, `light` or `auto` (default): `auto` reads `COLORFGBG`. Anything else counts as `auto`. */
  KEITH_THEME: optional.pipe(z.enum(['dark', 'light', 'auto']).optional().catch(undefined)),
  /** `rrggbb;bg` style hint some terminals export: the last field is the background index. */
  COLORFGBG: optional,
  COLORTERM: optional,
  TERM: optional,
  /** Cell width over cell height (0.25 to 0.8) when the terminal does not report it; invalid counts as unset. */
  KEITH_CELL_ASPECT: optional.transform((v) => {
    const n = v === undefined ? Number.NaN : Number(v)
    return n >= 0.25 && n <= 0.8 ? n : undefined
  }),
  /** Set and not empty means no colour at all (no-color.org). */
  NO_COLOR: optional,
  /** `0`, `off`, `false` or `no` skips Home's fade-in the first time it appears. */
  KEITH_INTRO: optional,
  /** Seconds without a key before Home hides its graph, legend, title and status (0 = never; default 60). */
  KEITH_IDLE_HIDE_SECONDS: optional,
  /** Set and not `0`/`off`/`false`/`no`: no fade at all, parts appear and disappear at once. */
  KEITH_REDUCED_MOTION: optional,
  /** Set and not `0`/`off`/`false`/`no`: the orb is one still frame (no waves, no flight); only its colour moves. `keith --disable-orb` sets it. */
  KEITH_DISABLE_ORB: optional,
  /** Seconds a dropped link, or one attempt, has to be live again before it is `disconnected` (default 5; below 1 or invalid is the default). */
  KEITH_RECONNECT_WINDOW_SECONDS: optional,
  /** Seconds the link stays `disconnected` before the next attempt (default 15). */
  KEITH_RECONNECT_WAIT_SECONDS: optional,
})

const OFF = new Set(['0', 'off', 'false', 'no'])
const isOff = (v: string | undefined): boolean => v !== undefined && OFF.has(v.toLowerCase())

/** Seconds from `KEITH_IDLE_HIDE_SECONDS`; a missing, negative or invalid value is the default 60. */
export function idleHideOf(raw: string | undefined): number {
  const n = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 60
}

/** Seconds from an env value: a positive finite number, else the default. */
export function secondsOf(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(n) && n >= 1 ? n : fallback
}

/** How the link monitor times a lost connection (milliseconds). */
export interface LinkTuning {
  /** The one window a dropped link, or an attempt, has to be live again (default 5 s). */
  windowMs: number
  /** How long the link stays disconnected before the next attempt (default 15 s). */
  waitMs: number
}

/** `KEITH_RECONNECT_WINDOW_SECONDS` (5) and `KEITH_RECONNECT_WAIT_SECONDS` (15). */
export function loadLinkTuning(env: Record<string, string | undefined> = process.env): LinkTuning {
  const parsed = EnvSchema.pick({
    KEITH_RECONNECT_WINDOW_SECONDS: true,
    KEITH_RECONNECT_WAIT_SECONDS: true,
  }).parse({
    KEITH_RECONNECT_WINDOW_SECONDS: env.KEITH_RECONNECT_WINDOW_SECONDS,
    KEITH_RECONNECT_WAIT_SECONDS: env.KEITH_RECONNECT_WAIT_SECONDS,
  })
  return {
    windowMs: secondsOf(parsed.KEITH_RECONNECT_WINDOW_SECONDS, 5) * 1000,
    waitMs: secondsOf(parsed.KEITH_RECONNECT_WAIT_SECONDS, 15) * 1000,
  }
}

/** `<repo>/data`: the data dir core uses when nothing moves it (same rule as apps/core). */
const DEFAULT_DATA_DIR = resolve(import.meta.dir, '../../../../data')

export type { ColorDepth, ThemeName }

/** `KEITH_THEME`, else `COLORFGBG` (background index 7 or 15 = light), else dark. */
export function themeOf(forced: 'dark' | 'light' | 'auto' | undefined, fgbg?: string): ThemeName {
  if (forced === 'dark' || forced === 'light') return forced
  const last = fgbg?.split(';').at(-1)
  return last === '7' || last === '15' ? 'light' : 'dark'
}

/** `none` (NO_COLOR), `truecolor` (COLORTERM), `256` (TERM) or `16`. */
export function depthOf(env: {
  NO_COLOR?: string | undefined
  COLORTERM?: string | undefined
  TERM?: string | undefined
}): ColorDepth {
  if (env.NO_COLOR !== undefined) return 'none'
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 'truecolor'
  if (env.TERM?.includes('256color') === true) return '256'
  return '16'
}

export interface MotionConfig {
  intro: boolean
  idleHideSeconds: number
  reduced: boolean
  /** The orb does not move: one fixed frame, no flight between screens; only its colour follows the state. */
  orbStatic: boolean
}

export interface TuiConfig {
  /** Dark or light palette (`KEITH_THEME`, `COLORFGBG`). */
  theme: ThemeName
  /** How many colours the terminal takes (`NO_COLOR`, `COLORTERM`, `TERM`). */
  depth: ColorDepth
  /** Path of the client config; `undefined` means the client's default. */
  clientConfigPath: string | undefined
  /** The default core's data dir: `KEITH_DATA_DIR`, else `<KEITH_HOME>/data`, else `<repo>/data`. */
  dataDir: string
  /** `KEITH_CELL_ASPECT`: wins over the terminal's own report; `undefined` means detect. */
  cellAspect: number | undefined
  /** Home's motion: the intro, the idle hide (seconds, 0 = off), reduced motion (no fades at all) and a still orb. */
  motion: MotionConfig
}

/** The only place the TUI reads the environment. */
export function loadConfig(env: Record<string, string | undefined> = process.env): TuiConfig {
  const parsed = EnvSchema.parse({
    KEITH_CLIENT_CONFIG: env.KEITH_CLIENT_CONFIG,
    KEITH_HOME: env.KEITH_HOME,
    KEITH_DATA_DIR: env.KEITH_DATA_DIR,
    KEITH_THEME: env.KEITH_THEME,
    COLORFGBG: env.COLORFGBG,
    COLORTERM: env.COLORTERM,
    TERM: env.TERM,
    NO_COLOR: env.NO_COLOR,
    KEITH_CELL_ASPECT: env.KEITH_CELL_ASPECT,
    KEITH_INTRO: env.KEITH_INTRO,
    KEITH_IDLE_HIDE_SECONDS: env.KEITH_IDLE_HIDE_SECONDS,
    KEITH_REDUCED_MOTION: env.KEITH_REDUCED_MOTION,
    KEITH_DISABLE_ORB: env.KEITH_DISABLE_ORB,
  })
  const home = parsed.KEITH_HOME
  const fromHome = home === undefined ? undefined : resolve(home, 'client.json')
  const dataDir =
    parsed.KEITH_DATA_DIR !== undefined
      ? resolve(parsed.KEITH_DATA_DIR)
      : home !== undefined
        ? resolve(home, 'data')
        : DEFAULT_DATA_DIR
  return {
    clientConfigPath: parsed.KEITH_CLIENT_CONFIG ?? fromHome,
    dataDir,
    theme: themeOf(parsed.KEITH_THEME, parsed.COLORFGBG),
    depth: depthOf(parsed),
    cellAspect: parsed.KEITH_CELL_ASPECT,
    motion: {
      intro: !isOff(parsed.KEITH_INTRO),
      idleHideSeconds: idleHideOf(parsed.KEITH_IDLE_HIDE_SECONDS),
      reduced: parsed.KEITH_REDUCED_MOTION !== undefined && !isOff(parsed.KEITH_REDUCED_MOTION),
      orbStatic: parsed.KEITH_DISABLE_ORB !== undefined && !isOff(parsed.KEITH_DISABLE_ORB),
    },
  }
}
