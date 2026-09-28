// `keith person …` (P5-A1): the logic runs on in-memory repositories (person-testing.ts) with a
// temp KEITH_HOME for the lock and the files, a fake clock and scripted answers.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeClock } from '@keith/sdk/testing'
import { keithPaths } from '../config/index.ts'
import { acquireHomeLock, LOCK_FILE_NAME } from '../shared/index.ts'
import type { PersonId, ThreadId } from '../shared/types.ts'
import { runCli, scriptedPrompter } from './index.ts'
import {
  hashInviteCode,
  loadPersonConfig,
  PERSON_SUBCOMMANDS,
  PERSON_USAGE,
  type PersonConfig,
  publicUrl,
  runPerson,
} from './person.ts'
import { createFakePersonRepos, type FakePersonRepos } from './person-testing.ts'

const NOW = 1_790_000_000_000
const HOUR = 3_600_000
const OWNER_ID = 'per_01OWNER000000000000000000' as PersonId

const homes: string[] = []
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

function config(over: Partial<PersonConfig['server']> = {}): PersonConfig {
  return {
    server: { host: '127.0.0.1', port: 4824, publicUrl: 'https://keith.example.net/', ...over },
    auth: { inviteTtlHours: 72 },
    mind: { timezone: 'Asia/Jakarta' },
  }
}

function setup(opts: { answers?: string[]; cfg?: PersonConfig } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'keith-person-'))
  homes.push(home)
  const paths = keithPaths(home)
  mkdirSync(paths.filesDir, { recursive: true })
  const repos = createFakePersonRepos()
  repos.data.persons.set(OWNER_ID, {
    id: OWNER_ID,
    name: 'Tony',
    username: 'tony',
    passwordHash: 'hash',
    tier: 'owner',
    lastSeenAt: NOW - HOUR,
    createdAt: NOW - 10 * HOUR,
  })
  const clock = createFakeClock(NOW)
  let out: string[] = []
  let err: string[] = []
  let closed = 0
  const run = {
    paths,
    clock,
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    prompter: scriptedPrompter(opts.answers ?? []),
    config: async () => opts.cfg ?? config(),
    open: async () => ({
      repos,
      close: () => {
        closed++
      },
    }),
  }
  return {
    home,
    paths,
    repos,
    clock,
    run,
    get out() {
      return out
    },
    get err() {
      return err
    },
    get closed() {
      return closed
    },
    reset() {
      out = []
      err = []
    },
    person: async (name: string) => {
      const p = await repos.persons.findByName(name)
      if (p === null) throw new Error(`no ${name}`)
      return p
    },
  }
}

type T = ReturnType<typeof setup>

function codeFrom(lines: string[]): string {
  const match = lines.join('\n').match(/#invite=([A-Za-z0-9_-]+)/)
  if (!match?.[1]) throw new Error('no invite link printed')
  return match[1]
}

async function add(t: T, ...args: string[]): Promise<string> {
  t.reset()
  expect(await runPerson(['add', ...args], t.run)).toBe(0)
  return codeFrom(t.out)
}

function links(repos: FakePersonRepos, personId: PersonId) {
  return [...repos.data.inviteLinks.values()].filter((l) => l.personId === personId)
}

describe('keith person add', () => {
  test('creates the person, the card and the main thread, and prints a link whose hash is stored', async () => {
    const t = setup()
    const code = await add(t, 'Pepper')
    const pepper = await t.person('Pepper')
    expect(pepper).toMatchObject({ name: 'Pepper', tier: 'member', username: null, passwordHash: null })
    expect(pepper.createdAt).toBe(NOW)
    expect(await t.repos.relationships.get(pepper.id)).toEqual({
      personId: pepper.id,
      tone: '',
      notes: '',
      blockedRelayFrom: [],
    })
    const main = await t.repos.threads.getBySlug(pepper.id, 'main')
    expect(main).toMatchObject({ kind: 'direct', title: 'Main', ownerPersonId: pepper.id })
    expect((await t.repos.threads.participants(main?.id as ThreadId)).map((p) => p.personId)).toEqual([
      pepper.id,
    ])

    expect(code).toHaveLength(43)
    expect(Buffer.from(code, 'base64url')).toHaveLength(32)
    const stored = links(t.repos, pepper.id)
    expect(stored).toEqual([
      {
        codeHash: hashInviteCode(code),
        personId: pepper.id,
        createdAt: NOW,
        expiresAt: NOW + 72 * HOUR,
        usedAt: null,
      },
    ])
    expect(hashInviteCode(code)).toBe(new Bun.CryptoHasher('sha256').update(code).digest('hex'))
    expect(t.out).toContain(`  https://keith.example.net/#invite=${code}`)
    expect(t.out).toContain(`  keith-tui --url https://keith.example.net --invite ${code}`)
    // 72 h after 2026-09-21 14:13:20 UTC, in Asia/Jakarta (UTC+7).
    expect(t.out.join('\n')).toContain('expires 2026-09-24 21:13 Asia/Jakarta')
    expect(t.closed).toBe(1)
  })

  test('the printed output never holds the hash, and the code only in the link and the TUI command', async () => {
    const t = setup()
    const code = await add(t, 'Pepper')
    const text = t.out.join('\n') + t.err.join('\n')
    expect(text).not.toContain(hashInviteCode(code))
    const withCode = t.out.filter((l) => l.includes(code))
    expect(withCode).toEqual([
      `  https://keith.example.net/#invite=${code}`,
      `  keith-tui --url https://keith.example.net --invite ${code}`,
    ])
    t.reset()
    expect(await runPerson(['invite', 'Pepper'], t.run)).toBe(0)
    const again = codeFrom(t.out)
    expect(t.out.join('\n')).not.toContain(hashInviteCode(again))
    expect(t.out.filter((l) => l.includes(again))).toHaveLength(2)
  })

  test('--tier guest, and the default public URL is http://<host>:<port>', async () => {
    const t = setup({ cfg: config({ publicUrl: undefined, host: '0.0.0.0', port: 5000 }) })
    const code = await add(t, 'Happy', '--tier', 'guest')
    expect((await t.person('Happy')).tier).toBe('guest')
    expect(t.out).toContain(`  http://0.0.0.0:5000/#invite=${code}`)
    expect(publicUrl({ host: '::1', port: 4824 })).toBe('http://[::1]:4824')
  })

  test('a second add with the same name or someone’s username is refused (case-insensitive)', async () => {
    const t = setup()
    await add(t, 'Pepper')
    for (const name of ['pepper', ' PEPPER ', 'TONY']) {
      t.reset()
      expect(await runPerson(['add', name], t.run)).toBe(1)
      expect(t.err[0]).toContain('is taken')
    }
    expect(t.repos.data.persons.size).toBe(2)
    expect(t.repos.data.inviteLinks.size).toBe(1)
  })

  test('refuses an empty name, one longer than 80 characters, the owner tier and an unknown tier', async () => {
    const t = setup()
    expect(await runPerson(['add', '  '], t.run)).toBe(1)
    expect(t.err[0]).toBe('A name is required.')
    t.reset()
    expect(await runPerson(['add', 'x'.repeat(81)], t.run)).toBe(1)
    expect(t.err[0]).toContain('at most 80')
    t.reset()
    expect(await runPerson(['add', 'Rhodey', '--tier', 'owner'], t.run)).toBe(1)
    expect(t.err[0]).toContain('exactly one owner')
    t.reset()
    expect(await runPerson(['add', 'Rhodey', '--tier', 'admin'], t.run)).toBe(2)
    t.reset()
    expect(await runPerson(['add'], t.run)).toBe(2)
    expect(await runPerson(['add', 'Pepper', 'Potts'], t.run)).toBe(2)
    expect(t.repos.data.persons.size).toBe(1)
    await add(t, 'x'.repeat(80))
  })
})

describe('keith person invite', () => {
  test('revokes the older unused link and stores the new one', async () => {
    const t = setup()
    const first = await add(t, 'Pepper')
    const pepper = await t.person('Pepper')
    t.clock.advance(HOUR)
    t.reset()
    expect(await runPerson(['invite', 'pepper'], t.run)).toBe(0)
    const second = codeFrom(t.out)
    expect(second).not.toBe(first)
    expect(t.out[0]).toBe('Revoked 1 older unused invite link(s).')
    expect(links(t.repos, pepper.id).map((l) => [l.codeHash, l.expiresAt])).toEqual([
      [hashInviteCode(second), NOW + HOUR + 72 * HOUR],
    ])
  })

  test('works for someone who signed in (a password reset); used links stay', async () => {
    const t = setup()
    const first = await add(t, 'Pepper')
    const pepper = await t.person('Pepper')
    await t.repos.inviteLinks.markUsed(hashInviteCode(first), NOW)
    await t.repos.persons.setCredentials(pepper.id, { username: 'pepper', passwordHash: 'h' })
    t.reset()
    expect(await runPerson(['invite', 'Pepper'], t.run)).toBe(0)
    expect(t.out[0]).toContain('can sign in as pepper')
    expect(links(t.repos, pepper.id)).toHaveLength(2)
  })

  test('refuses the owner and an unknown person', async () => {
    const t = setup()
    expect(await runPerson(['invite', 'Tony'], t.run)).toBe(1)
    expect(t.err[0]).toContain('keith setup')
    t.reset()
    expect(await runPerson(['invite', 'Nobody'], t.run)).toBe(1)
    expect(t.err[0]).toBe("No one is called Nobody. See 'keith person list'.")
    expect(t.repos.data.inviteLinks.size).toBe(0)
  })
})

describe('keith person list', () => {
  test('prints name, tier, username, sign-in and last seen in mind.timezone', async () => {
    const t = setup()
    await add(t, 'Pepper', '--tier', 'guest')
    t.reset()
    expect(await runPerson(['list'], t.run)).toBe(0)
    expect(t.out).toEqual([
      'NAME    TIER   USERNAME  SIGN-IN  LAST SEEN (Asia/Jakarta)',
      'Tony    owner  tony      yes      2026-09-21 20:13',
      'Pepper  guest  -         no       -',
    ])
  })
})

describe('keith person tier', () => {
  test('changes a member to a guest and back', async () => {
    const t = setup()
    await add(t, 'Pepper')
    t.reset()
    expect(await runPerson(['tier', 'Pepper', 'guest'], t.run)).toBe(0)
    expect((await t.person('Pepper')).tier).toBe('guest')
    expect(t.out).toEqual(['Pepper is now a guest (was member).'])
    expect(await runPerson(['tier', 'Pepper', 'member'], t.run)).toBe(0)
    expect((await t.person('Pepper')).tier).toBe('member')
  })

  test('refuses owner as a tier and refuses to change the owner', async () => {
    const t = setup()
    await add(t, 'Pepper')
    t.reset()
    expect(await runPerson(['tier', 'Pepper', 'owner'], t.run)).toBe(1)
    expect(t.err[0]).toContain('exactly one owner')
    expect((await t.person('Pepper')).tier).toBe('member')
    t.reset()
    expect(await runPerson(['tier', 'Tony', 'guest'], t.run)).toBe(1)
    expect(t.err[0]).toContain('is the owner')
    expect((await t.person('Tony')).tier).toBe('owner')
    expect(await runPerson(['tier', 'Pepper'], t.run)).toBe(2)
  })
})

describe('keith person card', () => {
  test('edits keep the other fields and blockedRelayFrom', async () => {
    const t = setup()
    await add(t, 'Pepper')
    const pepper = await t.person('Pepper')
    expect(await runPerson(['block', 'Pepper', '--from', 'Tony'], t.run)).toBe(0)
    t.reset()
    expect(await runPerson(['card', 'Pepper', '--tone', 'warm, brief'], t.run)).toBe(0)
    expect(await runPerson(['card', 'Pepper', '--notes', 'runs the company'], t.run)).toBe(0)
    expect(await t.repos.relationships.get(pepper.id)).toEqual({
      personId: pepper.id,
      tone: 'warm, brief',
      notes: 'runs the company',
      blockedRelayFrom: [OWNER_ID],
    })
    t.reset()
    expect(await runPerson(['card', 'Pepper'], t.run)).toBe(0)
    expect(t.out).toEqual([
      'Relationship card of Pepper (member):',
      '  tone:  warm, brief',
      '  notes: runs the company',
      '  relays refused from: Tony',
    ])
  })

  test('a person without a card gets one on the first edit', async () => {
    const t = setup()
    expect(await runPerson(['card', 'Tony'], t.run)).toBe(0)
    expect(t.out[1]).toBe('  tone:  -')
    expect(await runPerson(['card', 'Tony', '--tone', 'dry'], t.run)).toBe(0)
    expect(await t.repos.relationships.get(OWNER_ID)).toEqual({
      personId: OWNER_ID,
      tone: 'dry',
      notes: '',
      blockedRelayFrom: [],
    })
  })
})

describe('keith person block / unblock', () => {
  test('round-trip, idempotent', async () => {
    const t = setup()
    await add(t, 'Pepper')
    await add(t, 'Happy', '--tier', 'guest')
    const pepper = await t.person('Pepper')
    const happy = await t.person('Happy')
    t.reset()
    expect(await runPerson(['block', 'Pepper', '--from', 'happy'], t.run)).toBe(0)
    expect(await runPerson(['block', 'Pepper', '--from', 'Happy'], t.run)).toBe(0)
    expect(t.out).toEqual([
      'Pepper now refuses relays from Happy.',
      'Pepper already refuses relays from Happy.',
    ])
    expect((await t.repos.relationships.get(pepper.id))?.blockedRelayFrom).toEqual([happy.id])
    expect((await t.repos.relationships.get(happy.id))?.blockedRelayFrom).toEqual([])
    t.reset()
    expect(await runPerson(['unblock', 'Pepper', '--from', 'Happy'], t.run)).toBe(0)
    expect(await runPerson(['unblock', 'Pepper', '--from', 'Happy'], t.run)).toBe(0)
    expect(t.out).toEqual([
      'Pepper accepts relays from Happy again.',
      "Pepper doesn't refuse relays from Happy.",
    ])
    expect((await t.repos.relationships.get(pepper.id))?.blockedRelayFrom).toEqual([])
  })

  test('refuses blocking yourself, an unknown other, and a missing --from', async () => {
    const t = setup()
    await add(t, 'Pepper')
    t.reset()
    expect(await runPerson(['block', 'Pepper', '--from', 'pepper'], t.run)).toBe(1)
    expect(t.err[0]).toBe("Pepper can't block themselves.")
    t.reset()
    expect(await runPerson(['block', 'Pepper', '--from', 'Nobody'], t.run)).toBe(1)
    expect(await runPerson(['unblock', 'Pepper'], t.run)).toBe(2)
    expect(await runPerson(['block', 'Pepper', '--from'], t.run)).toBe(2)
  })
})

describe('keith person remove', () => {
  async function withUpload(t: T): Promise<{ pepper: PersonId; file: string }> {
    await add(t, 'Pepper')
    const pepper = (await t.person('Pepper')).id
    mkdirSync(join(t.paths.filesDir, '2026', '09'), { recursive: true })
    const file = join(t.paths.filesDir, '2026', '09', 'pepper.png')
    writeFileSync(file, 'png')
    t.repos.data.files.push({ path: '2026/09/pepper.png', ownerPersonId: pepper })
    await t.repos.relationships.upsert({
      personId: OWNER_ID,
      tone: '',
      notes: '',
      blockedRelayFrom: [pepper],
    })
    return { pepper, file }
  }

  test('is refused while another process holds the lock', async () => {
    const t = setup()
    const { pepper, file } = await withUpload(t)
    const lock = await acquireHomeLock(t.home)
    try {
      t.reset()
      expect(await runPerson(['remove', 'Pepper', '--yes'], t.run)).toBe(1)
      expect(t.err.join('\n')).toContain('already running')
      expect(t.repos.data.persons.has(pepper)).toBe(true)
      expect(existsSync(file)).toBe(true)
    } finally {
      await lock.release()
    }
  })

  test('with --yes removes the person, deletes their uploaded file and prints the counts', async () => {
    const t = setup()
    const { pepper, file } = await withUpload(t)
    t.reset()
    expect(await runPerson(['remove', 'Pepper', '--yes'], t.run)).toBe(0)
    expect(t.repos.data.persons.has(pepper)).toBe(false)
    expect(existsSync(file)).toBe(false)
    expect((await t.repos.relationships.get(OWNER_ID))?.blockedRelayFrom).toEqual([])
    const text = t.out.join('\n')
    expect(text).toContain("Run 'keith backup' first")
    expect(text).toContain('their 1 direct thread(s)')
    expect(t.out).toContain('Removed Pepper.')
    expect(t.out).toContain('  direct threads: 1')
    expect(t.out).toContain('  invite links: 1')
    expect(t.out).toContain('  block lists that named them: 1')
    expect(t.out.at(-1)).toBe(`Deleted 1 of 1 stored file(s) from ${t.paths.filesDir}.`)
    expect(t.err).toEqual([])
    expect(existsSync(join(t.home, LOCK_FILE_NAME))).toBe(false)
  })

  test('a missing file is only a warning', async () => {
    const t = setup()
    const { pepper, file } = await withUpload(t)
    rmSync(file)
    t.repos.data.files.push({ path: '../outside.txt', ownerPersonId: pepper })
    t.reset()
    expect(await runPerson(['remove', 'Pepper', '--yes'], t.run)).toBe(0)
    expect(t.err).toEqual([
      `warning: file already missing: ${file}`,
      `warning: not deleting ../outside.txt: it is outside ${t.paths.filesDir}`,
    ])
    expect(t.out.at(-1)).toBe(`Deleted 0 of 2 stored file(s) from ${t.paths.filesDir}.`)
  })

  test('asks first; anything but yes keeps everything', async () => {
    const t = setup({ answers: ['', 'y'] })
    const { pepper } = await withUpload(t)
    t.reset()
    expect(await runPerson(['remove', 'Pepper'], t.run)).toBe(1)
    expect(t.out.at(-1)).toBe('Cancelled. Nothing was removed.')
    expect(t.repos.data.persons.has(pepper)).toBe(true)
    expect(await runPerson(['remove', 'Pepper'], t.run)).toBe(0)
    expect(t.repos.data.persons.has(pepper)).toBe(false)
  })

  test('refuses the owner and an unknown person', async () => {
    const t = setup()
    expect(await runPerson(['remove', 'Tony', '--yes'], t.run)).toBe(1)
    expect(t.err[0]).toContain("the owner can't be removed")
    t.reset()
    expect(await runPerson(['remove', 'Nobody', '--yes'], t.run)).toBe(1)
    expect(t.repos.data.persons.has(OWNER_ID)).toBe(true)
  })

  test('the other subcommands run while the lock is held (Keith running)', async () => {
    const t = setup()
    const lock = await acquireHomeLock(t.home)
    try {
      await add(t, 'Pepper')
      expect(await runPerson(['tier', 'Pepper', 'guest'], t.run)).toBe(0)
      expect(await runPerson(['list'], t.run)).toBe(0)
    } finally {
      await lock.release()
    }
  })
})

describe('loadPersonConfig', () => {
  test('ignores plugin sections, so an unset env: key does not stop the command', async () => {
    const t = setup()
    await Bun.write(
      t.paths.configFile,
      `[server]
publicUrl = "https://keith.example.net"

[auth]
inviteTtlHours = 1.5

[plugins]
enabled = ["@keith/provider-deepseek"]

[plugins."@keith/provider-deepseek"]
apiKey = "env:DEEPSEEK_API_KEY"
`,
    )
    const cfg = await loadPersonConfig(t.paths, { KEITH__SERVER__PORT: '5001' })
    expect(cfg.server).toMatchObject({ publicUrl: 'https://keith.example.net', port: 5001 })
    expect(cfg.auth.inviteTtlHours).toBe(1.5)
  })
})

describe('keith person (surface)', () => {
  function io(env: Record<string, string> = {}) {
    const out: string[] = []
    const err: string[] = []
    return { out, err, cli: { env, out: (l: string) => out.push(l), err: (l: string) => err.push(l) } }
  }

  test('without a subcommand prints the usage with every subcommand', async () => {
    const t = io()
    expect(await runCli(['person'], t.cli)).toBe(0)
    expect(t.out.join('\n')).toBe(PERSON_USAGE)
    for (const sub of PERSON_SUBCOMMANDS) expect(PERSON_USAGE).toContain(`  ${sub} `)
    expect(PERSON_USAGE).toContain('#invite=<code>')
  })

  test('the keith usage lists the person command', async () => {
    const t = io()
    expect(await runCli(['--help'], t.cli)).toBe(0)
    expect(t.out.join('\n')).toContain('person <command>')
  })

  test('an unknown subcommand is a usage error', async () => {
    const t = io()
    expect(await runCli(['person', 'rename'], t.cli)).toBe(2)
    expect(t.err[0]).toBe('Unknown person command: rename')
  })

  test('a home without a database asks for keith setup and creates nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'keith-person-'))
    homes.push(home)
    const t = io({ KEITH_HOME: home })
    expect(await runCli(['person', 'list'], t.cli)).toBe(1)
    expect(t.err[0]).toContain("run 'keith setup'")
    expect(existsSync(join(home, 'keith.db'))).toBe(false)
  })
})
