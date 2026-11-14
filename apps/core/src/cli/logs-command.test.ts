import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type LlmCallRecord, LOGS_SETTINGS_BOUNDS } from '@keith/contracts'
import { type ActivityCallInput, activityLogsRepo, openDatabase, type Sqlite } from '@keith/db'
import { loadConfig } from '../platform/config.ts'
import { type BootedCore, bootCore } from '../testing/boot-core.ts'
import { testIo } from '../testing/cli-io.ts'
import type { CliDeps } from './context.ts'
import { runCoreCli } from './program.ts'

// `keith-core logs ...` (docs/specs/activity-logs.md, "CLI", P36.5.1): a real core on a temp data dir, the CLI over its
// socket as the owner. Ana's sessions are seeded straight into the database; every read of them is an owner-path read.
let b: BootedCore
let db: Sqlite
let deps: CliDeps
let anaId: string

const T0 = Date.UTC(2026, 10, 10, 9, 0)
const call = (id: string, sessionId: string, over: Partial<LlmCallRecord> = {}): LlmCallRecord => ({
  id,
  sessionId,
  kind: 'step',
  trigger: 'send',
  turnId: 'turn-1',
  stepIndex: 0,
  startedAt: T0,
  durationMs: 420,
  firstChunkMs: 80,
  status: 'ok',
  finishReason: 'stop',
  modelId: 'scripted-a',
  provider: 'scripted',
  upstreamProvider: null,
  tokensIn: 120,
  tokensOut: 30,
  cacheRead: null,
  cacheWrite: null,
  reasoning: null,
  costMicro: 2500,
  costSource: 'estimate',
  fallbackNote: null,
  errorName: null,
  errorMessage: null,
  requestBytes: 10,
  responseBytes: 10,
  bodyState: 'stored',
  speakerId: null,
  ...over,
})

beforeAll(async () => {
  b = await bootCore()
  await b.local.rpc.admin.people.add({ username: 'ana' })
  anaId = (await b.local.rpc.admin.people.get({ person: 'ana' })).id
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: b.dir }).dbFile)
  const sessionInput = {
    id: `front:${anaId}:chat-1`,
    kind: 'chat' as const,
    personId: anaId,
    roomId: null,
    app: 'Front',
  }
  const batch: ActivityCallInput[] = [
    {
      session: sessionInput,
      call: call('call-1', sessionInput.id),
      bodies: {
        request: Bun.gzipSync(
          new TextEncoder().encode('{"messages":[{"role":"user","text":"hi"}]}'),
        ),
        response: Bun.gzipSync(new TextEncoder().encode('{"text":"hello"}')),
        output: null,
      },
    },
    { session: sessionInput, call: call('call-2', sessionInput.id, { startedAt: T0 + 1000 }) },
  ]
  activityLogsRepo(db).insertCalls(batch)
  deps = { env: { KEITH_DATA_DIR: b.dir, KEITH_BUILD_SHA: 'test' } }
})

afterAll(async () => {
  db.close()
  await b.stop()
})

async function cli(...argv: string[]) {
  const io = testIo()
  io.end()
  const code = await runCoreCli(argv, io, deps)
  return { code, out: io.out(), err: io.err() }
}

const ownerReads = async (kind: string) =>
  (await b.local.rpc.admin.audit.list({ limit: 500 })).filter(
    (e) => e.kind === kind && JSON.stringify(e.detail).includes(anaId),
  )

describe('keith-core logs list', () => {
  test("lists the owner's own sessions; another person's needs the owner path and is audited", async () => {
    const mine = await cli('logs', 'list')
    expect(mine.code).toBe(0)
    expect(mine.out).toContain('ID')
    expect(mine.out).not.toContain(`front:${anaId}`)

    const before = (await ownerReads('logs.owner-read')).length
    const theirs = await cli('logs', 'list', '--person', 'ana', '--kind', 'chat', '--limit', '5')
    expect(theirs.code).toBe(0)
    expect(theirs.out).toContain(`front:${anaId}:chat-1`)
    expect(theirs.out).toContain('scripted-a')
    expect((await ownerReads('logs.owner-read')).length).toBeGreaterThan(before)
  })

  test('a bad --kind or --limit is refused before anything is read', async () => {
    expect((await cli('logs', 'list', '--kind', 'nope')).code).toBe(2)
    expect((await cli('logs', 'list', '--limit', 'x')).code).toBe(2)
  })

  test('--json prints the RPC answer', async () => {
    const json = await cli('logs', 'list', '--person', 'ana', '--json')
    expect(JSON.parse(json.out).sessions[0].id).toBe(`front:${anaId}:chat-1`)
  })
})

describe('keith-core logs show, call', () => {
  test('show prints the overview and one row per generation', async () => {
    const shown = await cli('logs', 'show', `front:${anaId}:chat-1`)
    expect(shown.code).toBe(0)
    expect(shown.out).toContain(`session front:${anaId}:chat-1: chat (Front)`)
    expect(shown.out).toContain('call-1')
    expect(shown.out).toContain('call-2')
  })

  test('call prints the figures and no raw body', async () => {
    const out = await cli('logs', 'call', 'call-1')
    expect(out.code).toBe(0)
    expect(out.out).toContain('model: scripted-a via scripted')
    expect(out.out).toContain('tokens: 120 in, 30 out')
    expect(out.out).not.toContain('{"messages"')
  })

  test('a missing call id is a usage error', async () => {
    expect((await cli('logs', 'call')).code).toBe(2)
  })
})

describe('keith-core logs raw', () => {
  test('prints the stored request and writes an owner-path row every time', async () => {
    const before = (await ownerReads('logs.owner-read')).length
    const raw = await cli('logs', 'raw', 'call-1', '--part', 'request')
    expect(raw.code).toBe(0)
    expect(raw.out).toContain('"messages"')
    expect(raw.out).not.toContain('"text":"hello"')
    await cli('logs', 'raw', 'call-1', '--part', 'response')
    expect((await ownerReads('logs.owner-read')).length).toBeGreaterThanOrEqual(before + 2)
  })

  test('a call without a stored body says so, and a bad part is refused', async () => {
    const none = await cli('logs', 'raw', 'call-2', '--part', 'request')
    expect(none.out).toContain('not kept')
    expect((await cli('logs', 'raw', 'call-1', '--part', 'output')).code).toBe(2)
  })
})

describe('keith-core logs settings', () => {
  test('no flag shows the settings; a valid change is audited with the field names only', async () => {
    const shown = await cli('logs', 'settings')
    expect(shown.out).toContain('body-days')

    const changed = await cli('logs', 'settings', '--body-days', '21', '--capture-bodies', 'off')
    expect(changed.code).toBe(0)
    expect(changed.out).toContain('21')
    const rows = (await b.local.rpc.admin.audit.list({ limit: 500 })).filter(
      (e) => e.kind === 'logs.settings',
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(JSON.stringify(rows[0]?.detail)).toContain('bodyRetentionDays')
    expect(JSON.stringify(rows[0]?.detail)).not.toContain('21')
    await cli('logs', 'settings', '--body-days', '14', '--capture-bodies', 'on')
  })

  test('an out-of-bound value or a bodies-longer-than-figures pair is refused and writes nothing', async () => {
    const before = await b.local.rpc.logs.settings.get()
    const tooLong = await cli(
      'logs',
      'settings',
      '--body-days',
      String(LOGS_SETTINGS_BOUNDS.bodyRetentionDays.max),
    )
    const low = await cli('logs', 'settings', '--max-body-bytes', '10')
    const onOffWrong = await cli('logs', 'settings', '--guest-bodies', 'yes')
    const pair = await cli('logs', 'settings', '--body-days', '90', '--meta-days', '30')
    expect(low.code).toBe(2)
    expect(onOffWrong.code).toBe(2)
    expect(pair.code).toBe(2)
    expect(pair.err).toContain('bodies are kept no longer')
    expect(tooLong.code).toBe(0)
    await b.local.rpc.logs.settings.set({ bodyRetentionDays: before.bodyRetentionDays })
    expect((await b.local.rpc.logs.settings.get()).bodyRetentionDays).toBe(before.bodyRetentionDays)
  })
})

describe('keith-core logs help', () => {
  test('--help lists every subcommand through the registry', async () => {
    const help = await cli('logs', '--help')
    for (const name of ['list', 'show', 'call', 'raw', 'settings', 'prune'])
      expect(help.out).toContain(name)
  })
})
