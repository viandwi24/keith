// The secrecy of a succession (docs/specs/succession.md, "What the heir gets"; P29.3.3): after the heir claims, no API or CLI
// output of the new owner carries the previous owner's password, PIN, credential or any hash. The known secrets are planted
// first, the claim runs for real (TCP, the heir's own credential and step-up), and then every response of the new owner's
// calls and the CLI's people output is searched for them.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { credentialsRepo, openDatabase, type Sqlite, successionRepo } from '@keith/db'
import { runCoreCli } from './cli/program.ts'
import { createCredential } from './modules/auth/index.ts'
import { loadConfig } from './platform/config.ts'
import { type BootedCore, bootCore, FAST_HASH } from './testing/boot-core.ts'
import { testIo } from './testing/cli-io.ts'

const DAY = 86_400_000
// planted secrets: distinctive, and never a username of the test
const OWNER_PASSWORD = 'lantern orbit 58213 quietly drifting'
const OWNER_PIN = '913287'
const HEIR_PASSWORD = 'harbor tangle 40917 mellow pages'
const HEIR_PIN = '604158'

let booted: BootedCore
let db: Sqlite
let ownerToken: string

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

describe('a succession keeps every secret of the previous owner to itself', () => {
  test('after the claim, nothing the new owner reads carries the previous owner secrets', async () => {
    const local = booted.local.rpc.admin
    // the previous owner (the owner of the install) holds a password, a PIN and a credential
    await local.people.setPassword({ person: 'owner', password: OWNER_PASSWORD })
    await local.people.setPin({ person: 'owner', pin: OWNER_PIN })
    const { token } = await createCredential(credentialsRepo(db), {
      personId: 'owner',
      kind: 'token',
      label: 'secrecy',
    })
    ownerToken = token
    // the heir: a member with a password and a PIN, named heir
    await local.people.add({ username: 'ana' })
    await local.people.setPassword({ person: 'ana', password: HEIR_PASSWORD })
    await local.people.setPin({ person: 'ana', pin: HEIR_PIN })
    await local.succession.setHeir({ person: 'ana' })
    // the grace ended with no sign: the claim is open. The owner's own admin calls above may have written signs, so the
    // claimable moment lies just ahead of them (the reconcile would otherwise read them as a return of the owner).
    const at = Date.now()
    // the settings and the run hold the person id of the heir, not the username
    const heirId = (await local.people.get({ person: 'ana' })).id
    const repo = successionRepo(db)
    repo.start(
      { runId: 'run_secrecy', heir: heirId, startedAt: at - 10 * DAY, lastSignAt: null },
      at - 10 * DAY,
    )
    repo.move('check-in', 'grace', at - 8 * DAY, { graceStartedAt: at - 8 * DAY })
    repo.move('grace', 'claimable', at + 60_000, { claimableAt: at + 60_000 })

    // the heir signs in over TCP with their own password, steps up with their PIN, and claims
    const login = await post('/auth/login', { username: 'ana', password: HEIR_PASSWORD })
    expect(login.status).toBe(200)
    const { credential } = (await login.json()) as { credential: string }
    const step = await post(
      '/auth/step-up',
      { pin: HEIR_PIN },
      { authorization: `Bearer ${credential}` },
    )
    expect(step.status).toBe(200)
    const heir = booted.tcp(credential).rpc
    const moved = await heir.admin.succession.claim({})
    expect(moved.owner).toMatchObject({ username: 'ana', role: 'owner' })
    expect(moved.previousOwner).toMatchObject({
      username: 'owner',
      role: 'member',
      status: 'suspended',
    })

    // the claim revoked the heir's session: the new owner signs in again (the password), then reads what an owner reads
    const again = await post('/auth/login', { username: 'ana', password: HEIR_PASSWORD })
    expect(again.status).toBe(200)
    const { credential: ownerCredential } = (await again.json()) as { credential: string }
    const restep = await post(
      '/auth/step-up',
      { pin: HEIR_PIN },
      { authorization: `Bearer ${ownerCredential}` },
    )
    expect(restep.status).toBe(200)
    const heirView = booted.tcp(ownerCredential).rpc
    const responses: Record<string, unknown> = {
      people: await heirView.admin.people.list(),
      previous: await heirView.admin.people.get({ person: 'owner' }),
      heirOwnView: await heirView.admin.succession.get(),
      audit: await heirView.admin.audit.list({ limit: 500 }),
      whoami: await heirView.auth.whoami(),
      export: await heirView.admin.people.export({ person: 'owner' }),
    }
    const io = testIo()
    io.end()
    const cliCode = await runCoreCli(['people', 'list'], io, {
      env: { KEITH_DATA_DIR: booted.dir, KEITH_BUILD_SHA: 'test' },
    })
    responses.cli = { code: cliCode, out: io.out(), err: io.err() }

    const serialized = JSON.stringify(responses)
    for (const secret of [OWNER_PASSWORD, OWNER_PIN, ownerToken]) {
      expect(serialized.includes(secret)).toBe(false)
    }
    // no hash of a secret either, of any person
    expect(serialized.includes('$argon2')).toBe(false)
    // the previous owner cannot sign in any more
    const retry = await post('/auth/login', { username: 'owner', password: OWNER_PASSWORD })
    expect(retry.status).not.toBe(200)
  })
})
