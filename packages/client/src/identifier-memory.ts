import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultConfigPath, writeFileAtomic } from './config.ts'
import type { IdentifierMemory } from './sign-in-types.ts'

/** `client-state.json` next to `client.json`: what the client remembers that is not a secret. */
export const clientStatePath = (configPath: string = defaultConfigPath()): string =>
  join(dirname(configPath), 'client-state.json')

type State = {
  identifiers?: Record<string, string>
  /** The single id of older clients (read as the fallback of every person). */
  clientId?: string
  /** One id per person on this machine (docs/specs/client.md, "Presence reporter"). */
  clientIds?: Record<string, string>
}

function read(path: string): State {
  try {
    if (!existsSync(path)) return {}
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return typeof value === 'object' && value !== null ? (value as State) : {}
  } catch {
    return {}
  }
}

const trimUrl = (core: string): string => core.replace(/\/+$/, '')

/**
 * The identifier last used to sign in to each core (a user id, username, email or phone: never a
 * secret), kept in `client-state.json` so the next start pre-fills the sign-in box. Reads and
 * writes never throw: a client that cannot remember simply starts with an empty box.
 */
export function fileIdentifierMemory(configPath?: string): IdentifierMemory {
  const path = clientStatePath(configPath)
  return {
    read(core) {
      const value = read(path).identifiers?.[trimUrl(core)]
      return typeof value === 'string' && value !== '' ? value : undefined
    },
    write(core, identifier) {
      try {
        const state = read(path)
        const identifiers = { ...state.identifiers, [trimUrl(core)]: identifier }
        writeFileAtomic(path, `${JSON.stringify({ ...state, identifiers }, null, 2)}\n`)
      } catch {
        // nothing to remember with: the box starts empty next time
      }
    },
  }
}

/**
 * The presence client's id (a uuid the core records as the client): kept in `client-state.json` beside the identifiers,
 * written with the other fields intact. Reads and writes never throw; a client without a stored id gets a new one.
 *
 * With a `personId` the id is kept per person (`clientIds[personId]`), so each person signing in on one terminal has
 * their own client. A person with no entry reads the legacy single `clientId` (older files), which the reporter claims
 * for that person on its first successful register. Without a `personId` only the legacy field is used.
 */
export function fileClientIdStore(
  configPath?: string,
  personId?: string,
): {
  read(): string | undefined
  write(id: string): void
} {
  const path = clientStatePath(configPath)
  const valid = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined
  return {
    read() {
      const state = read(path)
      const own = personId === undefined ? undefined : valid(state.clientIds?.[personId])
      return own ?? valid(state.clientId)
    },
    write(id) {
      try {
        const state = read(path)
        const next =
          personId === undefined
            ? { ...state, clientId: id }
            : { ...state, clientIds: { ...state.clientIds, [personId]: id } }
        writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`)
      } catch {
        // the id is then new on the next start: the core keeps the old record as forgotten (90 days)
      }
    },
  }
}
