/**
 * Small shared types used across the plugin API, the event catalog and the core. The core
 * re-exports them from `core/src/shared/types.ts` so there is one definition.
 */

/** Which model a job uses. Config maps each role to a model ref. */
export type ModelRole = 'foreground' | 'background' | 'utility'
export const MODEL_ROLES: readonly ModelRole[] = ['foreground', 'background', 'utility']

export type Urgency = 'low' | 'normal' | 'high' | 'critical'
export const URGENCIES: readonly Urgency[] = ['low', 'normal', 'high', 'critical']

/** Who may see a memory or a task (docs/architecture/memory.md). */
export type Visibility = 'subject' | 'thread' | 'household' | 'owner'

export type DeliveryKind = 'task_result' | 'task_failed' | 'plugin' | 'reminder' | 'relay' | 'invitation'

export type TurnKind = 'user' | 'delivery' | 'briefing'

/** Structured fields for a log line. Values must be JSON-serializable. */
export type LogFields = { [key: string]: unknown }

/** The injected logger (R-12). Messages are lowercase and constant; variables go in fields. */
export interface Logger {
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  /** A logger that adds `fields` to every line. */
  child(fields: LogFields): Logger
}

/** The injected clock (R-12). Tests use a fake one. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number
}
