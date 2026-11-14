import { describe, expect, test } from 'bun:test'
import type { Whoami } from '@keith/contracts'
import { whoamiRows } from './whoami-rows.ts'

const me: Whoami = {
  personId: 'owner',
  name: 'Vian',
  username: 'vian',
  role: 'owner',
  via: 'tcp',
  credentialKind: 'device',
  elevated: false,
  capabilities: [],
}
const rows = (over: Partial<Whoami>) =>
  whoamiRows({
    me: { ...me, ...over },
    core: 'http://127.0.0.1:7420',
    health: undefined,
    roles: undefined,
  })

describe('/whoami rows', () => {
  test('a PIN session says so, and is not stepped up', () => {
    const r = rows({ methods: ['pin'], assurance: 1 })
    expect(r[1]).toBe('via   device credential (pin session)  http://127.0.0.1:7420')
    expect(r[2]).toContain('no (needed')
  })

  test('the implicit owner of the socket, and a session on the socket', () => {
    expect(rows({ via: 'local', credentialKind: null })[1]).toContain('local socket')
    expect(rows({ via: 'local', credentialKind: null })[2]).toContain('yes (local socket)')
    const session = rows({ via: 'local', methods: ['pin', 'local-admin'], elevated: true })
    expect(session[1]).toContain('device credential (pin session)')
    expect(session[2]).toBe('elevated  yes')
  })
})
