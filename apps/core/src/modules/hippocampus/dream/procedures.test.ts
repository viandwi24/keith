// The dreaming RPC area over a real core (P35.6.1): the caller is the principal, a member changes only their own mode, the owner
// reads a member's diary through the audited path only, and the member default is the owner's setting with a step-up. The
// diary is written by the diary module, so the procedures read the same files a run writes.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { credentialsRepo, dreamingRepo, openDatabase, type Sqlite } from '@keith/db'
import { loadConfig } from '../../../platform/config.ts'
import { type BootedCore, bootCore, stepUp } from '../../../testing/boot-core.ts'
import { createCredential } from '../../auth/index.ts'
import { appendDiary } from './diary.ts'
import { ARCHIVE_TIER, PROFILE_TIER, RECENT_TIER, writeMemoryFile } from './files.ts'
import { memoryBaseOf, writeStagedPlan } from './staged.ts'

const DAY = '2026-11-10'
const OWNER_TEXT = 'OWNER-PLANTED-LINE'
const MEMBER_TEXT = 'MEMBER-PLANTED-LINE'

let b: BootedCore
let db: Sqlite
let memberId: string
let memberToken: string

beforeAll(async () => {
  b = await bootCore()
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: b.dir }).dbFile)
  await b.local.rpc.admin.people.add({ username: 'ana' })
  memberId = (await b.local.rpc.admin.people.get({ person: 'ana' })).id
  memberToken = (
    await createCredential(credentialsRepo(db), {
      personId: memberId,
      kind: 'token',
      label: 'member',
    })
  ).token
  appendDiary(b.dir, 'owner', DAY, 'run-owner', [
    { action: 'kept', text: OWNER_TEXT, reason: 'planted' },
  ])
  appendDiary(b.dir, memberId, DAY, 'run-member', [
    { action: 'kept', text: MEMBER_TEXT, reason: 'planted' },
  ])
})

afterAll(async () => {
  db.close()
  await b.stop()
})

/** The refusal of a call as its RPC code and the machine reason (`data.reason`) it carries. */
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string; data?: { reason?: string | null } }) =>
      `${e.code}${e.data?.reason ? `:${e.data.reason}` : ''}`,
  )

const ownerAccessRows = async () =>
  (await b.local.rpc.admin.audit.list({ limit: 500 })).filter((e) => e.kind === 'acl.owner-access')

describe('dream.diary', () => {
  test('a member cannot read the owner’s diary: the same answer as a missing diary', async () => {
    const member = b.tcp(memberToken)
    expect(await refusal(member.rpc.dream.diary({ personId: 'owner' }))).toBe('NOT_FOUND')
    expect(await refusal(member.rpc.dream.diary({ personId: 'nobody-here' }))).toBe('NOT_FOUND')
  })

  test('the owner reading a member’s diary gets the text and writes one acl.owner-access row', async () => {
    const before = (await ownerAccessRows()).length
    const diary = await b.local.rpc.dream.diary({ personId: memberId, date: DAY })
    expect(diary.text).toContain(MEMBER_TEXT)
    const rows = await ownerAccessRows()
    expect(rows.length).toBe(before + 1)
    expect(rows.at(-1)?.detail).toMatchObject({
      kind: 'dream-diary',
      id: memberId,
      owner: memberId,
    })
  })

  test('a person reads their own diary without a personId and writes no owner-access row', async () => {
    const before = (await ownerAccessRows()).length
    const mine = await b.tcp(memberToken).rpc.dream.diary({ date: DAY })
    expect(mine.text).toContain(MEMBER_TEXT)
    expect(mine.text).not.toContain(OWNER_TEXT)
    const own = await b.local.rpc.dream.diary({ date: DAY })
    expect(own.text).toContain(OWNER_TEXT)
    expect((await ownerAccessRows()).length).toBe(before)
  })

  test('a missing diary is NOT_FOUND for the caller', async () => {
    expect(await refusal(b.tcp(memberToken).rpc.dream.diary({ date: '2001-01-01' }))).toBe(
      'NOT_FOUND',
    )
  })
})

describe('dream.mode and dream.status', () => {
  test('a member sets only their own mode; the owner row does not move', async () => {
    await b.local.rpc.dream.mode({ mode: 'off' })
    const after = await b.tcp(memberToken).rpc.dream.mode({ mode: 'propose' })
    expect(after.mode).toBe('propose')
    expect((await b.tcp(memberToken).rpc.dream.status()).mode).toBe('propose')
    expect((await b.local.rpc.dream.status()).mode).toBe('off')
  })

  test('a mode change re-syncs the person’s dream built-in: enabled for propose, disabled for off', async () => {
    const dream = async () =>
      (await b.local.rpc.protocols.list()).protocols.find(
        (p) => p.builtIn === 'dream' && p.owner === 'owner',
      )
    await b.local.rpc.dream.mode({ mode: 'propose' })
    expect((await dream())?.enabled).toBe(true)
    await b.local.rpc.dream.mode({ mode: 'off' })
    expect((await dream())?.enabled).toBe(false)
  })

  test('a member with no stored mode starts with the member default (off)', async () => {
    const other = await b.local.rpc.admin.people.add({ username: 'ben' })
    const { token } = await createCredential(credentialsRepo(db), {
      personId: other.id,
      kind: 'token',
      label: 'ben',
    })
    expect((await b.tcp(token).rpc.dream.status()).mode).toBe('off')
  })

  test('dream.now of a person whose mode is off is refused with the reason off', async () => {
    const other = await b.local.rpc.admin.people.get({ person: 'ben' })
    const { token } = await createCredential(credentialsRepo(db), {
      personId: other.id,
      kind: 'token',
      label: 'ben-now',
    })
    expect(await refusal(b.tcp(token).rpc.dream.now())).toBe('CONFLICT:off')
  })
})

describe('dream.settings', () => {
  test('a member cannot set the member default or the cap; the owner sets them and one audit row records from and to', async () => {
    const member = b.tcp(memberToken)
    expect(await refusal(member.rpc.dream.settings.set({ memberDefault: 'propose' }))).toBe(
      'FORBIDDEN',
    )
    expect((await member.rpc.dream.settings.get()).memberDefault).toBe('off')

    const after = await b.local.rpc.dream.settings.set({ memberDefault: 'propose' })
    expect(after).toEqual({ maxUsdPerRun: 0.15, memberDefault: 'propose' })
    expect((await member.rpc.dream.settings.get()).memberDefault).toBe('propose')
    const rows = (await b.local.rpc.admin.audit.list({ limit: 500 })).filter(
      (e) => e.kind === 'settings.dreaming.set',
    )
    expect(rows.at(-1)?.detail).toEqual({
      from: { maxUsdPerRun: 0.15, memberDefault: 'off' },
      to: { maxUsdPerRun: 0.15, memberDefault: 'propose' },
    })
    await b.local.rpc.dream.settings.set({ memberDefault: 'off' })
  })

  test('the owner over TCP needs a step-up to set the settings', async () => {
    const owner = await b.local.rpc.admin.people.get({ person: 'owner' })
    const { token } = await createCredential(credentialsRepo(db), {
      personId: owner.id,
      kind: 'token',
      label: 'owner-tcp',
    })
    const tcp = b.tcp(token)
    expect(await refusal(tcp.rpc.dream.settings.set({ maxUsdPerRun: 0.1 }))).toBe(
      'KEITH_STEP_UP_REQUIRED',
    )
    await stepUp(b, token)
    expect((await tcp.rpc.dream.settings.set({ maxUsdPerRun: 0.1 })).maxUsdPerRun).toBe(0.1)
    await b.local.rpc.dream.settings.set({ maxUsdPerRun: 0.05 })
  })

  test('an out-of-bound cap is BAD_REQUEST and nothing moves', async () => {
    expect(await refusal(b.local.rpc.dream.settings.set({ maxUsdPerRun: 0.6 }))).toBe('BAD_REQUEST')
    expect((await b.local.rpc.dream.settings.get()).maxUsdPerRun).toBe(0.05)
  })
})

describe('dream.now and dream.apply refusals reach the RPC as CONFLICT', () => {
  test('a second dream.now within 20 hours is CONFLICT with reason too-soon, not a 500', async () => {
    const cy = await b.local.rpc.admin.people.add({ username: 'cy' })
    const { token } = await createCredential(credentialsRepo(db), {
      personId: cy.id,
      kind: 'token',
      label: 'cy',
    })
    dreamingRepo(db).setMode(cy.id, 'propose', cy.id)
    // a run that started just now: the cadence anchor of the 20-hour window
    dreamingRepo(db).startRun({ personId: cy.id, trigger: 'schedule', mode: 'propose' })
    expect(await refusal(b.tcp(token).rpc.dream.now())).toBe('CONFLICT:too-soon')
  })

  test('apply of a staged plan whose memory changed since is CONFLICT with reason staged-changed', async () => {
    const dee = await b.local.rpc.admin.people.add({ username: 'dee' })
    const { token } = await createCredential(credentialsRepo(db), {
      personId: dee.id,
      kind: 'token',
      label: 'dee',
    })
    const runId = 'run-staged-changed'
    writeStagedPlan(b.dir, {
      runId,
      personId: dee.id,
      stagedAt: Date.now(),
      plan: { candidates: [] },
      candidates: [],
      base: memoryBaseOf(b.dir, dee.id, [PROFILE_TIER, RECENT_TIER, ARCHIVE_TIER]),
    })
    // a chat write (or any change) to the memory after the plan was judged
    writeMemoryFile(b.dir, dee.id, PROFILE_TIER, '# Profile\n\nchanged after the judge\n')
    expect(await refusal(b.tcp(token).rpc.dream.apply({ runId }))).toBe('CONFLICT:staged-changed')
  })
})
