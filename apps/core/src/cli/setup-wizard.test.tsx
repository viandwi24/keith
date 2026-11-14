import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, secretsRepo, tokensRepo } from '@keith/db'
import { cleanup, render } from '@keith/ui/testing'
import { LockHeldError, type OfflineAdmin, openOfflineAdmin } from '../modules/admin/index.ts'
import { createHasher } from '../modules/auth/index.ts'
import { loadConfig } from '../platform/config.ts'
import { testIo } from '../testing/cli-io.ts'
import type { WizardOutcome } from './console-types.ts'
import { runCoreCli } from './program.ts'
import { SetupWizard } from './setup-wizard.tsx'

afterEach(cleanup)
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const KEY = ['sk', 'or', String(Bun.hash('wizard-key'))].join('-')
const PIN = String(Bun.hash('wizard-pin')).replace(/\D/g, '').slice(0, 8)
const ENTER = '\r'
const BACK = '\u001b[Z'
const ESC = '\u001b'
const DOWN = '\u001b[B'
const WIPE = '\x7f'.repeat(60)

const okFetch = (async () =>
  new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'keith-wizard-'))
  dirs.push(dir)
  return dir
}

async function openAdmin(dir: string, fetch: typeof globalThis.fetch = okFetch) {
  const config = loadConfig({ KEITH_DATA_DIR: dir })
  const admin = await openOfflineAdmin(config, {
    migrate: true,
    catalogs: { offline: true },
    fetch,
  })
  return { config, admin }
}

const wait = (ms = 60) => Bun.sleep(ms)

async function start(admin: OfflineAdmin, dir: string) {
  const config = loadConfig({ KEITH_DATA_DIR: dir })
  const outcomes: WizardOutcome[] = []
  const view = render(
    <SetupWizard
      admin={admin}
      config={config}
      hasher={createHasher({ memoryCost: 1024, timeCost: 1 })}
      onDone={(o) => outcomes.push(o)}
    />,
    { columns: 90, rows: 30 },
  )
  const send = async (text: string, ms = 60) => {
    view.stdin.write(text)
    await wait(ms)
  }
  const frame = () => view.lastFrame() ?? ''
  await wait(120)
  return { view, send, frame, outcomes }
}

type Wizard = Awaited<ReturnType<typeof start>>

/** Answer every step of a first run the way the flag flow below does. */
async function fullPass(w: Wizard, pin: string | undefined) {
  await w.send(WIPE)
  await w.send('Vian')
  await w.send(ENTER) // name
  await w.send(ENTER) // provider: openrouter
  await w.send(KEY)
  await w.send(ENTER, 200) // key, then the test
  await wait(100)
  await w.send(WIPE)
  await w.send('a')
  await w.send(ENTER) // front
  await w.send(WIPE)
  await w.send('b')
  await w.send(ENTER) // cortex
  await w.send(WIPE)
  await w.send('30')
  await w.send(ENTER) // budget
  await w.send(ENTER) // access: only this computer
  if (pin === undefined) await w.send(ENTER)
  else {
    await w.send(pin)
    await w.send(ENTER)
    await w.send(pin)
    await w.send(ENTER)
  }
}

function dump(dir: string) {
  const sqlite = openDatabase(join(dir, 'keith.db'))
  const settings = Object.fromEntries(
    (sqlite.query('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>)
      .filter((r) => r.key !== 'setup.completedAt')
      .map((r) => [r.key, r.value]),
  )
  const profiles = sqlite.query('SELECT id FROM config_profiles ORDER BY id').all()
  const owner = tokensRepo(sqlite).owner()?.name
  const pin = secretsRepo(sqlite).get(tokensRepo(sqlite).owner()?.id ?? '', 'pin')
  sqlite.close()
  return { settings, profiles, owner, pin }
}

describe('setup wizard', () => {
  test('a full pass saves what the flag flow saves, and no secret is ever drawn', async () => {
    const wizardDir = newDir()
    const { admin } = await openAdmin(wizardDir)
    const w = await start(admin, wizardDir)
    expect(w.frame()).toContain('step 1 of')
    await fullPass(w, PIN)
    expect(w.frame()).toContain('Save these settings?')
    expect(w.frame()).toContain('owner PIN')
    await w.send(ENTER, 400)
    expect(w.outcomes).toHaveLength(1)
    const outcome = w.outcomes[0]
    expect(outcome?.status).toBe('saved')
    admin.close()
    for (const f of w.view.frames) {
      expect(f).not.toContain(KEY)
      expect(f).not.toContain(PIN)
    }

    const flagDir = newDir()
    const io = testIo()
    io.send(`${KEY}\n${PIN}\n`)
    io.end()
    const code = await runCoreCli(
      [
        'setup',
        '--non-interactive',
        '--owner-name',
        'Vian',
        '--provider',
        'openrouter',
        '--api-key-stdin',
        '--owner-pin-stdin',
        '--front-model',
        'a',
        '--cortex-model',
        'b',
        '--budget',
        '30',
        '--access',
        'local',
      ],
      io,
      {
        env: { KEITH_DATA_DIR: flagDir },
        offline: { catalogs: { offline: true }, fetch: okFetch },
      },
    )
    expect(code).toBe(0)
    const fromWizard = dump(wizardDir)
    const fromFlags = dump(flagDir)
    expect(fromWizard.pin).toBeDefined() // the wizard also set the PIN
    expect({ ...fromWizard, pin: undefined }).toEqual({ ...fromFlags, pin: undefined })
    expect(fromWizard.owner).toBe('Vian')
    expect(fromWizard.settings['model.front']).toBe('"openrouter:a"')
    expect(fromWizard.settings['setup.done']).toBe('true')
  })

  test('back goes to the previous step and keeps the answers; the owner PIN is required', async () => {
    const dir = newDir()
    const { admin } = await openAdmin(dir)
    const w = await start(admin, dir)
    await w.send(WIPE)
    await w.send('Ana')
    await w.send(ENTER)
    expect(w.frame()).toContain('Which AI provider?')
    await w.send(BACK)
    expect(w.frame()).toContain('What should Keith call you?')
    expect(w.frame()).toContain('Ana')
    await w.send(ENTER)
    await w.send(DOWN.repeat(3)) // skip for now
    await w.send(ENTER)
    expect(w.frame()).toContain('Monthly budget') // no connection: no key or model steps
    await w.send(ENTER)
    await w.send(DOWN)
    await w.send(ENTER) // remote
    expect(w.frame()).toContain('URL your devices use')
    await w.send(ENTER) // none yet
    expect(w.frame()).toContain('Owner PIN')
    await w.send(ENTER) // not accepted empty: nobody could sign in
    expect(w.frame()).toContain('a PIN is needed')
    expect(w.frame()).toContain('Owner PIN')
    await w.send(PIN)
    await w.send(ENTER)
    await w.send(PIN)
    await w.send(ENTER)
    await w.send(ENTER, 300)
    expect(w.outcomes[0]?.status).toBe('saved')
    admin.close()
    const saved = dump(dir)
    expect(saved.owner).toBe('Ana')
    expect(saved.settings['access.mode']).toBe('"remote"')
    expect(saved.pin).toBeDefined()
    expect(saved.profiles).toEqual([])
  })

  test('a PIN that differs on confirmation goes back to the PIN step', async () => {
    const dir = newDir()
    const { admin } = await openAdmin(dir)
    const w = await start(admin, dir)
    await w.send(ENTER)
    await w.send(DOWN.repeat(3))
    await w.send(ENTER) // skip provider
    await w.send(ENTER) // budget
    await w.send(ENTER) // access
    await w.send(PIN)
    await w.send(ENTER)
    expect(w.frame()).toContain('Type the PIN again')
    await w.send(`${PIN}0`)
    await w.send(ENTER)
    expect(w.frame()).toContain('The PINs differ')
    expect(w.frame()).toContain('Owner PIN')
    w.view.unmount()
    admin.close()
  })

  test('escape cancels and nothing is saved, not even a tested key', async () => {
    const dir = newDir()
    const { admin } = await openAdmin(dir)
    const w = await start(admin, dir)
    await w.send(ENTER)
    await w.send(ENTER)
    await w.send(KEY)
    await w.send(ENTER, 200)
    await wait(100)
    expect(w.frame()).toContain('Front model')
    await w.send(ESC)
    expect(w.outcomes).toEqual([{ status: 'cancelled' }])
    admin.close()
    const saved = dump(dir)
    expect(saved.profiles).toEqual([])
    expect(saved.settings['setup.done']).toBeUndefined()
    for (const f of w.view.frames) expect(f).not.toContain(KEY)
  })

  test('a key that fails its test is not saved unless the owner says so', async () => {
    const dir = newDir()
    const bad = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    const { admin } = await openAdmin(dir, bad)
    const w = await start(admin, dir)
    await w.send(ENTER)
    await w.send(ENTER)
    await w.send(KEY)
    await w.send(ENTER, 200)
    await wait(100)
    expect(w.frame()).toContain('connection failed')
    expect(w.frame()).toContain('Try another key')
    await w.send(ENTER) // try another key: back to the key input
    expect(w.frame()).toContain('API key')
    expect(w.frame()).not.toContain(KEY)
    w.view.unmount()
    admin.close()
    expect(dump(dir).profiles).toEqual([])
  })

  test('the wizard refuses while another process holds the lock', async () => {
    const dir = newDir()
    const { admin } = await openAdmin(dir)
    const config = loadConfig({ KEITH_DATA_DIR: dir })
    await expect(openOfflineAdmin(config, { migrate: true })).rejects.toBeInstanceOf(LockHeldError)
    admin.close()
  })
})
