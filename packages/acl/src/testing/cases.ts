import type { AclActor, Entry } from '@keith/contracts'
import { Bits } from '@keith/contracts'
import { defineKinds, type KindRegistry } from '../kinds.ts'

/**
 * The conformance data of P15: the six sharing cases of the owner and the actors they are run for.
 * Both the in-memory store and the SQLite adapter run these (docs/specs/acl.md, "The six cases").
 */

/** The kinds the cases use, one per class. */
export const CASE_KINDS: KindRegistry = defineKinds({
  note: { class: 'leaf' },
  notebook: { class: 'container' },
  tool: { class: 'operation' },
  reminder: { class: 'action' },
})

/** Groups of the cases and who is in them. */
export const CASE_GROUPS: Record<string, string[]> = {
  A: ['mia'],
  B: ['ben'],
  C: ['cai'],
}

/** Every active person of the cases (the guest is not a person). */
export const CASE_PEOPLE = ['boss', 'olga', 'mia', 'ben', 'cai', 'duta', 'amel', 'oscar'] as const

export type CaseActorName =
  | 'owner'
  | 'a'
  | 'b'
  | 'c'
  | 'duta'
  | 'amel'
  | 'outsider'
  | 'guest'
  | 'boss'

/** The resource owner is `olga`; `boss` is the instance owner (role owner), the root reader. */
export const CASE_ACTORS: Record<CaseActorName, AclActor> = {
  owner: { kind: 'user', id: 'olga', role: 'member' },
  a: { kind: 'user', id: 'mia', role: 'member' },
  b: { kind: 'user', id: 'ben', role: 'member' },
  c: { kind: 'user', id: 'cai', role: 'member' },
  duta: { kind: 'user', id: 'duta', role: 'member' },
  amel: { kind: 'user', id: 'amel', role: 'member' },
  outsider: { kind: 'user', id: 'oscar', role: 'member' },
  guest: { kind: 'guest', id: 'guest:g1', role: null },
  boss: { kind: 'user', id: 'boss', role: 'owner' },
}

export interface SharingCase {
  name: string
  mode: number
  entries: Entry[]
  /** Who may read (`r`) on a note by the rules alone. `boss` (the instance owner) always reads too; when absent here, that read is root access and audited. */
  readers: CaseActorName[]
}

const allow = (subject: string, bits = Bits.R): Entry => ({ subject, bits, effect: 'allow' })
const deny = (subject: string, bits = Bits.R): Entry => ({ subject, bits, effect: 'deny' })

export const SHARING_CASES: SharingCase[] = [
  { name: '1 private', mode: 0o600, entries: [], readers: ['owner'] },
  {
    name: '2 public read',
    mode: 0o604,
    entries: [],
    readers: ['owner', 'a', 'b', 'c', 'duta', 'amel', 'outsider', 'guest', 'boss'],
  },
  {
    name: '3 users, no guests',
    mode: 0o600,
    entries: [allow('@users')],
    readers: ['owner', 'a', 'b', 'c', 'duta', 'amel', 'outsider', 'boss'],
  },
  {
    name: '4 groups A and B, not C',
    mode: 0o600,
    entries: [allow('group:A'), allow('group:B')],
    readers: ['owner', 'a', 'b'],
  },
  {
    name: '4b a broad share minus group C',
    mode: 0o600,
    entries: [allow('@users'), deny('group:C')],
    readers: ['owner', 'a', 'b', 'duta', 'amel', 'outsider', 'boss'],
  },
  {
    name: '5 Duta and Amel',
    mode: 0o600,
    entries: [allow('user:duta'), allow('user:amel')],
    readers: ['owner', 'duta', 'amel'],
  },
  { name: '6 Duta only', mode: 0o600, entries: [allow('user:duta')], readers: ['owner', 'duta'] },
]

export const CASE_ACTOR_NAMES = Object.keys(CASE_ACTORS) as CaseActorName[]
