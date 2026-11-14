import type { PersonRole } from '@keith/contracts'
import { OperationError } from './errors.ts'
import { SCHEDULE_KEY, type ScheduleWhen } from './schedule.ts'

/**
 * The protocol port of plugins (docs/specs/plugins/reminders.md, "Internals"; ADR-0024 §5). A plugin that wants a timed
 * step inside a protocol asks for it through `k.protocols`; the core implements the port over the hypothalamus service
 * (`apps/core/src/modules/hypothalamus/host-port.ts`). A plugin imports only this package, so it never sees the engine.
 */

/** The text limits of the two steps a plugin may add (the protocol contract's `notify` and `wake` text limits). */
export const PROTOCOL_NOTIFY_TEXT_MAX = 500
export const PROTOCOL_WAKE_TEXT_MAX = 1000

/** The steps a plugin may put in a timed protocol: a note (`notify`) or a turn (`wake`). Nothing else. */
export type PluginProtocolStep = 'notify' | 'wake'

/** The person who asks, as the host reads them at this call (never cached): the authoring rules read these. */
export interface ProtocolCaller {
  personId: string
  role: PersonRole
  capabilities: ReadonlySet<string>
  via: 'tcp' | 'local'
}

/**
 * A timed protocol of one plugin: `key` names it inside the plugin (unique per owner, `SCHEDULE_KEY` shape), `owner` is
 * the person it belongs to (the creator), `step` and `text` are the one fixed step. `to` is the person the step reaches;
 * it defaults to the owner. The text is stored as given: the engine never templates it.
 */
export interface ProtocolTimeInput {
  key: string
  owner: string
  when: ScheduleWhen
  step: PluginProtocolStep
  to?: string | undefined
  text: string
}

export interface ProtocolTimeInfo {
  key: string
  /** The protocol id the core stored (the run id is derived from it and the trigger ref). */
  protocolId: string
  /** The next slot (epoch ms), or null when a `once` protocol has fired. */
  nextFireAt: number | null
}

/** A run of a plugin's protocol reached an end state (`done`, `cancelled`, `failed`, `skipped` or `expired`). */
export interface ProtocolRunEnd {
  plugin: string
  key: string
  runId: string
  owner: string
  status: string
}

/** The port the core implements (one for every plugin; `plugin` is the caller's id). */
export interface ProtocolsPort {
  upsertTime(
    plugin: string,
    caller: ProtocolCaller,
    input: ProtocolTimeInput,
  ): Promise<ProtocolTimeInfo>
  /** Removes the protocol `key` of `owner`; `false` when there is none. */
  cancel(plugin: string, caller: ProtocolCaller, key: string, owner: string): Promise<boolean>
  /** Calls `handler` for every run of this plugin's protocols that reaches an end state. Returns the unsubscribe. */
  onRunEnd(plugin: string, handler: (end: ProtocolRunEnd) => void): () => void
}

/** What a plugin's operation sees as `k.protocols`: the caller is the actor of the call. */
export interface PluginProtocols {
  upsertTime(input: ProtocolTimeInput): Promise<ProtocolTimeInfo>
  cancel(key: string, owner: string): Promise<boolean>
}

/**
 * The checks the host makes before a plugin's request reaches the port: the key shape, the step kind and the step text
 * limit (a text over the limit is refused when it is created, never cut). Pure; the core re-checks the protocol contract.
 */
export function checkProtocolTime(input: ProtocolTimeInput): void {
  if (!SCHEDULE_KEY.test(input.key))
    throw new OperationError('INVALID_INPUT', 'the protocol key is not valid')
  if (input.step !== 'notify' && input.step !== 'wake')
    throw new OperationError('INVALID_INPUT', 'a timed protocol holds a notify or a wake step')
  const max = input.step === 'notify' ? PROTOCOL_NOTIFY_TEXT_MAX : PROTOCOL_WAKE_TEXT_MAX
  if (input.text.length === 0 || input.text.length > max)
    throw new OperationError('INVALID_INPUT', `the text must be 1 to ${max} characters`)
}
