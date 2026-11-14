import { describe, expect, test } from 'bun:test'
import { GuardError, OperationError } from '@keith/host'
import type { AccessService } from '../acl/index.ts'
import { AclAdminError } from '../acl/index.ts'
import { createAccessPort, createPluginAclAudit } from './access-port.ts'

type Denied = { caller: unknown; kind: string }

/** An access service whose every call fails with the given refusal (or succeeds when none). */
function accessFailing(error: AclAdminError | undefined): AccessService {
  const fail = async () => {
    if (error !== undefined) throw error
    return { kind: 'note' }
  }
  return { show: fail, share: fail, unshare: fail } as unknown as AccessService
}

function portWith(error: AclAdminError | undefined) {
  const denied: Denied[] = []
  const port = createAccessPort(accessFailing(error), {
    denied: (caller: unknown, kind: string) => denied.push({ caller, kind }),
  })
  return { port, denied }
}

const member = { by: 'duta', via: 'tcp' as const, confirmed: false, session: 'sess-9' }

describe('the plugin access port counts resource-level refusals as acl.deny', () => {
  test('a missing or invisible resource is refused as NOT_FOUND and counted for the session', async () => {
    const { port, denied } = portWith(new AclAdminError('NOT_FOUND', 'not found'))
    await expect(port.show(member, { kind: 'note', id: 'probe' })).rejects.toBeInstanceOf(
      GuardError,
    )
    await expect(
      port.share(member, { kind: 'note', id: 'probe', target: 'user:x', bits: 4 }),
    ).rejects.toBeInstanceOf(GuardError)
    expect(denied).toEqual([
      { caller: member, kind: 'note' },
      { caller: member, kind: 'note' },
    ])
  })

  test('a resource that is visible but not yours to change is counted too', async () => {
    const { port, denied } = portWith(new AclAdminError('FORBIDDEN', 'only the owner'))
    await expect(
      port.unshare(member, { kind: 'note', id: 'n1', target: 'user:x' }),
    ).rejects.toBeInstanceOf(OperationError)
    expect(denied).toEqual([{ caller: member, kind: 'note' }])
  })

  test('a function-level refusal (a step-up, a bad target) is not an acl.deny', async () => {
    const step = portWith(new AclAdminError('STEP_UP', 'needs a confirmation'))
    await expect(
      step.port.share(member, { kind: 'note', id: 'n1', target: '@public', bits: 4 }),
    ).rejects.toBeInstanceOf(OperationError)
    const bad = portWith(new AclAdminError('BAD_REQUEST', 'unknown or inactive user'))
    await expect(bad.port.show(member, { kind: 'note', id: 'n1' })).rejects.toBeInstanceOf(
      OperationError,
    )
    expect(step.denied).toHaveLength(0)
    expect(bad.denied).toHaveLength(0)
  })

  test('a success is not counted', async () => {
    const { port, denied } = portWith(undefined)
    await port.show(member, { kind: 'note', id: 'n1' })
    expect(denied).toHaveLength(0)
  })
})

describe('the plugins own resource writes', () => {
  test('acl.create and acl.remove rows carry the resource and the resource owner', () => {
    const rows: Array<{ kind: string; detail: unknown }> = []
    const audit = createPluginAclAudit({
      record: (kind: string, _caller: unknown, detail: unknown) => rows.push({ kind, detail }),
    })
    audit.created(member, { kind: 'note', id: 'n1', owner: 'duta', mode: 0o600 })
    audit.removed(member, { kind: 'note', id: 'n1', owner: 'duta' })
    expect(rows).toEqual([
      {
        kind: 'acl.create',
        detail: { kind: 'note', id: 'n1', owner: 'duta', mode: 0o600, resourceOwner: 'duta' },
      },
      { kind: 'acl.remove', detail: { kind: 'note', id: 'n1', resourceOwner: 'duta' } },
    ])
  })
})
