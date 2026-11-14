/** Types and row mapping of the SQLite `PersonStore` (see person-store.ts). */
import type {
  LinkedVia,
  Person,
  PersonAccount,
  PersonInput,
  PersonListQuery,
  PersonPatch,
  PersonStatus,
  PersonStore,
} from 'eharness/identity'
import type { AuditVia } from '../repos/audit.ts'

export type PersonRole = 'owner' | 'member'
export const DEFAULT_PERSON_ROLE: PersonRole = 'member'

/** A person with the Keith username (null only for a row the backfill has not reached). */
export interface KeithPerson extends Person {
  username: string | null
}
export interface KeithPersonInput extends PersonInput {
  /** Default: a new UUIDv7. */
  id?: string
  username?: string | null
}
export interface KeithPersonPatch extends PersonPatch {
  username?: string | null | undefined
}

export interface KeithPersonStore extends PersonStore {
  get(id: string): Promise<KeithPerson | undefined>
  list(query?: PersonListQuery): Promise<{ items: KeithPerson[]; total: number }>
  create(input: KeithPersonInput, actor: string | null, now: number): Promise<KeithPerson>
  update(
    id: string,
    patch: KeithPersonPatch,
    actor: string | null,
    now: number,
  ): Promise<KeithPerson>
  byAccount(
    platform: string,
    nativeId: string,
  ): Promise<{ person: KeithPerson; account: PersonAccount } | undefined>
  byUsername(username: string): Promise<KeithPerson | undefined>
  /** The current owner (exactly one exists after setup). */
  owner(): Promise<KeithPerson | undefined>
  /**
   * Make `toId` the owner and `fromId` a member in one transaction. Rejects `INVALID_PERSON` when
   * `fromId` is not the owner, or `toId` is the owner or not active.
   */
  transferOwner(
    fromId: string,
    toId: string,
    actor: string | null,
    now: number,
  ): Promise<{ owner: KeithPerson; previousOwner: KeithPerson }>
  /**
   * The succession variant of `transferOwner` (docs/specs/succession.md, "The claim"): the same role swap, and in the
   * same transaction the previous owner becomes `suspended`. Same refusals as `transferOwner`.
   */
  succeed(
    fromId: string,
    toId: string,
    actor: string | null,
    now: number,
    /** Runs in the same transaction after the swap; a throw rolls the whole transaction back. */
    inside?: () => void,
  ): Promise<{ owner: KeithPerson; previousOwner: KeithPerson }>
  /** The same store writing its events with another `via`. */
  withVia(via: AuditVia): KeithPersonStore
}

export interface PersonRow {
  id: string
  name: string
  role: string
  created_at: number
  username: string | null
  status: string
  nickname: string | null
  notes: string
  fields: string
  divisions: string
  member_id: string | null
  created_by: string | null
  updated_at: number
}
export interface AccountRow {
  id: string
  person_id: string
  platform: string
  native_id: string
  label: string | null
  status: string
  linked_via: string
  linked_by: string | null
  linked_at: number
  revoked_at: number | null
}

export const person = (r: PersonRow): KeithPerson => ({
  id: r.id,
  displayName: r.name,
  nickname: r.nickname,
  status: r.status as PersonStatus,
  role: r.role,
  divisions: JSON.parse(r.divisions) as string[],
  fields: JSON.parse(r.fields) as Record<string, string>,
  notes: r.notes,
  memberId: r.member_id,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  username: r.username,
})
export const account = (r: AccountRow): PersonAccount => ({
  id: r.id,
  personId: r.person_id,
  platform: r.platform,
  nativeId: r.native_id,
  label: r.label,
  status: r.status as 'linked' | 'revoked',
  linkedVia: r.linked_via as LinkedVia,
  linkedBy: r.linked_by,
  linkedAt: r.linked_at,
  revokedAt: r.revoked_at,
})
