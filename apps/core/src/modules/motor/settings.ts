import {
  NODE_CALL_LIMIT_DEFAULT,
  NODE_CALL_LIMIT_MAX,
  NODE_CALL_LIMIT_MIN,
  type NodeSettings,
  NodeSettingsSchema,
} from '@keith/contracts'
import type { SettingsRepo } from '@keith/db'

/** Setting key: calls per hour one person may make to a capability with `approval: 'never'` (default 60; ADR-0027 §9, P31.1.6). */
export const NODE_CALL_LIMIT_KEY = 'nodes.sandbox.maxPerHourPerPerson'
export { NODE_CALL_LIMIT_DEFAULT, NODE_CALL_LIMIT_MAX, NODE_CALL_LIMIT_MIN }

const isLimit = (value: unknown): value is number =>
  NodeSettingsSchema.shape.maxPerHourPerPerson.safeParse(value).success

/** Reads the limit in force: the stored setting, else 60. A corrupt value reads as the default, never as "unlimited". */
export function createNodeCallLimit(settings: Pick<SettingsRepo, 'get'>): () => number {
  return () => {
    const stored = settings.get<unknown>(NODE_CALL_LIMIT_KEY)
    return isLimit(stored) ? stored : NODE_CALL_LIMIT_DEFAULT
  }
}

/**
 * The owner's view of the limit (`nodes.settings.get|set`). `set` checks the bounds again (the contract checks them for the
 * RPC too) and returns the value before and after, the audit detail `{ from, to }`. A value out of bounds throws `RangeError`
 * and nothing is written.
 */
export interface NodeCallLimitSettings {
  get(): NodeSettings
  set(value: number): { from: NodeSettings; to: NodeSettings }
}

export function createNodeCallLimitSettings(
  settings: Pick<SettingsRepo, 'get' | 'set'>,
): NodeCallLimitSettings {
  const read = createNodeCallLimit(settings)
  return {
    get: () => ({ maxPerHourPerPerson: read() }),
    set(value) {
      const checked = NodeSettingsSchema.safeParse({ maxPerHourPerPerson: value })
      if (!checked.success) throw new RangeError(`${NODE_CALL_LIMIT_KEY} is out of its bounds`)
      const from = { maxPerHourPerPerson: read() }
      settings.set(NODE_CALL_LIMIT_KEY, checked.data.maxPerHourPerPerson)
      return { from, to: { maxPerHourPerPerson: checked.data.maxPerHourPerPerson } }
    },
  }
}
