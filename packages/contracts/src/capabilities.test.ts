import { describe, expect, test } from 'bun:test'
import {
  CAPABILITY_IDS,
  capabilitiesOf,
  createCapabilityRegistry,
  keithContract,
  OWNER_ONLY_CAPABILITIES,
  ROLE_CAPABILITIES,
} from './index.ts'

/** Every leaf of the contract router: [path, procedure]. */
function procedures(node: unknown, path: string[] = []): Array<[string, Record<string, unknown>]> {
  const orpc = (node as { '~orpc'?: Record<string, unknown> })['~orpc']
  if (orpc !== undefined) return [[path.join('.'), orpc]]
  return Object.entries(node as object).flatMap(([key, child]) => procedures(child, [...path, key]))
}

describe('capability metadata', () => {
  const all = procedures(keithContract)

  test('the walk finds the procedures', () => {
    expect(all.length).toBeGreaterThan(30)
  })

  test('every procedure declares a known capability', () => {
    // the closed set at runtime: core ids plus whatever plugin manifests registered. No plugin registers here (these
    // procedures are core's), so a plugin id in a procedure's metadata is unknown; plugin operations are checked in
    // `packages/host/src/capabilities.test.ts` and `apps/core/src/plugins.e2e.test.ts` against the manifests' ids.
    const registry = createCapabilityRegistry()
    const known = (capability: string | undefined): boolean =>
      capability === 'authenticated' || (capability !== undefined && registry.has(capability))
    const missing = all
      .filter(([, p]) => !known((p.meta as { capability?: string } | undefined)?.capability))
      .map(([path]) => path)
    expect(missing).toEqual([])
  })

  test('a sensitive capability is never reachable without a step-up for a change', () => {
    const manage = all.filter(([, p]) =>
      String((p.meta as { capability?: string }).capability).endsWith('.manage'),
    )
    // reads (list/get/describe/test) may skip the step-up; every other manage call needs it
    const reads = /\.(list|get|show|grants|test)$/
    const unsealed = manage
      .filter(([path, p]) => !reads.test(path) && (p.meta as { stepUp?: boolean }).stepUp !== true)
      .map(([path]) => path)
    expect(unsealed).toEqual([])
  })
})

describe('protocol answers (docs/specs/hypothalamus.md, "RPC")', () => {
  const all = procedures(keithContract)
  const capabilityOf = (path: string) =>
    all.find(([p]) => p === path)?.[1]?.meta as
      | { capability?: string; stepUp?: boolean }
      | undefined

  test('protocols.answer is a chat call with no step-up; the run person check is in the handler', () => {
    expect(capabilityOf('protocols.answer')).toBeDefined()
    expect(capabilityOf('protocols.answer')?.capability).toBe('chat')
    expect(capabilityOf('protocols.answer')?.stepUp).toBeUndefined()
  })
})

describe('settings writes', () => {
  const all = procedures(keithContract)

  test('provider, model, access, budget, node and device writes need a step-up', () => {
    const sealed = [
      'providers.put',
      'providers.remove',
      'models.roles.set',
      'admin.access.set',
      'budget.set',
      'budget.setPersonCap',
      'nodes.pair',
      'nodes.revoke',
      'admin.devices.approve',
      'admin.tokens.create',
    ]
    for (const name of sealed) {
      const found = all.find(([path]) => path === name)
      expect(found, name).toBeDefined()
      const meta = (found?.[1]?.meta ?? {}) as { stepUp?: boolean }
      expect(meta.stepUp, name).toBe(true)
    }
  })
})

describe('roles', () => {
  const all = procedures(keithContract)

  test('the owner has every capability; a member only the safe ones', () => {
    expect([...capabilitiesOf('owner')].sort()).toEqual([...CAPABILITY_IDS].sort())
    const member = capabilitiesOf('member')
    expect([...member].sort()).toEqual([...ROLE_CAPABILITIES.member].sort())
    for (const manage of CAPABILITY_IDS.filter((c) => c.endsWith('.manage')))
      expect(member.has(manage)).toBe(false)
    expect(member.has('audit.read')).toBe(false)
  })

  test('groups.manage is the owner role only: a grant to a member is ignored', () => {
    expect(OWNER_ONLY_CAPABILITIES).toContain('groups.manage')
    expect(capabilitiesOf('owner').has('groups.manage')).toBe(true)
    expect(ROLE_CAPABILITIES.member).not.toContain('groups.manage')
    expect(capabilitiesOf('member', ['groups.manage']).has('groups.manage')).toBe(false)
  })

  test('every admin.groups procedure needs groups.manage, and every change a step-up', () => {
    const groups = all.filter(([path]) => path.startsWith('admin.groups.'))
    expect(groups.map(([path]) => path).sort()).toEqual(
      ['add', 'create', 'delete', 'get', 'list', 'remove'].map((n) => `admin.groups.${n}`),
    )
    for (const [path, p] of groups) {
      const meta = p.meta as { capability: string; stepUp?: boolean }
      expect(meta.capability, path).toBe('groups.manage')
      if (!/\.(list|get)$/.test(path)) expect(meta.stepUp, path).toBe(true)
    }
  })

  test('a grant adds a capability; an unknown id is dropped', () => {
    const set = capabilitiesOf('member', ['tokens.manage', 'nope'])
    expect(set.has('tokens.manage')).toBe(true)
    expect(set.size).toBe(ROLE_CAPABILITIES.member.length + 1)
  })

  test('audit.read is the owner role only: an old stored grant is ignored, every member has audit.mine', () => {
    expect(OWNER_ONLY_CAPABILITIES).toContain('audit.read')
    expect(capabilitiesOf('owner').has('audit.read')).toBe(true)
    expect(capabilitiesOf('member', ['audit.read']).has('audit.read')).toBe(false)
    expect(capabilitiesOf('member').has('audit.mine')).toBe(true)
  })
})

describe('presence procedures (docs/specs/parietal.md)', () => {
  const all = procedures(keithContract)
  const capabilityOf = (path: string) =>
    all.find(([p]) => p === path)?.[1]?.meta as
      | { capability?: string; stepUp?: boolean }
      | undefined

  test('every client, status and disclosure call is a chat call, none needs a step-up', () => {
    const own = [
      'presence.clients.register',
      'presence.clients.heartbeat',
      'presence.clients.goodbye',
      'presence.clients.ack',
      'presence.clients.list',
      'presence.clients.remove',
      'presence.mine',
      'presence.setStatus',
      'presence.disclosure.set',
    ]
    for (const path of own) {
      expect(capabilityOf(path), path).toBeDefined()
      expect(capabilityOf(path)?.capability, path).toBe('chat')
      expect(capabilityOf(path)?.stepUp, path).toBeUndefined()
    }
  })

  test('the owner raw read needs audit.read, which only the owner role holds', () => {
    expect(capabilityOf('admin.presence.read')?.capability).toBe('audit.read')
    expect(OWNER_ONLY_CAPABILITIES).toContain('audit.read')
    expect(capabilitiesOf('member', ['audit.read']).has('audit.read')).toBe(false)
  })
})

describe('succession capability (docs/specs/succession.md)', () => {
  test('succession.manage is owner only: the owner holds it, a member grant is refused and ignored', () => {
    expect(CAPABILITY_IDS).toContain('succession.manage')
    expect(OWNER_ONLY_CAPABILITIES).toContain('succession.manage')
    expect(ROLE_CAPABILITIES.member).not.toContain('succession.manage')
    expect(capabilitiesOf('owner').has('succession.manage')).toBe(true)
    expect(capabilitiesOf('member', ['succession.manage']).has('succession.manage')).toBe(false)
  })

  test('a people.manage delegate cannot name an heir: the grant of the succession capability is ignored', () => {
    expect(
      capabilitiesOf('member', ['people.manage', 'succession.manage']).has('succession.manage'),
    ).toBe(false)
  })
})

describe('rooms capability (docs/specs/corpus-callosum.md, ADR-0026 §1)', () => {
  test('rooms.start is a known capability: the owner holds it, a member does not by role', () => {
    expect(CAPABILITY_IDS).toContain('rooms.start')
    expect(capabilitiesOf('owner').has('rooms.start')).toBe(true)
    expect(ROLE_CAPABILITIES.member).not.toContain('rooms.start')
    expect(capabilitiesOf('member').has('rooms.start')).toBe(false)
  })

  test('rooms.start is not owner-only: a member holds it by a grant', () => {
    expect(OWNER_ONLY_CAPABILITIES).not.toContain('rooms.start')
    expect(capabilitiesOf('member', ['rooms.start']).has('rooms.start')).toBe(true)
  })
})

describe('activity logs capabilities (docs/specs/activity-logs.md, ADR-0032 §8)', () => {
  test('logs.mine and logs.read are known capabilities; the owner holds both', () => {
    expect(CAPABILITY_IDS).toContain('logs.mine')
    expect(CAPABILITY_IDS).toContain('logs.read')
    expect(capabilitiesOf('owner').has('logs.mine')).toBe(true)
    expect(capabilitiesOf('owner').has('logs.read')).toBe(true)
  })

  test('logs.mine is held by every role; a member reads only their own logs', () => {
    expect(ROLE_CAPABILITIES.member).toContain('logs.mine')
    expect(capabilitiesOf('member').has('logs.mine')).toBe(true)
  })

  test('logs.read is owner only: a member grant is refused and ignored, the owner role holds it', () => {
    expect(OWNER_ONLY_CAPABILITIES).toContain('logs.read')
    expect(ROLE_CAPABILITIES.member).not.toContain('logs.read')
    expect(capabilitiesOf('member', ['logs.read']).has('logs.read')).toBe(false)
  })

  test('the logs procedures name their capability: mine for the caller, read for the owner settings', () => {
    const all = procedures(keithContract)
    const capabilityOf = (path: string) =>
      (all.find(([p]) => p === path)?.[1]?.meta as { capability?: string } | undefined)?.capability
    for (const path of [
      'logs.status',
      'logs.sessions',
      'logs.session',
      'logs.call',
      'logs.raw',
      'logs.purge',
    ]) {
      expect(capabilityOf(path), path).toBe('logs.mine')
    }
    expect(capabilityOf('logs.settings.get')).toBe('logs.read')
    expect(capabilityOf('logs.settings.set')).toBe('logs.read')
  })
})
