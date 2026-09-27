import { z } from 'zod'

/** Prefixes of Keith's prefixed ULIDs (`<prefix>_<ULID>`). See docs/rules/conventions.md#identifiers. */
export const ID_PREFIXES = {
  person: 'per',
  node: 'nod',
  thread: 'thr',
  message: 'msg',
  turn: 'trn',
  file: 'fil',
  task: 'tsk',
  commitment: 'cmt',
  delivery: 'dlv',
  memory: 'mem',
  window: 'win',
} as const

export type IdKind = keyof typeof ID_PREFIXES
export type IdPrefix = (typeof ID_PREFIXES)[IdKind]

/**
 * A ULID body: 26 Crockford base32 characters (no I, L, O, U). The first character is at most 7,
 * because a ULID's 48-bit timestamp fills only 3 bits of it.
 */
export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

export const Ulid = z.string().regex(ULID_PATTERN, 'expected a ULID (26 Crockford base32 characters)')

/** Schema for a prefixed ULID such as `thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31`. Inferred type: `` `thr_${string}` ``. */
export function prefixedId<P extends IdPrefix>(prefix: P) {
  return z.templateLiteral([`${prefix}_`, Ulid])
}

export const PersonId = prefixedId('per')
export type PersonId = z.infer<typeof PersonId>
export const NodeId = prefixedId('nod')
export type NodeId = z.infer<typeof NodeId>
export const ThreadId = prefixedId('thr')
export type ThreadId = z.infer<typeof ThreadId>
export const MessageId = prefixedId('msg')
export type MessageId = z.infer<typeof MessageId>
export const TurnId = prefixedId('trn')
export type TurnId = z.infer<typeof TurnId>
export const FileId = prefixedId('fil')
export type FileId = z.infer<typeof FileId>
export const TaskId = prefixedId('tsk')
export type TaskId = z.infer<typeof TaskId>
export const CommitmentId = prefixedId('cmt')
export type CommitmentId = z.infer<typeof CommitmentId>
export const DeliveryId = prefixedId('dlv')
export type DeliveryId = z.infer<typeof DeliveryId>
export const MemoryId = prefixedId('mem')
export type MemoryId = z.infer<typeof MemoryId>
export const WindowId = prefixedId('win')
export type WindowId = z.infer<typeof WindowId>

/** Returns true when `value` is a well-formed id with the given prefix. */
export function isPrefixedId<P extends IdPrefix>(prefix: P, value: unknown): value is `${P}_${string}` {
  return (
    typeof value === 'string' &&
    value.startsWith(`${prefix}_`) &&
    ULID_PATTERN.test(value.slice(prefix.length + 1))
  )
}
