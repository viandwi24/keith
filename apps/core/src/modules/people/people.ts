import {
  type IdentityChangedReason,
  type OwnerTransferred,
  type Person,
  USERNAME_MESSAGE,
  USERNAME_RE,
} from '@keith/contracts'
import { DEFAULT_PERSON_ROLE, type KeithPerson, type KeithPersonStore } from '@keith/db'
import { isIdentityError } from 'eharness/identity'
import type { Audit } from '../audit/index.ts'
import type { RemovalService } from './removed.ts'
import type { SuccessionProof } from './succession-proof.ts'

/** A refused people operation; procedures map the code to an HTTP-ish oRPC error. */
export class PeopleError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT' | 'FORBIDDEN',
    message: string,
  ) {
    super(message)
    this.name = 'PeopleError'
  }
}

/** Who asks and through which listener (the store writes both into the audit event). */
export interface PeopleCaller {
  actor: string
  /** `offline`: setup and the other offline admin commands (ADR-0027 §7). */
  via: 'local' | 'tcp' | 'offline'
}

export interface PeopleService {
  list(): Promise<Person[]>
  get(ref: string): Promise<Person>
  /**
   * Resolve the target of a people-management act and refuse (`FORBIDDEN`) a caller who is not the
   * owner when the target is the owner, or (with `notSelf`) the caller. An actor that is no person
   * (`system`, the offline CLI) acts as the owner.
   */
  authorize(
    ref: string,
    by: PeopleCaller,
    what: string,
    options?: { notSelf?: boolean },
  ): Promise<Person>
  /** The current owner (follows a transfer), if any. */
  owner(): Promise<Person | undefined>
  /** Refuses (`FORBIDDEN`) a caller who is not the owner; an actor that is no person acts as the owner. */
  requireOwner(by: PeopleCaller, what: string): Promise<void>
  add(
    input: { username: string; name?: string | undefined; role?: string | undefined },
    by: PeopleCaller,
  ): Promise<Person>
  rename(
    ref: string,
    change: { username?: string | undefined; name?: string | undefined },
    by: PeopleCaller,
  ): Promise<Person>
  setRole(ref: string, role: string, by: PeopleCaller): Promise<Person>
  suspend(ref: string, by: PeopleCaller): Promise<Person>
  reactivate(ref: string, by: PeopleCaller): Promise<Person>
  /**
   * Keep the person's data for the keep time (ADR-0027 §26), then delete the person and their
   * credentials; the audit log keeps the story. A refused keep refuses the removal and changes nothing.
   */
  remove(ref: string, by: PeopleCaller): Promise<RemovedPerson>
  /** Atomic: `ref` becomes the owner, the caller's person a member. */
  transferOwner(ref: string, by: PeopleCaller): Promise<OwnerTransferred>
  /**
   * The heir's claim (docs/specs/succession.md, "The claim"): `ref` becomes the owner and the previous owner is suspended,
   * in one transaction. Not an RPC procedure and not a CLI command: the `proof` is minted only by the succession module.
   * The heir must be active, able to sign in and hold a secret (F-013); plain `transferOwner` is unchanged.
   */
  succeed(
    ref: string,
    proof: SuccessionProof,
    by: PeopleCaller,
    /** Runs in the swap's transaction (after the swap); a throw rolls the ownership change back too. */
    inside?: () => void,
  ): Promise<OwnerTransferred>
  /**
   * Turn a member's sign-in on or off (ADR-0027 §27). Owner only; the owner is refused. Off revokes the
   * person's sessions and keeps their credentials stored; on changes nothing else.
   */
  setLogin(ref: string, canLogin: boolean, by: PeopleCaller): Promise<Person>
}

/** A removed person: when their kept data is purged (`null` without a removal service). */
export interface RemovedPerson {
  id: string
  keptUntil: number | null
}

export interface PeopleOptions {
  store: KeithPersonStore
  now?: () => number
  /**
   * Revoke every session of a person (credentials and legacy tokens) and return how many. Called on
   * suspend, role change and owner transfer (docs/specs/people.md). Default: nothing to revoke.
   */
  revoke?: (personId: string) => number
  /** Whether a person has a password or a PIN (a new owner needs one, F-013). Default: no check. */
  hasSecret?: (personId: string) => boolean
  /** Records `person.sessions.revoked`. */
  audit?: Audit
  /**
   * A person's access changed (suspend, role, transfer, remove): the core closes their open streams
   * and writes `identity.changed` (docs/specs/thalamus.md). Default: nothing.
   */
  onAccessChanged?: (personId: string, reason: IdentityChangedReason) => void
  /** Keeps a removed person's data (`removed.ts`). Default: nothing is kept (tests without the core's parts). */
  removal?: Pick<RemovalService, 'keep'>
  /** `people.can_login` (identifiers repo): read on every view, written by `setLogin`. */
  signIn: {
    canLogin(personId: string): boolean
    setCanLogin(personId: string, canLogin: boolean): boolean
  }
}

export const toPerson = (p: KeithPerson, canLogin: boolean): Person => ({
  id: p.id,
  username: p.username,
  name: p.displayName,
  role: p.role === 'owner' ? 'owner' : DEFAULT_PERSON_ROLE,
  // a row that still says `left` (never written; the backfill maps it) is denied like a suspended one
  status: p.status === 'active' ? 'active' : 'suspended',
  canLogin,
  createdBy: p.createdBy,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
})

/**
 * People management (docs/specs/people.md): exactly one owner (the database allows one, the rules
 * here explain why), unique usernames, status changes and removal. Every change is a person event
 * written by the store into `audit_events`.
 */
export function createPeopleService(options: PeopleOptions): PeopleService {
  const now = options.now ?? Date.now
  const storeOf = (by: PeopleCaller) => options.store.withVia(by.via)
  const view = (p: KeithPerson): Person => toPerson(p, options.signIn.canLogin(p.id))
  /** Sign a person out everywhere: their role or standing changed, so old sessions must not carry it. */
  const revokeSessions = (personId: string, reason: string, by: PeopleCaller): void => {
    const count = options.revoke?.(personId) ?? 0
    if (count > 0)
      options.audit?.record({
        kind: 'person.sessions.revoked',
        actor: by.actor,
        via: by.via,
        detail: { personId, subject: personId, reason, count },
      })
  }
  const find = async (ref: string): Promise<KeithPerson> => {
    const found =
      (await options.store.get(ref)) ?? (await options.store.byUsername(ref.trim().toLowerCase()))
    if (found === undefined) throw new PeopleError('NOT_FOUND', `no person ${ref}`)
    return found
  }
  /** Run a store call; a rejected identity change becomes a conflict (never a 500). */
  const guarded = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      if (isIdentityError(error, 'INVALID_PERSON')) throw new PeopleError('CONFLICT', error.message)
      if (isIdentityError(error, 'PERSON_NOT_FOUND'))
        throw new PeopleError('NOT_FOUND', error.message)
      throw error
    }
  }
  const notOwner = (p: KeithPerson, what: string): void => {
    if (p.role === 'owner')
      throw new PeopleError(
        'BAD_REQUEST',
        `${p.username ?? p.id} is the owner: ${what} (there is exactly one owner; use transfer-owner first)`,
      )
  }
  const ownerOnly = async (by: PeopleCaller, what: string): Promise<void> => {
    if (!(await callerIsOwner(by))) throw new PeopleError('FORBIDDEN', `only the owner can ${what}`)
  }
  const callerIsOwner = async (by: PeopleCaller): Promise<boolean> => {
    const caller = await options.store.get(by.actor)
    return caller === undefined || caller.role === 'owner'
  }
  const username = (raw: string): string => {
    const value = raw.trim().toLowerCase()
    if (!USERNAME_RE.test(value)) throw new PeopleError('BAD_REQUEST', USERNAME_MESSAGE)
    return value
  }
  const taken = async (name: string, except?: string): Promise<void> => {
    const other = await options.store.byUsername(name)
    if (other !== undefined && other.id !== except)
      throw new PeopleError('CONFLICT', `the username ${name} is taken`)
  }
  const setStatus = async (ref: string, status: 'active' | 'suspended', by: PeopleCaller) => {
    const person = await find(ref)
    if (status === 'suspended') notOwner(person, 'it cannot be suspended')
    if (person.status === status) return view(person)
    const updated = view(
      await guarded(() => storeOf(by).update(person.id, { status }, by.actor, now())),
    )
    if (status === 'suspended') {
      revokeSessions(person.id, 'suspend', by)
      options.onAccessChanged?.(person.id, 'suspend')
    }
    return updated
  }

  return {
    async list() {
      return (await options.store.list()).items.map((p) => view(p))
    },
    async get(ref) {
      return view(await find(ref))
    },
    async authorize(ref, by, what, opts) {
      const person = await find(ref)
      const owner = await callerIsOwner(by)
      if (!owner && person.role === 'owner')
        throw new PeopleError('FORBIDDEN', `only the owner can ${what} the owner`)
      if (!owner && opts?.notSelf === true && person.id === by.actor)
        throw new PeopleError('FORBIDDEN', `you cannot ${what} yourself`)
      return view(person)
    },
    async owner() {
      const owner = await options.store.owner()
      return owner === undefined ? undefined : view(owner)
    },
    async requireOwner(by, what) {
      await ownerOnly(by, what)
    },
    async add(input, by) {
      const name = username(input.username)
      if (input.role !== undefined && input.role !== 'member')
        throw new PeopleError(
          'BAD_REQUEST',
          input.role === 'owner'
            ? 'there is exactly one owner: add a member, then transfer-owner'
            : `unknown role ${input.role} (owner or member)`,
        )
      await taken(name)
      const created = await guarded(() =>
        storeOf(by).create(
          { displayName: input.name ?? name, username: name, role: DEFAULT_PERSON_ROLE },
          by.actor,
          now(),
        ),
      )
      return view(created)
    },
    async rename(ref, change, by) {
      const person = await find(ref)
      await this.authorize(ref, by, 'rename')
      const patch: { username?: string; displayName?: string } = {}
      if (change.username !== undefined) {
        patch.username = username(change.username)
        await taken(patch.username, person.id)
      }
      if (change.name !== undefined) patch.displayName = change.name
      return view(await guarded(() => storeOf(by).update(person.id, patch, by.actor, now())))
    },
    async setRole(ref, role, by) {
      const person = await find(ref)
      if (role === 'owner')
        throw new PeopleError('BAD_REQUEST', 'there is exactly one owner: use transfer-owner')
      if (role !== 'member') throw new PeopleError('BAD_REQUEST', `unknown role ${role}`)
      notOwner(person, 'its role cannot change')
      const updated = view(
        await guarded(() => storeOf(by).update(person.id, { role }, by.actor, now())),
      )
      if (view(person).role !== updated.role) {
        revokeSessions(person.id, 'role', by)
        options.onAccessChanged?.(person.id, 'role')
      }
      return updated
    },
    suspend: (ref, by) => setStatus(ref, 'suspended', by),
    reactivate: (ref, by) => setStatus(ref, 'active', by),
    async remove(ref, by) {
      const person = await find(ref)
      notOwner(person, 'it cannot be removed')
      const kept = await options.removal?.keep(view(person))
      try {
        await guarded(() => storeOf(by).delete(person.id, by.actor, now()))
      } catch (error) {
        await kept?.undo()
        throw error
      }
      if (kept !== undefined)
        options.audit?.record({
          kind: 'person.removed.kept',
          actor: by.actor,
          via: by.via,
          detail: { person: person.id, subject: person.id, until: kept.keptUntil },
        })
      options.onAccessChanged?.(person.id, 'remove')
      return { id: person.id, keptUntil: kept?.keptUntil ?? null }
    },
    async succeed(ref, _proof, by, inside) {
      const target = await find(ref)
      const current = await options.store.owner()
      if (current === undefined) throw new PeopleError('BAD_REQUEST', 'there is no owner')
      const name = target.username ?? target.id
      if (target.id === current.id || target.role === 'owner')
        throw new PeopleError('BAD_REQUEST', `${name} is already the owner`)
      if (target.status !== 'active') throw new PeopleError('BAD_REQUEST', `${name} is not active`)
      if (!options.signIn.canLogin(target.id))
        throw new PeopleError('BAD_REQUEST', `${name} cannot sign in`)
      if (options.hasSecret !== undefined && !options.hasSecret(target.id))
        throw new PeopleError('BAD_REQUEST', `${name} has no password or PIN`)
      const moved = await guarded(() =>
        storeOf(by).succeed(current.id, target.id, by.actor, now(), inside),
      )
      // both lose their sessions; the previous owner is now suspended, the heir signs in again as owner
      revokeSessions(moved.owner.id, 'transfer', by)
      revokeSessions(moved.previousOwner.id, 'transfer', by)
      options.onAccessChanged?.(moved.owner.id, 'transfer')
      options.onAccessChanged?.(moved.previousOwner.id, 'suspend')
      return { owner: view(moved.owner), previousOwner: view(moved.previousOwner) }
    },
    async setLogin(ref, canLogin, by) {
      await ownerOnly(by, "switch a person's sign-in")
      const person = await find(ref)
      notOwner(person, 'its sign-in cannot be switched')
      if (person.id === by.actor)
        throw new PeopleError('BAD_REQUEST', 'you cannot switch your own sign-in')
      if (options.signIn.setCanLogin(person.id, canLogin)) {
        options.audit?.record({
          kind: 'person.login.set',
          actor: by.actor,
          via: by.via,
          detail: { person: person.id, subject: person.id, canLogin },
        })
        if (!canLogin) revokeSessions(person.id, 'sign-in', by)
        options.onAccessChanged?.(person.id, 'can_login')
      }
      return view(person)
    },
    async transferOwner(ref, by) {
      const target = await find(ref)
      const current = await options.store.owner()
      if (current === undefined) throw new PeopleError('BAD_REQUEST', 'there is no owner')
      if (!(await callerIsOwner(by)))
        throw new PeopleError('FORBIDDEN', 'only the owner can transfer ownership')
      if (options.hasSecret !== undefined && !options.hasSecret(target.id))
        throw new PeopleError(
          'BAD_REQUEST',
          `${target.username ?? target.id} has no password or PIN: set one first`,
        )
      if (target.id === current.id)
        throw new PeopleError('BAD_REQUEST', `${target.username ?? target.id} is already the owner`)
      if (target.status !== 'active')
        throw new PeopleError(
          'BAD_REQUEST',
          `${target.username ?? target.id} is not active: reactivate first`,
        )
      // FD13-02: the owner must be able to sign in remotely; the owner's own switch cannot be set (setLogin refuses it)
      const name = target.username ?? target.id
      if (!options.signIn.canLogin(target.id))
        throw new PeopleError(
          'BAD_REQUEST',
          `${name} cannot sign in: turn sign-in on first (keith-core people login ${name} on)`,
        )
      const moved = await guarded(() =>
        storeOf(by).transferOwner(current.id, target.id, by.actor, now()),
      )
      // both lose their sessions: the new owner must step up as owner, the former one as a member
      // (the local socket has no credential and follows the role by itself)
      revokeSessions(moved.owner.id, 'transfer', by)
      revokeSessions(moved.previousOwner.id, 'transfer', by)
      options.onAccessChanged?.(moved.owner.id, 'transfer')
      options.onAccessChanged?.(moved.previousOwner.id, 'transfer')
      return { owner: view(moved.owner), previousOwner: view(moved.previousOwner) }
    },
  }
}
