import type { AuthMethod } from './types.ts'

export interface AuthRegistry {
  /** In registration order (the legacy list is `device`, `password`, `token`). */
  list(): readonly AuthMethod[]
  get(id: string): AuthMethod | undefined
}

export function createAuthRegistry(methods: readonly AuthMethod[]): AuthRegistry {
  const byId = new Map<string, AuthMethod>()
  for (const m of methods) {
    if (byId.has(m.id)) throw new Error(`auth method "${m.id}" is registered twice`)
    byId.set(m.id, m)
  }
  return { list: () => [...byId.values()], get: (id) => byId.get(id) }
}
