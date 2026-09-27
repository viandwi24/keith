import { z } from 'zod'
import type { KeithConfig, ModelRef } from './types.ts'

/** `<providerId>:<modelId>`: everything after the first `:` is the model id. */
export const MODEL_REF_PATTERN = /^[^:\s]+:\S.*$/

const modelRef = z.custom<ModelRef>(
  (v) => typeof v === 'string' && MODEL_REF_PATTERN.test(v),
  'expected a model ref "<providerId>:<modelId>"',
)

/** The system time zone, the default for `mind.timezone`. */
export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    // An invalid IANA name throws a RangeError: report it as a schema issue.
    return false
  }
}

const posInt = () => z.number().int().positive()

/** Default model ref for every role (docs/architecture/config.md). `keith setup` writes its own. */
export const DEFAULT_MODEL_REF: ModelRef = 'deepseek:deepseek-flash'

/**
 * The `config.toml` schema. Every table is strict (unknown keys fail) and every key has a default,
 * so an empty file is a valid config. The exception is the optional `[voice]` section: when
 * present, it must name its `vad`, `stt` and `tts` providers. `plugins.sections` is filled by the loader from the
 * `[plugins."<id>"]` tables and never interpreted here.
 */
export const configSchema = z.strictObject({
  server: z
    .strictObject({
      host: z.string().min(1).default('127.0.0.1'),
      port: z.number().int().min(0).max(65_535).default(4824),
    })
    .prefault({}),
  mind: z
    .strictObject({
      name: z.string().min(1).default('Keith'),
      timezone: z
        .string()
        .refine(isTimezone, 'expected an IANA time zone')
        .default(() => systemTimezone()),
      turn: z
        .strictObject({ maxSteps: posInt().default(8), stallMs: posInt().default(120_000) })
        .prefault({}),
      task: z
        .strictObject({
          maxSteps: posInt().default(20),
          maxPerPerson: posInt().default(3),
          timeoutMs: posInt().default(1_800_000),
        })
        .prefault({}),
      commitment: z.strictObject({ ttlMs: posInt().default(604_800_000) }).prefault({}),
      arrival: z
        .strictObject({
          awayAfterMinutes: z.number().nonnegative().default(240),
          briefing: z.enum(['auto', 'on-greeting', 'off']).default('on-greeting'),
          holdMs: z.number().int().nonnegative().default(120_000),
          graceMs: z.number().int().nonnegative().default(1_500),
        })
        .prefault({}),
      context: z.strictObject({ recentMessages: posInt().default(40) }).prefault({}),
      reminder: z.strictObject({ maxPerPerson: posInt().default(50) }).prefault({}),
    })
    .prefault({}),
  memory: z
    .strictObject({
      coreMaxChars: posInt().default(1_500),
      reflect: z
        .strictObject({
          enabled: z.boolean().default(true),
          idleMinutes: z.number().positive().default(20),
          maxMessages: posInt().default(200),
          cardMaxChars: posInt().default(1_000),
        })
        .prefault({}),
      summary: z
        .strictObject({
          enabled: z.boolean().default(true),
          minMessages: posInt().default(20),
          maxChars: posInt().default(2_000),
        })
        .prefault({}),
    })
    .prefault({}),
  scheduler: z
    .strictObject({
      foreground: posInt().default(4),
      delivery: posInt().default(2),
      background: posInt().default(2),
      tickMs: posInt().default(30_000),
    })
    .prefault({}),
  models: z
    .strictObject({
      foreground: modelRef.default(DEFAULT_MODEL_REF),
      background: modelRef.default(DEFAULT_MODEL_REF),
      utility: modelRef.default(DEFAULT_MODEL_REF),
    })
    .prefault({}),
  auth: z.strictObject({ tokenTtlDays: posInt().default(30) }).prefault({}),
  plugins: z
    .strictObject({
      enabled: z.array(z.string().min(1)).default([]),
      required: z.array(z.string().min(1)).default([]),
      stopTimeoutMs: posInt().default(5_000),
      sections: z.record(z.string(), z.unknown()).default({}),
    })
    .prefault({}),
  services: z.record(z.string(), z.string().min(1)).default({}),
  voice: z
    .strictObject({
      vad: z.string().min(1),
      stt: z.string().min(1),
      tts: z.string().min(1),
      language: z.string().min(1).optional(),
      maxUtteranceMs: posInt().default(30_000),
      bargeIn: z.boolean().default(true),
      bargeInMinMs: z.number().int().nonnegative().default(600),
    })
    .optional(),
})

// Compile-time check: the schema output is exactly the frozen `KeithConfig`.
type SchemaOutput = z.output<typeof configSchema>
const _schemaMatchesType: [SchemaOutput, KeithConfig] extends [KeithConfig, SchemaOutput] ? true : never =
  true
