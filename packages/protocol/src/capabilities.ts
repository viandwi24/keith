import { z } from 'zod'

/** Capabilities with a defined meaning. See docs/architecture/nodes.md#capabilities. */
export const KNOWN_CAPABILITIES = [
  'chat.text@1',
  'ui.render@1',
  'audio.in@1',
  'audio.out@1',
  'workspace@1',
  'notify@1',
  'fs@1',
  'screen.capture@1',
] as const

export type KnownCapability = (typeof KNOWN_CAPABILITIES)[number]

/** `name@major`: dot-separated lowercase segments, then a positive major version. */
export const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*@[1-9][0-9]*$/

/**
 * A capability id. Nodes may declare capabilities the core does not know; the core ignores them.
 * They must still be well-formed.
 */
export const Capability = z.string().regex(CAPABILITY_PATTERN, 'expected a capability id like chat.text@1')
export type Capability = z.infer<typeof Capability>

export type ParsedCapability = { name: string; major: number }

/** Splits `name@major`. Returns null when the id is malformed. */
export function parseCapability(id: string): ParsedCapability | null {
  if (!CAPABILITY_PATTERN.test(id)) return null
  const at = id.lastIndexOf('@')
  return { name: id.slice(0, at), major: Number(id.slice(at + 1)) }
}

export function isKnownCapability(id: string): id is KnownCapability {
  return (KNOWN_CAPABILITIES as readonly string[]).includes(id)
}

/** True when `declared` contains every capability in `required` (exact `name@major` match). */
export function hasCapabilities(declared: readonly string[], required: readonly string[]): boolean {
  return required.every((cap) => declared.includes(cap))
}
