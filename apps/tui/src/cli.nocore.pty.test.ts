import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakeCore } from './testing/fake-core.ts'
import { until } from './testing/pty.ts'
import { VtScreen } from './testing/vt-screen.ts'

const ptySupported = process.platform !== 'win32'
const TEST_TIMEOUT = 90_000
const cli = join(import.meta.dir, 'cli.tsx')

const procs: Array<{ kill(): void; exited: Promise<number> }> = []
const dirs: string[] = []
afterEach(async () => {
  for (const p of procs.splice(0)) {
    p.kill()
    await p.exited
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** An empty home (no client.json, no core.sock), so nothing is found; never the real one. */
function emptyHome(): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), 'keith-nocore-'))
  dirs.push(home)
  return Object.fromEntries(
    Object.entries({
      ...process.env,
      HOME: home,
      KEITH_HOME: home,
      KEITH_DATA_DIR: join(home, 'data'),
      KEITH_CLIENT_CONFIG: join(home, 'client.json'),
      NO_COLOR: '1',
    })
      .filter((e): e is [string, string] => e[1] !== undefined)
      .filter(([k]) => k !== 'CI' && k !== 'CONTINUOUS_INTEGRATION' && !k.startsWith('CI_')),
  )
}

describe.skipIf(!ptySupported)('keith with no core found, in a real pseudo-terminal', () => {
  test(
    'opens the Sign in screen on the default address, and ctrl+c exits 0',
    async () => {
      const env = emptyHome()
      const vt = new VtScreen(100, 30)
      const proc = Bun.spawn(['bun', cli], {
        env,
        terminal: { cols: 100, rows: 30, data: (_t, data) => vt.feed(data) },
      })
      procs.push(proc)
      const screen = (): string => vt.text()
      await until(
        () => screen().includes('Which core do you want to sign in to?'),
        30_000,
        'the Sign in screen',
        screen,
      )
      expect(screen()).not.toContain('No core found')
      expect(screen()).toContain('http://localhost:7420')
      // nothing past this point may depend on what listens on the default address of this
      // machine (the owner's core, maybe): the screen only has to be there, then ctrl+c leaves
      proc.terminal?.write('\u0003')
      expect(await proc.exited).toBe(0)
    },
    TEST_TIMEOUT,
  )

  test(
    'the address is changed to a core, then who, the PIN, and Home signed in (no default address involved)',
    async () => {
      const pin = ['4', '8', '1', '5', '9', '2'].join('')
      const core = startFakeCore({ revoked: true, flow: { people: { owner: { pin } } } })
      try {
        const vt = new VtScreen(100, 30)
        const proc = Bun.spawn(['bun', cli], {
          env: emptyHome(),
          terminal: { cols: 100, rows: 30, data: (_t, data) => vt.feed(data) },
        })
        procs.push(proc)
        const screen = (): string => vt.text()
        await until(
          () => screen().includes('Which core do you want to sign in to?'),
          30_000,
          'the Sign in screen',
          screen,
        )
        // replace the default address with the fake core's: erase it, type, enter
        await Bun.sleep(400)
        proc.terminal?.write('\u007f'.repeat('http://localhost:7420'.length))
        await until(() => !screen().includes('localhost'), 20_000, 'the erased address', screen)
        const url = core.url.replace(/\/+$/, '')
        proc.terminal?.write(url)
        await until(() => screen().includes(url), 20_000, 'the typed address', screen)
        proc.terminal?.write('\r')
        await until(
          () => screen().includes('id, username, email or phone'),
          20_000,
          'the box',
          screen,
        )
        await Bun.sleep(300)
        proc.terminal?.write('owner')
        await until(() => screen().includes('owner'), 20_000, 'the identifier', screen)
        proc.terminal?.write('\r')
        await until(() => screen().includes('[PIN]'), 20_000, 'the PIN', screen)
        await Bun.sleep(300)
        proc.terminal?.write(pin)
        await until(() => screen().includes('••••••'), 20_000, 'the masked PIN', screen)
        proc.terminal?.write('\r')
        await until(
          () => screen().includes('[enter] chat') && screen().includes('signed in as Owner'),
          30_000,
          'Home signed in',
          screen,
        )
        expect(core.identified).toEqual(['owner'])
        proc.terminal?.write('\u0003')
        expect(await proc.exited).toBe(0)
      } finally {
        core.stop()
      }
    },
    TEST_TIMEOUT,
  )

  test(
    'a stored core that is down opens Home on it (orb, sign-in panel), not the bare Sign in screen',
    async () => {
      const core = startFakeCore({ revoked: true })
      const url = core.url.replace(/\/+$/, '')
      core.stop()
      const env = emptyHome()
      writeFileSync(
        env.KEITH_CLIENT_CONFIG ?? '',
        JSON.stringify({ core: url, token: ['keith', 's', 'legacy'].join('_') }),
      )
      const vt = new VtScreen(100, 30)
      const proc = Bun.spawn(['bun', cli], {
        env,
        terminal: { cols: 100, rows: 30, data: (_t, data) => vt.feed(data) },
      })
      procs.push(proc)
      const screen = (): string => vt.text()
      await until(
        () => screen().includes('Cannot reach the core'),
        30_000,
        'the offline Home',
        screen,
      )
      expect(screen()).not.toContain('Which core do you want to sign in to?')
      proc.terminal?.write('\u0003')
      expect(await proc.exited).toBe(0)
    },
    TEST_TIMEOUT,
  )
})
