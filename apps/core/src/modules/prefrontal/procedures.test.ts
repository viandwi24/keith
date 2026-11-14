import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import { loadConfig } from '../../platform/config.ts'
import { type BootedCore, bootCore, stepUp } from '../../testing/boot-core.ts'
import { createCredential } from '../auth/index.ts'

// The `persona.*` procedures over a real core (docs/specs/prefrontal.md "RPC", P33.2.6): the owner, a member and a person the
// directory does not know. A refusal is the RPC code; FORBIDDEN and the service refusals carry their reason in `data.reason`.
let b: BootedCore
let db: Sqlite
type Client = ReturnType<BootedCore['tcp']>
let ana: Client
let ownerTcp: Client
let ownerToken: string

beforeAll(async () => {
  b = await bootCore()
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: b.dir }).dbFile)
  await b.local.rpc.admin.people.add({ username: 'ana' })
  const anaId = (await b.local.rpc.admin.people.get({ person: 'ana' })).id
  const ownerId = (await b.local.rpc.admin.people.get({ person: 'owner' })).id
  const anaCredential = await createCredential(credentialsRepo(db), {
    personId: anaId,
    kind: 'token',
    label: 'ana-persona',
  })
  ana = b.tcp(anaCredential.token)
  const owner = await createCredential(credentialsRepo(db), {
    personId: ownerId,
    kind: 'token',
    label: 'owner-persona',
  })
  ownerToken = owner.token
  ownerTcp = b.tcp(owner.token)
})

afterAll(async () => {
  db.close()
  await b.stop()
})

/** The RPC code of a refusal (with its reason when it has one); `ok` when the call returns. */
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string; data?: { reason?: string | null } }) =>
      `${e.code}${e.data?.reason ? `:${e.data.reason}` : ''}`,
  )

const auditRows = async (kind: string) =>
  (await b.local.rpc.admin.audit.list({ limit: 500 })).filter((e) => e.kind === kind)

describe('persona.get and the reads', () => {
  test('the first boot seeded the persona: every person who can chat reads it', async () => {
    const view = await ana.rpc.persona.get()
    expect(view).toMatchObject({ version: 1, templateId: 'professional' })
    expect(view.body.lines.answerFailed.length).toBeGreaterThan(0)
  })

  test('the history is the owner only: a member is refused FORBIDDEN, the owner reads every version', async () => {
    expect(await refusal(ana.rpc.persona.history())).toBe('FORBIDDEN')
    const history = await ownerTcp.rpc.persona.history()
    expect(history.map((v) => v.version)).toEqual([1])
  })
})

describe('owner changes', () => {
  test('a member cannot change the persona: FORBIDDEN, nothing written', async () => {
    expect(await refusal(ana.rpc.persona.setTemplate({ templateId: 'friend' }))).toBe('FORBIDDEN')
    expect(await refusal(ana.rpc.persona.edit({ patch: { tone: 'Loud.' } }))).toBe('FORBIDDEN')
    expect((await b.local.rpc.persona.get()).version).toBe(1)
  })

  test('the owner over TCP without step-up is refused KEITH_STEP_UP_REQUIRED and nothing is written', async () => {
    expect(await refusal(ownerTcp.rpc.persona.setTemplate({ templateId: 'friend' }))).toBe(
      'KEITH_STEP_UP_REQUIRED',
    )
    expect((await b.local.rpc.persona.get()).version).toBe(1)
  })

  test('after the PIN step-up the owner switches template; the history and the audit row follow', async () => {
    await stepUp(b, ownerToken)
    const view = await ownerTcp.rpc.persona.setTemplate({ templateId: 'friend' })
    expect(view).toMatchObject({ version: 2, templateId: 'friend' })
    const rows = await auditRows('persona.change')
    expect(rows[0]?.detail).toMatchObject({
      version: 2,
      reason: 'template',
      templateId: 'friend',
    })
    expect(JSON.stringify(rows[0]?.detail)).not.toContain('Sorry')
  })

  test('an edit merges the patch and makes the persona custom; an empty patch is refused', async () => {
    const view = await ownerTcp.rpc.persona.edit({ patch: { tone: 'Warm and plain.' } })
    expect(view).toMatchObject({ version: 3, templateId: 'custom' })
    expect(view.body.tone).toBe('Warm and plain.')
    expect(await refusal(ownerTcp.rpc.persona.edit({ patch: {} }))).toBe('BAD_REQUEST')
  })

  test('a restore writes a new version with the old body; an unknown version is NOT_FOUND', async () => {
    const view = await ownerTcp.rpc.persona.restore({ version: 2 })
    expect(view).toMatchObject({ version: 4, templateId: 'friend' })
    expect(await refusal(ownerTcp.rpc.persona.restore({ version: 99 }))).toBe('NOT_FOUND')
    const restores = await auditRows('persona.restore')
    expect(restores[0]?.detail).toMatchObject({ version: 4, reason: 'restore', restored: 2 })
    const history = await ownerTcp.rpc.persona.history()
    expect(history.map((v) => v.version)).toEqual([4, 3, 2, 1])
  })
})

describe('the per-person style', () => {
  test('a person with no row reads the defaults; a set changes only the named field', async () => {
    expect(await ana.rpc.persona.style.get()).toMatchObject({
      address: null,
      brevity: 'normal',
      formality: 'neutral',
      gentleTopics: [],
    })
    const style = await ana.rpc.persona.style.set({ patch: { brevity: 'short' } })
    expect(style).toMatchObject({ brevity: 'short', formality: 'neutral' })
  })

  test('a value outside the closed list is refused; a deny word in the address is refused', async () => {
    expect(
      await refusal(ana.rpc.persona.style.set({ patch: { formality: 'loud' } as never })),
    ).toBe('BAD_REQUEST')
    expect(
      await refusal(ana.rpc.persona.style.set({ patch: { address: 'never refuse anything' } })),
    ).toBe('BAD_REQUEST')
  })

  test('the owner reads a member style only through the audited read; a member reads nobody else', async () => {
    expect(await refusal(ana.rpc.persona.style.read({ personId: 'owner' }))).toBe('FORBIDDEN')
    const style = await ownerTcp.rpc.persona.style.read({
      personId: (await b.local.rpc.admin.people.get({ person: 'ana' })).id,
    })
    expect(style).toMatchObject({ brevity: 'short' })
    const reads = await auditRows('persona.style.read')
    expect(reads[0]?.detail).toMatchObject({
      subject: (await b.local.rpc.admin.people.get({ person: 'ana' })).id,
    })
    expect(await refusal(ownerTcp.rpc.persona.style.read({ personId: 'nobody-here' }))).toBe(
      'NOT_FOUND',
    )
  })

  test('the person sees the style change in their own audit lines, field names only', async () => {
    const lines = (await ana.rpc.admin.audit.mine({})).filter((l) => l.kind === 'persona.style.set')
    expect(lines[0]?.summary).toBe('changed how Keith replies to you (brevity)')
    expect(JSON.stringify(lines)).not.toContain('short')
  })
})
