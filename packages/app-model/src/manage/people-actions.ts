import type { KeithClient } from '@keith/client'
import { CAPABILITY_IDS, OWNER_ONLY_CAPABILITIES, type Person } from '@keith/contracts'
import { personKinds, personLabel } from './people-state.ts'
import type { ActionSpec } from './types.ts'

const same = (a: string, b: string): Error | undefined =>
  a === b ? undefined : new Error('the two entries differ: nothing was changed')

/** What a member can be given when the core did not say (its own ids, minus the owner-only ones). */
const grantable: readonly string[] = CAPABILITY_IDS.filter(
  (c) => !(OWNER_ONLY_CAPABILITIES as readonly string[]).includes(c),
)

/** Add a person (a member; the owner changes by transfer). */
export function addAction(client: KeithClient): ActionSpec {
  return {
    id: 'people.add',
    label: 'Add a person',
    fields: [
      { id: 'username', label: 'Username', placeholder: 'ana' },
      {
        id: 'name',
        label: 'Display name',
        optional: true,
        placeholder: 'defaults to the username',
      },
    ],
    run: async (v) => {
      const name = (v.name ?? '').trim()
      const person = await client.rpc.admin.people.add({
        username: (v.username ?? '').trim().toLowerCase(),
        ...(name === '' ? {} : { name }),
      })
      return { message: `added ${personLabel(person)} (${person.role})` }
    },
  }
}

/**
 * Every action on one person, as the same `client.rpc.admin.people.*` calls `keith-core people` makes.
 * `owner` is the viewer's role: the sign-in switch is the owner's alone (ADR-0027 §27), so a delegate never sees it.
 */
export function personActions(
  client: KeithClient,
  p: Person,
  capabilities: readonly string[] = grantable,
  owner = false,
): ActionSpec[] {
  // messages show the username; calls address the stable id, so a rename (or a re-added name) cannot move the action
  const person = personLabel(p)
  const ref = p.id
  const kinds = personKinds(p)
  const api = client.rpc.admin.people
  const actions: ActionSpec[] = [
    {
      id: 'people.rename',
      label: 'Rename',
      hint: 'username or display name',
      fields: [
        { id: 'username', label: 'Username', initial: p.username ?? '', optional: true },
        { id: 'name', label: 'Display name', initial: p.name, optional: true },
      ],
      run: async (v) => {
        const username = (v.username ?? '').trim().toLowerCase()
        const name = (v.name ?? '').trim()
        const changed = {
          ...(username !== '' && username !== p.username ? { username } : {}),
          ...(name !== '' && name !== p.name ? { name } : {}),
        }
        if (Object.keys(changed).length === 0) throw new Error('nothing changed')
        const done = await api.rename({ person: ref, ...changed })
        return { message: `${personLabel(done)}: ${done.name}` }
      },
    },
  ]
  if (kinds.role)
    actions.push({
      id: 'people.role',
      label: 'Set role',
      fields: [{ id: 'role', label: 'Role', options: ['member', 'owner'], initial: p.role }],
      run: async (v) => {
        const done = await api.setRole({
          person: ref,
          role: v.role === 'owner' ? 'owner' : 'member',
        })
        return { message: `${personLabel(done)}: ${done.role}` }
      },
    })
  if (kinds.suspend)
    actions.push({
      id: 'people.suspend',
      label: 'Suspend',
      hint: 'deny access until reactivated',
      run: async () => {
        const done = await api.suspend({ person: ref })
        return { message: `${personLabel(done)}: ${done.status}` }
      },
    })
  if (kinds.reactivate)
    actions.push({
      id: 'people.reactivate',
      label: 'Reactivate',
      run: async () => {
        const done = await api.reactivate({ person: ref })
        return { message: `${personLabel(done)}: ${done.status}` }
      },
    })
  actions.push(
    {
      id: 'people.password',
      label: 'Set password',
      hint: 'signs them out everywhere',
      fields: [
        { id: 'password', label: 'Password', secret: true },
        { id: 'repeat', label: 'Repeat', secret: true },
      ],
      run: async (v) => {
        const mismatch = same(v.password ?? '', v.repeat ?? '')
        if (mismatch !== undefined) throw mismatch
        await api.setPassword({ person: ref, password: v.password ?? '' })
        return { message: `${person}: password set (their sessions were revoked)` }
      },
    },
    {
      id: 'people.pin',
      label: 'Set PIN',
      hint: '6-12 digits, confirms step-up',
      fields: [
        { id: 'pin', label: 'PIN', secret: true },
        { id: 'repeat', label: 'Repeat', secret: true },
      ],
      run: async (v) => {
        const mismatch = same(v.pin ?? '', v.repeat ?? '')
        if (mismatch !== undefined) throw mismatch
        await api.setPin({ person: ref, pin: v.pin ?? '' })
        return { message: `${person}: PIN set` }
      },
    },
    {
      id: 'people.clear-password',
      label: 'Clear password',
      run: async () => {
        await api.clearSecret({ person: ref, kind: 'password' })
        return { message: `${person}: password cleared` }
      },
    },
    {
      id: 'people.clear-pin',
      label: 'Clear PIN',
      run: async () => {
        await api.clearSecret({ person: ref, kind: 'pin' })
        return { message: `${person}: PIN cleared` }
      },
    },
    {
      id: 'people.unlock',
      label: 'Unlock',
      hint: 'clear a lock and the failed-login counters',
      run: async () => {
        const done = await api.unlock({ person: ref })
        return { message: `${person}: ${done.wasLocked ? 'unlocked' : 'was not locked'}` }
      },
    },
    {
      id: 'people.grants',
      label: 'Show grants',
      run: async () => {
        const grants = await api.grants({ person: ref })
        return { message: `${person}: ${grants.length === 0 ? '(no grants)' : grants.join(', ')}` }
      },
    },
    {
      id: 'people.grant',
      label: 'Grant a capability',
      hint: 'on top of the role',
      fields: [{ id: 'capability', label: 'Capability', options: capabilities }],
      run: async (v) => {
        const capability = capabilities.find((c) => c === v.capability)
        if (capability === undefined) throw new Error('unknown capability')
        const grants = await api.grant({ person: ref, capability })
        return { message: `${person}: ${grants.join(', ')}` }
      },
    },
    {
      id: 'people.revoke-grant',
      label: 'Revoke a grant',
      fields: [{ id: 'capability', label: 'Capability', options: capabilities }],
      run: async (v) => {
        const capability = capabilities.find((c) => c === v.capability)
        if (capability === undefined) throw new Error('unknown capability')
        const grants = await api.revokeGrant({ person: ref, capability })
        return { message: `${person}: ${grants.length === 0 ? '(no grants)' : grants.join(', ')}` }
      },
    },
  )
  if (owner && p.role !== 'owner')
    actions.push({
      id: 'people.login',
      label: p.canLogin ? 'Turn sign-in off' : 'Turn sign-in on',
      hint: p.canLogin
        ? 'ends their sessions; no password or PIN sign-in'
        : 'they can sign in again',
      run: async () => {
        const done = await api.setLogin({ person: ref, canLogin: !p.canLogin })
        return { message: `${personLabel(done)}: sign-in ${done.canLogin ? 'on' : 'off'}` }
      },
    })
  if (kinds.transfer)
    actions.push({
      id: 'people.transfer',
      label: 'Transfer ownership',
      hint: 'you become a member',
      confirm: { text: `Make ${person} the owner? You become a member.`, type: person },
      run: async () => {
        const done = await api.transferOwner({ person: ref })
        return {
          message: `${personLabel(done.owner)} is now the owner; ${personLabel(done.previousOwner)} is a member`,
        }
      },
    })
  if (kinds.remove)
    actions.push({
      id: 'people.remove',
      label: 'Remove',
      hint: 'delete and revoke their credentials',
      confirm: { text: `Remove ${person} and revoke their credentials? The audit log stays.` },
      run: async () => {
        await api.remove({ person: ref })
        return { message: `${person}: removed` }
      },
    })
  return actions
}
