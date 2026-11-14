// The activity logs on the client (docs/specs/activity-logs.md "RPC", docs/specs/client.md "Activity logs"). `logsApiOf` wraps the
// `rpc.logs.*` procedures in one typed object, like `personaApiOf`: each method is the procedure of the same name, typed by
// `@keith/contracts`. The owner path (another person, the settings) and a purge over TCP need the step-up of the call; the server
// refuses them without it (the client does not check).
import type {
  LogsCallOutput,
  LogsPurgeInput,
  LogsPurgeOutput,
  LogsRawOutput,
  LogsSessionsInput,
  LogsSessionsOutput,
  LogsSettings,
  LogsSettingsSet,
  LogsStatus,
} from '@keith/contracts'
import type { KeithClient } from './client.ts'

/** The input of `logs.session` (`{ id }`), derived from the contract's procedure. */
export type LogsSessionInput = Parameters<KeithClient['rpc']['logs']['session']>[0]
/** The input of `logs.call` (`{ id }`), derived from the contract's procedure. */
export type LogsCallInput = Parameters<KeithClient['rpc']['logs']['call']>[0]
/** The input of `logs.raw` (`{ callId }`), derived from the contract's procedure. */
export type LogsRawInput = Parameters<KeithClient['rpc']['logs']['raw']>[0]
/** The output of `logs.session` (the overview and the generations), derived from the contract's procedure. */
export type LogsSessionOutput = Awaited<ReturnType<KeithClient['rpc']['logs']['session']>>

/** The activity logs API of one client: each method is one `rpc.logs.*` procedure, typed by `@keith/contracts`. */
export interface LogsApi {
  status(): Promise<LogsStatus>
  settings: {
    get(): Promise<LogsSettings>
    set(input: LogsSettingsSet): Promise<LogsSettings>
  }
  sessions(input?: LogsSessionsInput): Promise<LogsSessionsOutput>
  session(input: LogsSessionInput): Promise<LogsSessionOutput>
  call(input: LogsCallInput): Promise<LogsCallOutput>
  raw(input: LogsRawInput): Promise<LogsRawOutput>
  purge(input: LogsPurgeInput): Promise<LogsPurgeOutput>
}

/** The activity logs API over a client's typed `rpc` (`client.logs` is this for the client it was created with). */
export function logsApiOf(client: Pick<KeithClient, 'rpc'>): LogsApi {
  const { logs } = client.rpc
  return {
    status: () => logs.status(),
    settings: {
      get: () => logs.settings.get(),
      set: (input) => logs.settings.set(input),
    },
    sessions: (input = {}) => logs.sessions(input),
    session: (input) => logs.session(input),
    call: (input) => logs.call(input),
    raw: (input) => logs.raw(input),
    purge: (input) => logs.purge(input),
  }
}
