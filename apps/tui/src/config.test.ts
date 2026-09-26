import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tempConfigHome } from '../test/helpers.ts'
import { fileSessionStore, loadSession, type StoredSession, saveSession, sessionFilePath } from './config.ts'

const session: StoredSession = {
  url: 'http://127.0.0.1:4824',
  token: 'secret-token',
  person: { id: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V2Z', name: 'Tony', tier: 'owner' },
  expiresAt: 1790000000000,
  nodeId: 'nod_01J8ZQ3K4M5N6P7Q8R9S0T1V2Y',
}

describe('session file', () => {
  let home: { dir: string; cleanup: () => Promise<void> }
  beforeEach(async () => {
    home = await tempConfigHome()
  })
  afterEach(async () => {
    await home.cleanup()
  })

  test('lives in $XDG_CONFIG_HOME/keith/tui.json', () => {
    expect(sessionFilePath({ XDG_CONFIG_HOME: home.dir })).toBe(join(home.dir, 'keith', 'tui.json'))
  })

  test('falls back to ~/.config/keith/tui.json', () => {
    expect(sessionFilePath({ HOME: '/home/tony' })).toBe('/home/tony/.config/keith/tui.json')
    expect(sessionFilePath({ HOME: '/home/tony', XDG_CONFIG_HOME: '' })).toBe(
      '/home/tony/.config/keith/tui.json',
    )
  })

  test('is written with mode 600 and read back', async () => {
    const path = sessionFilePath({ XDG_CONFIG_HOME: home.dir })
    await saveSession(path, session)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await loadSession(path)).toEqual(session)
  })

  test('stays mode 600 when overwritten', async () => {
    const path = sessionFilePath({ XDG_CONFIG_HOME: home.dir })
    await saveSession(path, session)
    await saveSession(path, { ...session, token: 'other' })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await loadSession(path))?.token).toBe('other')
  })

  test('a missing or corrupt file means no session', async () => {
    const path = sessionFilePath({ XDG_CONFIG_HOME: home.dir })
    expect(await loadSession(path)).toBeNull()
    await saveSession(path, session)
    await writeFile(path, '{ not json')
    expect(await loadSession(path)).toBeNull()
    await writeFile(path, JSON.stringify({ token: 'x' }))
    expect(await loadSession(path)).toBeNull()
  })
})

describe('fileSessionStore', () => {
  test('saves, loads and clears the session file', async () => {
    const home = await tempConfigHome()
    try {
      const path = sessionFilePath({ XDG_CONFIG_HOME: home.dir })
      const store = fileSessionStore(path)
      expect(await store.load()).toBeNull()
      await store.save(session)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect(await store.load()).toEqual(session)
      await store.clear()
      expect(await store.load()).toBeNull()
      await store.clear()
    } finally {
      await home.cleanup()
    }
  })
})
