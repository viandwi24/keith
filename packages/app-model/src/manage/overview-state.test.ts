import { describe, expect, test } from 'bun:test'
import { overviewLines } from './overview-state.ts'

const me = {
  personId: 'p',
  name: 'Ana',
  username: 'ana',
  role: 'member' as const,
  via: 'tcp' as const,
  credentialKind: 'device' as const,
  elevated: false,
  capabilities: [],
}

describe('overviewLines', () => {
  test('only what was loaded is shown', () => {
    const lines = overviewLines({
      me,
      health: undefined,
      roles: undefined,
      budget: undefined,
      nodes: undefined,
      people: undefined,
      pendingDevices: undefined,
    })
    expect(lines).toEqual(['you       Ana (member) via a remote login'])
  })

  test('the owner overview counts people, nodes and logins that wait', () => {
    const lines = overviewLines({
      me: { ...me, role: 'owner', via: 'local' },
      health: { status: 'ok', version: '1.0.0', sha: 'abc', boot: 'b' },
      roles: { front: 'openrouter:x', cortex: null },
      budget: undefined,
      nodes: [],
      people: 3,
      pendingDevices: 0,
    })
    expect(lines).toContain('core      1.0.0 (abc)')
    expect(lines).toContain('models    front openrouter:x · cortex (not set)')
    expect(lines).toContain('nodes     0 online of 0')
    expect(lines).toContain('people    3')
    expect(lines).toContain('devices   no login waits for approval')
  })
})
