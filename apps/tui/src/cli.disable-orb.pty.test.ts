import { afterEach, describe, expect, test } from 'bun:test'
import { homeSize } from './features/home/home-state.ts'
import { createFakeAdmin } from './testing/fake-admin.ts'
import { launch, stopPty } from './testing/pty.ts'

const ptySupported = process.platform !== 'win32'

/** Above bun's 5 s default: starting the CLI is slow on emulated CI machines. */
const TEST_TIMEOUT = 90_000
const COLUMNS = 200
const ROWS = 40
const CELL_ASPECT = 0.5

afterEach(stopPty)

/** The orb's cells of a screen (Home): the rows and columns `homeSize` gives it at this terminal. */
function orbCells(screen: string): string {
  const size = homeSize(COLUMNS, ROWS, CELL_ASPECT)
  return screen
    .split('\n')
    .slice(size.orbTop, size.orbTop + size.orbHeight)
    .map((line) => [...line].slice(size.orbLeft, size.orbLeft + size.orbWidth).join(''))
    .join('\n')
}

describe.skipIf(!ptySupported)('keith --disable-orb in a real pseudo-terminal', () => {
  test(
    'the Home orb is one fixed picture: its cells are the same at two times',
    async () => {
      const { cli: app } = await launch(
        { rpc: createFakeAdmin().rpc },
        ['K E I T H', '[enter] chat'],
        COLUMNS,
        // colour on (the orb has its state colour), the cell aspect fixed so the orb box is known
        { NO_COLOR: undefined, COLORTERM: 'truecolor', KEITH_CELL_ASPECT: String(CELL_ASPECT) },
        ['--disable-orb'],
        ROWS,
      )
      // the picture may still be painting when the Home text appears: take it once two reads 150 ms apart agree
      let first = orbCells(app.screen())
      for (let i = 0; i < 20; i++) {
        await Bun.sleep(150)
        const next = orbCells(app.screen())
        const settled = next === first
        first = next
        if (settled && /[⠁-⣿]/.test(first)) break
      }
      expect(first).toMatch(/[⠁-⣿]/)
      await Bun.sleep(800)
      expect(orbCells(app.screen())).toBe(first)

      app.proc.terminal?.write('\u0003')
      expect(await app.proc.exited).toBe(0)
    },
    TEST_TIMEOUT,
  )
})
