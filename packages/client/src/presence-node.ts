// The Node/Bun entry's `createPresenceReporter`: the browser-safe reporter (presence.ts) with the id kept in
// `client-state.json` next to `client.json` unless the caller passes a `store`.
import type { KeithClient } from './client.ts'
import { fileClientIdStore } from './identifier-memory.ts'
import {
  createPresenceReporter as createBareReporter,
  type PresenceReporter,
  type PresenceReporterOptions,
} from './presence.ts'

export function createPresenceReporter(
  client: KeithClient,
  options: PresenceReporterOptions,
): PresenceReporter {
  return createBareReporter(client, { store: fileClientIdStore(), ...options })
}
