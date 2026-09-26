// The parsed shape of ~/.keith/config.toml. See docs/architecture/config.md.
// The zod schema, defaults, `env:` resolution and overrides live in config/ (task P1-A1); this is
// the resulting type every other folder reads.

import type { ModelRole } from '../shared/types.ts'

/** `<providerId>:<modelId>`, e.g. `deepseek:deepseek-flash`. Everything after the first `:` is the model id. */
export type ModelRef = `${string}:${string}`

export type BriefingMode = 'auto' | 'on-greeting' | 'off'

export interface KeithConfig {
  server: {
    /** Default '127.0.0.1' (R-14). */
    host: string
    /** Default 4824. */
    port: number
  }
  mind: {
    name: string
    /** IANA time zone. Default: the system time zone. */
    timezone: string
    turn: { maxSteps: number; stallMs: number }
    task: { maxSteps: number; maxPerPerson: number; timeoutMs: number }
    commitment: { ttlMs: number }
    arrival: {
      /** Fractional values allowed. */
      awayAfterMinutes: number
      briefing: BriefingMode
      holdMs: number
      graceMs: number
    }
    context: { recentMessages: number }
  }
  memory: { coreMaxChars: number }
  scheduler: { foreground: number; delivery: number; background: number; tickMs: number }
  models: Record<ModelRole, ModelRef>
  auth: { tokenTtlDays: number }
  plugins: {
    /** Package names, loaded in this order. */
    enabled: string[]
    /** The core refuses to start if one of these fails. */
    required: string[]
    stopTimeoutMs: number
    /**
     * The `[plugins."<id>"]` tables, keyed by plugin id, unvalidated. Each is validated by that
     * plugin's own `config` schema; the core never interprets them.
     */
    sections: Record<string, unknown>
  }
  /** Service name → winning plugin id, when two plugins provide the same service. */
  services: Record<string, string>
}

/** Locations inside `KEITH_HOME`. */
export interface KeithPaths {
  home: string
  configFile: string
  personaFile: string
  dbFile: string
  filesDir: string
  /** `ctx.paths.data` of a plugin is `<pluginsDir>/<plugin id>`. */
  pluginsDir: string
  logsDir: string
}

/** CLI flags that override config (highest precedence). */
export type ConfigFlags = { host?: string | undefined; port?: number | undefined }
