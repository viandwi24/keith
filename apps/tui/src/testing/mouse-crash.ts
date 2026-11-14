// A throwaway entry for the PTY test: turn mouse reporting on the way `cli.tsx` does, then fail.
import { createMouse } from '../platform/terminal-input.ts'

const mouse = createMouse((text) => process.stdout.write(text), { hookProcess: true })
mouse.set(true)
await Bun.sleep(100)
throw new Error('boom')
