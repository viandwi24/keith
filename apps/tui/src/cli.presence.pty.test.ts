import { afterEach, describe, expect, test } from 'bun:test'
import { launch, stopPty, until } from './testing/pty.ts'

const ptySupported = process.platform !== 'win32'

/** Above bun's 5 s default: starting the CLI is slow on emulated CI machines. */
const TEST_TIMEOUT = 90_000

afterEach(stopPty)

describe.skipIf(!ptySupported)('keith registers itself as a presence client', () => {
  test(
    'the real terminal app registers one tui client with chat, notify and open.view once it is up',
    async () => {
      const { cli, core } = await launch({}, ['K E I T H', '[enter] chat'], 100, undefined, [])
      await until(
        () => core.presence.registers.length > 0,
        20_000,
        'the client register',
        cli.screen,
      )
      expect(core.presence.registers[0]).toMatchObject({
        kind: 'tui',
        capabilities: ['chat', 'notify', 'open.view', 'render.markdown'],
      })
      expect(core.seen).toContain('POST /rpc/presence/clients/register')
    },
    TEST_TIMEOUT,
  )
})
