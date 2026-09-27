// `keith restore` (docs/architecture/storage.md#backups).

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquireHomeLock, LOCK_FILE_NAME } from '../shared/index.ts'
import type { PersonId } from '../shared/types.ts'
import { knownMigrations } from './backup.ts'
import { type Cleanups, cliIo, ownerHome, type Seeded, seed, startKeith, tempDir } from './backup-testing.ts'
import { runCli } from './index.ts'

const cleanups: Cleanups = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

/** A home with seeded rows and a file, backed up while Keith runs. Returns the backup folder. */
async function makeBackup(): Promise<{ dir: string; seeded: Seeded; owner: PersonId }> {
  const { home, owner } = await ownerHome(cleanups)
  writeFileSync(join(home, 'persona.md'), 'You are Keith.')
  const keith = await startKeith(home, cleanups)
  const seeded = await seed(keith, owner)
  mkdirSync(join(home, 'files', 'ab'), { recursive: true })
  writeFileSync(join(home, 'files', 'ab', 'f1'), 'file one')
  const out = tempDir(cleanups)
  expect(await runCli(['backup', '--out', out], cliIo(home))).toBe(0)
  await keith.stop()
  const [name] = readdirSync(out)
  return { dir: join(out, name ?? ''), seeded, owner }
}

function emptyHome(): string {
  return join(tempDir(cleanups, 'keith-restore-'), 'home')
}

function setManifest(dir: string, patch: Record<string, unknown>): void {
  const path = join(dir, 'manifest.json')
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...patch }))
}

describe('keith restore', () => {
  test('restores into an empty home; a bootstrapped Keith finds everything from before', async () => {
    const { dir, seeded, owner } = await makeBackup()
    const home = emptyHome()
    const cli = cliIo(home)
    expect(await runCli(['restore', dir], cli)).toBe(0)
    expect(cli.lines.join('\n')).toContain(`into ${home}`)
    expect(existsSync(join(home, LOCK_FILE_NAME))).toBe(false)
    expect(readFileSync(join(home, 'files', 'ab', 'f1'), 'utf8')).toBe('file one')
    expect(readFileSync(join(home, 'persona.md'), 'utf8')).toBe('You are Keith.')

    const keith = await startKeith(home, cleanups)
    expect((await keith.repos.persons.get(owner))?.username).toBe('tony')
    expect(await keith.repos.threads.get(seeded.threadId)).toMatchObject({ slug: 'garden', title: 'Garden' })
    expect(await keith.repos.messages.get(seeded.messageId)).toMatchObject({
      content: 'Plant the tomatoes in May.',
    })
    expect(await keith.repos.memories.get(seeded.memoryId)).toMatchObject({ content: 'Tony grows tomatoes' })
    expect(await keith.repos.reminders.get(seeded.reminderId)).toMatchObject({
      text: 'Water the tomatoes',
      status: 'pending',
      personId: owner,
    })
  })

  test('over an existing home: refused without --force (nothing changes), kept aside with --force', async () => {
    const { dir, seeded } = await makeBackup()
    const { home } = await ownerHome(cleanups)
    writeFileSync(join(home, 'persona.md'), 'old persona')
    const before = readdirSync(home).sort()
    const dbBefore = readFileSync(join(home, 'keith.db'))

    const cli = cliIo(home)
    expect(await runCli(['restore', dir], cli)).toBe(1)
    expect(cli.errors.join('\n')).toContain('already exists')
    expect(cli.errors.join('\n')).toContain('--force')
    expect(readdirSync(home).sort()).toEqual(before)
    expect(readFileSync(join(home, 'keith.db')).equals(dbBefore)).toBe(true)

    const forced = cliIo(home)
    expect(await runCli(['restore', dir, '--force'], forced)).toBe(0)
    const aside = readdirSync(join(home, '..')).find((n) => n.includes('.before-restore-'))
    expect(aside).toBeDefined()
    const asideDir = join(home, '..', aside ?? '')
    expect(readFileSync(join(asideDir, 'persona.md'), 'utf8')).toBe('old persona')
    expect(readFileSync(join(asideDir, 'keith.db')).equals(dbBefore)).toBe(true)
    expect(forced.lines.join('\n')).toContain(`to ${asideDir}`)
    cleanups.push(() => rmSync(asideDir, { recursive: true, force: true }))

    expect(readFileSync(join(home, 'persona.md'), 'utf8')).toBe('You are Keith.')
    const keith = await startKeith(home, cleanups)
    expect(await keith.repos.memories.get(seeded.memoryId)).toMatchObject({ content: 'Tony grows tomatoes' })
  })

  test('fails with the lock message while Keith runs', async () => {
    const { dir } = await makeBackup()
    const home = emptyHome()
    mkdirSync(home)
    const lock = await acquireHomeLock(home)
    try {
      const cli = cliIo(home)
      expect(await runCli(['restore', dir], cli)).toBe(1)
      expect(cli.errors.join('\n')).toContain('already running')
      expect(readdirSync(home)).toEqual([LOCK_FILE_NAME])
    } finally {
      await lock.release()
    }
  })

  test('refuses a manifest with an unknown or newer lastMigration, or another format', async () => {
    const { dir } = await makeBackup()
    const home = emptyHome()

    setManifest(dir, { lastMigration: '99991231235959_from-the-future' })
    let cli = cliIo(home)
    expect(await runCli(['restore', dir], cli)).toBe(1)
    expect(cli.errors.join('\n')).toContain('made by a newer Keith')

    setManifest(dir, { lastMigration: '20000101000000_unknown' })
    cli = cliIo(home)
    expect(await runCli(['restore', dir], cli)).toBe(1)
    expect(cli.errors.join('\n')).toContain('unknown to this Keith')

    setManifest(dir, { lastMigration: (await knownMigrations()).at(-1), format: 2 })
    cli = cliIo(home)
    expect(await runCli(['restore', dir], cli)).toBe(1)
    expect(cli.errors.join('\n')).toContain('unsupported format 2')
    expect(existsSync(join(home, 'keith.db'))).toBe(false)
  })

  test('an older backup is upgraded by the pending migrations', async () => {
    const { dir } = await makeBackup()
    const known = await knownMigrations()
    setManifest(dir, { lastMigration: known[0] })
    const home = emptyHome()
    const cli = cliIo(home)
    expect(await runCli(['restore', dir], cli)).toBe(0)
    expect(cli.lines.join('\n')).toContain(`Database upgraded from ${known[0]} to ${known.at(-1)}`)
  })

  test('refuses a backup containing a link to ../x, without following it', async () => {
    const { dir } = await makeBackup()
    const outside = join(dir, '..', 'x')
    writeFileSync(outside, 'outside')
    symlinkSync('../../x', join(dir, 'files', 'escape'))
    const home = emptyHome()
    const cli = cliIo(home)
    expect(await runCli(['restore', dir], cli)).toBe(1)
    expect(cli.errors.join('\n')).toContain('files/escape is a symbolic link')
    expect(existsSync(join(home, 'keith.db'))).toBe(false)
  })

  test('refuses a folder without a manifest, and a missing argument', async () => {
    const home = emptyHome()
    const cli = cliIo(home)
    expect(await runCli(['restore', tempDir(cleanups)], cli)).toBe(1)
    expect(cli.errors.join('\n')).toContain('manifest.json')
    expect(await runCli(['restore'], cli)).toBe(2)
  })
})
