import { resolve } from 'node:path'
import type { ColorDepth, ThemeName } from '@keith/ui'
import { z } from 'zod'

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

/** `<repo>/data`: the default no matter which folder a script runs from. */
const DEFAULT_DATA_DIR = resolve(import.meta.dir, '../../../../data')

const optional = z
  .string()
  .optional()
  .transform((v) => (v === '' ? undefined : v))

/** `<repo>/apps/web/build`: the default web client build, wherever a script runs from. */
const DEFAULT_WEB_DIR = resolve(import.meta.dir, '../../../web/build')

/** `true`/`1` switch a flag on; unset, empty and anything else off. */
const flag = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1')

const publicUrl = z
  .string()
  .optional()
  .transform((v) => (v === '' || v === undefined ? undefined : v.replace(/\/+$/, '')))
  .pipe(z.url().optional())

/** Comma list of host names; blanks dropped, lower-cased. */
const hostList = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h !== ''),
  )

/** Variables a shell started by the `core` node may see: the same three a node gives (ADR-0027 §12). */
const SHELL_ENV_KEYS = ['PATH', 'HOME', 'LANG'] as const

const ConfigSchema = z.object({
  /** Console look: `dark`, `light` or `auto` (reads `COLORFGBG`); anything else counts as `auto`. */
  KEITH_THEME: optional.pipe(z.enum(['dark', 'light', 'auto']).optional().catch(undefined)),
  /** `rrggbb;bg` hint some terminals export: the last field is the background index. */
  COLORFGBG: optional,
  COLORTERM: optional,
  TERM: optional,
  /** Set and not empty means no colour at all (no-color.org). */
  NO_COLOR: optional,
  /** Data folder. Wins over `KEITH_HOME`; empty counts as unset. */
  KEITH_DATA_DIR: optional,
  /** One folder that moves every default location: the data dir becomes `<home>/data`. */
  KEITH_HOME: optional,
  /** Address the server binds to. Default loopback: reach it from elsewhere only on purpose. */
  KEITH_HOST: z.string().min(1).default('127.0.0.1'),
  KEITH_PORT: z.coerce.number().int().min(0).max(65_535).default(7420),
  KEITH_LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** 32 bytes base64: seals stored credentials. Empty: a dev key file in the data folder. */
  KEITH_SECRET_KEY: optional,
  /** Whether the in-process node `core` may run `shell.exec` (still asks the owner each time). */
  KEITH_CORE_ALLOW_SHELL: flag,
  /** URL nodes use to reach this core, shown in the join command of `/pair`. */
  KEITH_PUBLIC_URL: publicUrl,
  /** VAPID subject of Web Push (docs/specs/push.md): a `mailto:` or https URL. Default: the public URL when https. */
  KEITH_PUSH_SUBJECT: optional.pipe(
    z
      .string()
      .regex(/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/, 'must be a mailto: or https URL')
      .optional(),
  ),
  /** Extra host names core answers to (comma list), like the public URL's host: any port. */
  KEITH_ALLOWED_HOSTS: hostList,
  /**
   * Allow `/auth/login` and `/auth/step-up` from anywhere (Funnel, unknown proxies, a public
   * address). Off by default: password routes only answer on loopback, Tailscale and `tailscale serve`.
   */
  KEITH_INSECURE_LOGIN: flag,
  /** Folder of the built web client served at `/app`. Empty: `apps/web/build` of this checkout. */
  KEITH_WEB_DIR: optional,
  /** `off` removes `/app` (the API stays). Default `on`; unknown values count as `on`. */
  KEITH_WEB: optional.pipe(z.enum(['on', 'off']).optional().catch(undefined)),
  /** Short git SHA reported by `/health`. Empty: read from git at boot. */
  KEITH_BUILD_SHA: optional,
  /**
   * A `keith-core` admin session kept in the environment of one shell (`eval "$(keith-core login)"`): memory
   * of that shell only, never a file. Empty counts as unset.
   */
  KEITH_ADMIN_SESSION: optional,
  /** Read-only OpenRouter connection from the environment (ADR-0007). */
  OPENROUTER_API_KEY: optional,
  OPENROUTER_BASE_URL: optional,
  /** Read-only OpenAI and DeepSeek connections from the environment. */
  OPENAI_API_KEY: optional,
  OPENAI_BASE_URL: optional,
  DEEPSEEK_API_KEY: optional,
  DEEPSEEK_BASE_URL: optional,
  /** Where the model catalog (prices, limits) is downloaded from. Default models.dev; the smoke serves its own. */
  KEITH_MODELS_DEV_URL: publicUrl,
  /** Node token age (ms) that triggers a rotation at the next connection. Default 30 days; tests and smoke set it short. */
  KEITH_NODE_ROTATE_MS: optional.pipe(
    z
      .string()
      .regex(/^[1-9]\d*$/, 'a positive whole number of milliseconds')
      .transform(Number)
      .optional(),
  ),
})

/** Where a boot value came from: the environment, or the built-in default (a setting may sit between). */
export type ConfigSource = 'env' | 'default'

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

export interface Config {
  dataDir: string
  dbFile: string
  /** `KEITH_HOST`: address to bind (default `127.0.0.1`). */
  host: string
  port: number
  logLevel: (typeof LOG_LEVELS)[number]
  secretKey: string | undefined
  /** `KEITH_CORE_ALLOW_SHELL`: default false. */
  allowCoreShell: boolean
  /** `KEITH_INSECURE_LOGIN`: default false. */
  insecureLogin: boolean
  /** `KEITH_PUBLIC_URL` without a trailing slash, or undefined (the join command uses localhost). */
  publicUrl: string | undefined
  /** `KEITH_PUSH_SUBJECT`: the VAPID subject, or undefined (the public URL when https, else a placeholder). */
  pushSubject: string | undefined
  /** `KEITH_ALLOWED_HOSTS`: extra `Host` names besides localhost and the public URL's host. */
  allowedHosts: string[]
  /** `KEITH_WEB`: whether core serves the web client at `/app` (default true). */
  web: boolean
  /** `KEITH_WEB_DIR`: the folder it serves (default `apps/web/build`). */
  webDir: string
  /** Minimal environment of shells run by the `core` node (never Keith's secrets). */
  shellEnv: Record<string, string>
  buildSha: string | undefined
  /** `KEITH_ADMIN_SESSION`: the admin session credential of this shell, if the user exported one. */
  adminSession: string | undefined
  /** Look of the terminal console (`keith-core` with no arguments, the setup wizard). */
  ui: { theme: ThemeName; depth: ColorDepth }
  /** `KEITH_MODELS_DEV_URL`: catalog download address; `undefined` keeps the eharness default. */
  modelsDevUrl: string | undefined
  /** `KEITH_NODE_ROTATE_MS`: node token age that triggers a rotation; `undefined` keeps 30 days. */
  nodeTokenRotateMs?: number
  /** Environment handed to the provider manager (env connections). */
  providerEnv: Record<string, string | undefined>
  /** Whether `host`, `port` and `publicUrl` were set in the environment (they win over settings). */
  sources: {
    host: ConfigSource
    port: ConfigSource
    publicUrl: ConfigSource
    dataDir: ConfigSource
    logLevel: ConfigSource
    allowedHosts: ConfigSource
  }
}

/** The only place that reads `process.env`. Throws with every invalid variable named. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = ConfigSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid Keith config: ${issues}`)
  }
  const c = parsed.data
  const dataDir = resolve(
    c.KEITH_DATA_DIR ?? (c.KEITH_HOME ? resolve(c.KEITH_HOME, 'data') : DEFAULT_DATA_DIR),
  )
  const fromEnv = (key: string): ConfigSource =>
    env[key] !== undefined && env[key] !== '' ? 'env' : 'default'
  return {
    sources: {
      host: fromEnv('KEITH_HOST'),
      port: fromEnv('KEITH_PORT'),
      publicUrl: fromEnv('KEITH_PUBLIC_URL'),
      logLevel: fromEnv('KEITH_LOG_LEVEL'),
      allowedHosts: fromEnv('KEITH_ALLOWED_HOSTS'),
      dataDir: c.KEITH_DATA_DIR !== undefined || c.KEITH_HOME !== undefined ? 'env' : 'default',
    },
    dataDir,
    dbFile: resolve(dataDir, 'keith.db'),
    host: c.KEITH_HOST,
    port: c.KEITH_PORT,
    logLevel: c.KEITH_LOG_LEVEL,
    secretKey: c.KEITH_SECRET_KEY,
    allowCoreShell: c.KEITH_CORE_ALLOW_SHELL,
    insecureLogin: c.KEITH_INSECURE_LOGIN,
    publicUrl: c.KEITH_PUBLIC_URL,
    allowedHosts: c.KEITH_ALLOWED_HOSTS,
    pushSubject: c.KEITH_PUSH_SUBJECT,
    web: c.KEITH_WEB !== 'off',
    webDir: c.KEITH_WEB_DIR === undefined ? DEFAULT_WEB_DIR : resolve(c.KEITH_WEB_DIR),
    shellEnv: Object.fromEntries(
      SHELL_ENV_KEYS.flatMap((key) => {
        const value = env[key]
        return value === undefined ? [] : [[key, value]]
      }),
    ),
    buildSha: c.KEITH_BUILD_SHA,
    adminSession: c.KEITH_ADMIN_SESSION,
    ui: { theme: themeOf(c.KEITH_THEME, c.COLORFGBG), depth: depthOf(c) },
    modelsDevUrl: c.KEITH_MODELS_DEV_URL,
    ...(c.KEITH_NODE_ROTATE_MS === undefined ? {} : { nodeTokenRotateMs: c.KEITH_NODE_ROTATE_MS }),
    providerEnv: {
      OPENROUTER_API_KEY: c.OPENROUTER_API_KEY,
      OPENROUTER_BASE_URL: c.OPENROUTER_BASE_URL,
      OPENAI_API_KEY: c.OPENAI_API_KEY,
      OPENAI_BASE_URL: c.OPENAI_BASE_URL,
      DEEPSEEK_API_KEY: c.DEEPSEEK_API_KEY,
      DEEPSEEK_BASE_URL: c.DEEPSEEK_BASE_URL,
    },
  }
}
