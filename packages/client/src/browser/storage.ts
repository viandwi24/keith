// What a browser client remembers between visits, in `localStorage`. Nothing here is a secret (the session is an HttpOnly
// cookie). Every access is in a try/catch: a private window, blocked site data or a full quota make the value live in memory
// for this page only, and the app still works.
import type { ClientIdStore } from '../presence.ts'
import type { IdentifierMemory } from '../sign-in-types.ts'

/** The part of `Storage` that is used; tests pass a stub. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const platformStorage = (): StorageLike | undefined => {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export const CLIENT_ID_KEY = 'keith.clientId'
export const IDENTIFIER_KEY = 'keith.identifier'

/** The presence client id, kept in `localStorage` (one tab family of one browser profile is one client). */
export function localStorageClientIdStore(
  storage: StorageLike | undefined = platformStorage(),
  key: string = CLIENT_ID_KEY,
): ClientIdStore {
  let memory: string | undefined
  return {
    read() {
      try {
        const value = storage?.getItem(key)
        if (typeof value === 'string' && value !== '') return value
      } catch {
        // fall back to memory
      }
      return memory
    },
    write(id) {
      memory = id
      try {
        storage?.setItem(key, id)
      } catch {
        // kept in memory for this page only
      }
    },
  }
}

/** The identifier last used to sign in to each core, to pre-fill the box next time. Never a secret. */
export function localStorageIdentifierMemory(
  storage: StorageLike | undefined = platformStorage(),
  key: string = IDENTIFIER_KEY,
): IdentifierMemory {
  const memory = new Map<string, string>()
  const load = (): Record<string, string> => {
    try {
      const value = JSON.parse(storage?.getItem(key) ?? '{}') as unknown
      return typeof value === 'object' && value !== null ? (value as Record<string, string>) : {}
    } catch {
      return {}
    }
  }
  const trim = (core: string): string => core.replace(/\/+$/, '')
  return {
    read(core) {
      const value = memory.get(trim(core)) ?? load()[trim(core)]
      return typeof value === 'string' && value !== '' ? value : undefined
    },
    write(core, identifier) {
      memory.set(trim(core), identifier)
      try {
        storage?.setItem(key, JSON.stringify({ ...load(), [trim(core)]: identifier }))
      } catch {
        // the box starts empty next time
      }
    },
  }
}
