import { describe, expect, test } from 'bun:test'
import { AuthPolicySchema } from '@keith/contracts'
import { migrateDatabase, openDatabase, settingsRepo } from '@keith/db'
import { allows, DEFAULT_POLICY } from './policy.ts'
import { createPolicyStore, POLICY_SETTING, policyProblem } from './policy-store.ts'

const store = (warn: (m: string) => void = () => {}) => {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const settings = settingsRepo(sqlite)
  return { sqlite, settings, policies: createPolicyStore(settings, warn) }
}

describe('policy store', () => {
  test('nothing stored is the default; set and reset round-trip', () => {
    const { sqlite, policies } = store()
    expect(policies.isDefault()).toBe(true)
    expect(policies.get()).toBe(DEFAULT_POLICY)
    const mine = AuthPolicySchema.parse({
      rules: [{ method: 'password', zones: ['loopback', 'lan'], idleMs: 1000 }],
      lanCidrs: ['10.1.0.0/16'],
    })
    policies.set(mine)
    expect(policies.isDefault()).toBe(false)
    expect(policies.get()).toEqual(mine)
    expect(allows(policies.get(), 'password', { zone: 'lan' })).toBe(true)
    policies.reset()
    expect(policies.get()).toBe(DEFAULT_POLICY)
    sqlite.close()
  })

  test('a stored value that does not parse falls back to the default and warns once', () => {
    const warnings: string[] = []
    const { sqlite, settings, policies } = store((m) => warnings.push(m))
    settings.set(POLICY_SETTING, { rules: 'nonsense' })
    expect(policies.get()).toBe(DEFAULT_POLICY)
    expect(policies.get()).toBe(DEFAULT_POLICY)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('auth policy reset')
    sqlite.close()
  })

  test('an old row with the removed fields loads without them and re-saves clean', () => {
    const { sqlite, settings, policies } = store()
    settings.set(POLICY_SETTING, {
      rules: [
        {
          method: 'password',
          zones: ['loopback'],
          rateLimit: { free: 4, capSeconds: 300 },
          requireAssurance: 1,
        },
      ],
    })
    const loaded = policies.get()
    expect(loaded.rules[0]).toEqual({
      method: 'password',
      zones: ['loopback'],
      cidrs: [],
      idleMs: 0,
      absoluteMs: 0,
    })
    policies.set(loaded)
    const raw = JSON.stringify(settings.get(POLICY_SETTING))
    expect(raw).not.toContain('rateLimit')
    expect(raw).not.toContain('requireAssurance')
    sqlite.close()
  })

  test('a corrupt row never throws', () => {
    const { sqlite, policies } = store()
    sqlite
      .query("INSERT INTO settings (key, value, updated_at) VALUES ('auth.policy', '{oops', 0)")
      .run()
    expect(policies.get()).toBe(DEFAULT_POLICY)
    sqlite.close()
  })
})

describe('the lockout guard', () => {
  const policy = (rules: unknown[], lanCidrs: string[] = []) =>
    AuthPolicySchema.parse({ rules, lanCidrs })

  test('the default policy passes', () => {
    expect(policyProblem(DEFAULT_POLICY, ['loopback'])).toBeUndefined()
    expect(policyProblem(DEFAULT_POLICY, ['loopback', 'tailscale'])).toBeUndefined()
  })

  test('refuses a policy with no password or PIN from loopback', () => {
    const problem = policyProblem(
      policy([
        { method: 'token', zones: ['loopback'] },
        { method: 'device', zones: ['loopback'] },
      ]),
      ['loopback'],
    )
    expect(problem).toContain('no password or PIN sign-in from loopback')
    expect(policyProblem(policy([]), ['loopback'])).toBeDefined()
  })

  test('a PIN alone keeps the owner in; so does a rule restricted to the owner role', () => {
    expect(
      policyProblem(policy([{ method: 'pin', zones: ['loopback'] }]), ['loopback']),
    ).toBeUndefined()
    expect(
      policyProblem(policy([{ method: 'password', zones: ['loopback'], roles: ['owner'] }]), [
        'loopback',
      ]),
    ).toBeUndefined()
  })

  test('a rule for members only, or for the email kind only, does not keep the owner in', () => {
    expect(
      policyProblem(policy([{ method: 'password', zones: ['loopback'], roles: ['member'] }]), [
        'loopback',
      ]),
    ).toBeDefined()
    expect(
      policyProblem(
        policy([{ method: 'password', zones: ['loopback'], identifierKinds: ['email'] }]),
        ['loopback'],
      ),
    ).toBeDefined()
  })

  test('the zone of a remote caller must keep a way in too', () => {
    const loopbackOnly = policy([{ method: 'password', zones: ['loopback'] }])
    expect(policyProblem(loopbackOnly, ['loopback'])).toBeUndefined()
    expect(policyProblem(loopbackOnly, ['loopback', 'tailscale'])).toContain('tailscale')
  })

  test('refuses a CIDR that does not parse, in a rule or in lanCidrs', () => {
    expect(
      policyProblem(policy([{ method: 'password', zones: ['loopback'] }], ['10.0.0.0/99']), [
        'loopback',
      ]),
    ).toContain('not a valid CIDR')
    expect(
      policyProblem(policy([{ method: 'password', zones: ['loopback'], cidrs: ['nope'] }]), [
        'loopback',
      ]),
    ).toContain('not a valid CIDR')
    expect(
      policyProblem(
        policy([{ method: 'password', zones: ['loopback'] }], ['192.168.1.0/24', 'fd00::/8']),
        ['loopback'],
      ),
    ).toBeUndefined()
  })
})
