// What a driver module exports: `defineDriver`, the call and result types a driver handles.
import { CapabilityIdSchema, driverOf } from '@keith/contracts'
import { DriverNameSchema, DriverVersionSchema } from './manifest.ts'

/** The failure codes a driver may return; the node maps them to its own error codes. */
export const DRIVER_FAILURE_CODES = [
  'failed',
  'refused-by-policy',
  'timeout',
  'cancelled',
  'busy',
] as const
export type DriverFailureCode = (typeof DRIVER_FAILURE_CODES)[number]

export interface DriverLogger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

/** What the node hands a driver. Nothing else: no core URL, token, node config or other drivers. */
export interface DriverContext {
  readonly logger: DriverLogger
  /** The node's work folder. */
  readonly workdir: string
  /** The driver's own options, public facts only (for example `allowInput`). */
  readonly options: Readonly<Record<string, unknown>>
  /** Aborted when the core cancels the call or its timeout passes. */
  readonly signal: AbortSignal
  /** Streams a chunk of progress for the running call (`stdout` when no stream is named). */
  progress(chunk: string, stream?: 'stdout' | 'stderr'): void
}

/** One call to a capability of this driver. */
export interface CapabilityCall {
  readonly callId: string
  /** The capability id, `<driver>.<action>`. */
  readonly capability: string
  /** The schema version the core asked for; the driver handles the versions it declares. */
  readonly schemaVersion: number
  /** The input, already checked by the core against the capability's schema. */
  readonly input: unknown
  /** The time the core allows this call; the node aborts `ctx.signal` when it passes. */
  readonly timeoutMs: number
}

export type CapabilityResult =
  | { readonly ok: true; readonly output: unknown; readonly exitCode?: number }
  | {
      readonly ok: false
      readonly code: DriverFailureCode
      readonly message: string
      readonly exitCode?: number
    }

export interface DriverCapability {
  readonly id: string
  readonly schemaVersion: number
}

export interface DriverDefinition {
  readonly name: string
  readonly version: string
  readonly capabilities: readonly DriverCapability[]
  /** Runs once when the node starts; a throw leaves the driver out of the announcement. */
  start?(ctx: DriverContext): void | Promise<void>
  /**
   * The capabilities this driver offers with these options: a subset of `capabilities`. The node announces only these.
   * Absent means all of them. The desktop driver leaves `desktop.input` out until its `allowInput` option is on.
   */
  offered?(options: Readonly<Record<string, unknown>>): readonly DriverCapability[]
  invoke(call: CapabilityCall, ctx: DriverContext): CapabilityResult | Promise<CapabilityResult>
}

/** Every problem with a value that claims to be a driver (empty when it is one). */
export function driverProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) {
    return ['the entry must default-export a driver (defineDriver(...))']
  }
  const draft = value as Record<string, unknown>
  const problems: string[] = []
  const name = DriverNameSchema.safeParse(draft.name)
  if (!name.success) problems.push(`invalid driver name ${JSON.stringify(draft.name)}`)
  if (!DriverVersionSchema.safeParse(draft.version).success) {
    problems.push(`invalid driver version ${JSON.stringify(draft.version)}`)
  }
  if (!Array.isArray(draft.capabilities) || draft.capabilities.length === 0) {
    problems.push('capabilities must be a non-empty list')
  } else {
    const seen = new Set<string>()
    for (const item of draft.capabilities as unknown[]) {
      const cap = (item ?? {}) as Record<string, unknown>
      const id = CapabilityIdSchema.safeParse(cap.id)
      if (!id.success) {
        problems.push(`invalid capability id ${JSON.stringify(cap.id)}`)
        continue
      }
      if (name.success && driverOf(id.data) !== draft.name) {
        problems.push(`${id.data} does not start with the driver name ${String(draft.name)}`)
      }
      if (seen.has(id.data)) problems.push(`${id.data} is declared twice`)
      seen.add(id.data)
      if (!Number.isInteger(cap.schemaVersion) || (cap.schemaVersion as number) < 1) {
        problems.push(`${id.data} needs a schemaVersion of 1 or more`)
      }
    }
  }
  if (draft.start !== undefined && typeof draft.start !== 'function') {
    problems.push('start must be a function')
  }
  if (draft.offered !== undefined && typeof draft.offered !== 'function') {
    problems.push('offered must be a function')
  }
  if (typeof draft.invoke !== 'function') problems.push('invoke must be a function')
  return problems
}

/** Checks a driver definition and returns it typed; throws on a definition the node must not load. */
export function defineDriver<const D extends DriverDefinition>(definition: D): D {
  const problems = driverProblems(definition)
  if (problems.length > 0) throw new TypeError(`invalid driver: ${problems.join('; ')}`)
  return definition
}
