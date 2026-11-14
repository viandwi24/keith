// The previous owner comes back (docs/specs/succession.md, "What the heir gets"; docs/specs/people.md; P29.3.4): after a claim the
// previous owner is a suspended member. The new owner can reactivate them as a member, and their own audit view shows the
// succession rows. The new owner can hand ownership back with `transferOwner`, which needs a secret of the target and a
// step-up as it does today. No production code changes in this step: these are the tests of the existing rules.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { credentialsRepo, openDatabase, type Sqlite, successionRepo } from '@keith/db'
import { createCredential } from './modules/auth/index.ts'
import { loadConfig } from './platform/config.ts'
import { type BootedCore, bootCore, FAST_HASH } from './testing/boot-core.ts'

const DAY = 86_400_000
const OWNER_PASSWORD = 'lantern orbit 58213 quietly drifting'
const OWNER_PIN = '913287'
const HEIR_PASSWORD = 'harbor tangle 40917 mellow pages'
const HEIR_PIN = '604158'

let booted: BootedCore
let db: Sqlite

beforeAll(async () => {
  booted = await bootCore({}, { hasher: FAST_HASH })
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: booted.dir, KEITH_BUILD_SHA: 'test' }).dbFile)
})
afterAll(async () => {
  db.close()
  await booted.stop()
})

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${booted.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

/** Signs in with a password and steps up with the PIN; returns the credential (a TCP bearer). */
async function signIn(username: string, password: string, pin: string): Promise<string> {
  const login = await post('/auth/login', { username, password })
  expect(login.status).toBe(200)
  const { credential } = (await login.json()) as { credential: string }
  const step = await post('/auth/step-up', { pin }, { authorization: `Bearer ${credential}` })
  expect(step.status).toBe(200)
  return credential
}

describe('the previous owner after a succession', () => {
  // one story in order: the claim, the return, the hand-back
  test('claim, the previous owner is suspended; reactivated; sees the succession in audit.mine; hand-back needs a step-up', async () => {
    const local = booted.local.rpc.admin
    await local.people.setPassword({ person: 'owner', password: OWNER_PASSWORD })
    await local.people.setPin({ person: 'owner', pin: OWNER_PIN })
    await createCredential(credentialsRepo(db), {
      personId: 'owner',
      kind: 'token',
      label: 'return',
    })
    await local.people.add({ username: 'ana' })
    await local.people.setPassword({ person: 'ana', password: HEIR_PASSWORD })
    await local.people.setPin({ person: 'ana', pin: HEIR_PIN })
    await local.succession.setHeir({ person: 'ana' })
    const heirId = (await local.people.get({ person: 'ana' })).id
    const at = Date.now()
    const repo = successionRepo(db)
    repo.start(
      { runId: 'run_return', heir: heirId, startedAt: at - 10 * DAY, lastSignAt: null },
      at - 10 * DAY,
    )
    repo.move('check-in', 'grace', at - 8 * DAY, { graceStartedAt: at - 8 * DAY })
    repo.move('grace', 'claimable', at + 60_000, { claimableAt: at + 60_000 })

    const heirCredential = await signIn('ana', HEIR_PASSWORD, HEIR_PIN)
    const moved = await booted.tcp(heirCredential).rpc.admin.succession.claim({})
    expect(moved.previousOwner).toMatchObject({
      username: 'owner',
      role: 'member',
      status: 'suspended',
    })

    // the suspended previous owner cannot sign in
    const refusedLogin = await post('/auth/login', { username: 'owner', password: OWNER_PASSWORD })
    expect(refusedLogin.status).not.toBe(200)

    // the new owner reactivates them as a member (the claim revoked the new owner's session too: sign in again)
    const newOwner = await signIn('ana', HEIR_PASSWORD, HEIR_PIN)
    const reactivated = await booted.tcp(newOwner).rpc.admin.people.reactivate({ person: 'owner' })
    expect(reactivated).toMatchObject({ username: 'owner', role: 'member', status: 'active' })

    // the previous owner signs in again as a member and reads their own audit lines
    const back = await signIn('owner', OWNER_PASSWORD, OWNER_PIN)
    const mine = await booted.tcp(back).rpc.admin.audit.mine({})
    const succession = mine.filter((line) => line.kind === 'owner.succession')
    expect(succession).toHaveLength(1)
    expect(succession[0]?.summary).toBe(
      'your heir claimed ownership of this Keith, and your sign-in is suspended',
    )
    expect(mine.some((line) => line.kind === 'person.status')).toBe(true)

    // the heir's own view of the same claim names their claim
    const heirLines = await booted.tcp(newOwner).rpc.admin.audit.mine({})
    expect(heirLines.some((line) => line.summary === 'you claimed ownership of this Keith')).toBe(
      true,
    )

    // a hand-back is a transferOwner: a fresh credential without a step-up is refused, with the step-up it works
    const unstepped = await post('/auth/login', { username: 'ana', password: HEIR_PASSWORD })
    const { credential: noStep } = (await unstepped.json()) as { credential: string }
    await expect(
      booted.tcp(noStep).rpc.admin.people.transferOwner({ person: 'owner' }),
    ).rejects.toMatchObject({ code: 'KEITH_STEP_UP_REQUIRED' })
    const stepped = await signIn('ana', HEIR_PASSWORD, HEIR_PIN)
    const handed = await booted.tcp(stepped).rpc.admin.people.transferOwner({ person: 'owner' })
    expect(handed.owner).toMatchObject({ username: 'owner', role: 'owner' })
    expect(handed.previousOwner).toMatchObject({ username: 'ana', role: 'member' })
    const after = await booted.local.rpc.admin.people.get({ person: 'ana' })
    expect(after.role).toBe('member')
  })
})
