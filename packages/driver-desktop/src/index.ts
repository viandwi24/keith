// First-party `desktop` driver (docs/specs/node-drivers.md, "Driver desktop"): the entry `keith-driver.json` names.
// Built to dist/index.js; the node imports it through loadDriver. Importing this module touches no OS.
// The owner's `driver add desktop --option backend=fake` picks the fake backend (no screen, no OS calls): the
// smoke test and manual runs use it; any other value, or no option, uses the macOS backend.
import { defineDriver } from '@keith/driver-sdk'
import { createDesktopDriver, DESKTOP_CAPABILITIES, DRIVER_NAME, DRIVER_VERSION } from './driver.ts'
import { createMacosBackend } from './macos-backend.ts'
import { fakeBackend } from './testing/fake-backend.ts'

export type { DesktopBackend, DesktopInfo, DisplayInfo, Screenshot } from './backend.ts'
export { MissingPermissionError } from './backend.ts'
export {
  createDesktopDriver,
  DESKTOP_CAPABILITIES,
  type DesktopDeps,
  type DesktopOptions,
  DRIVER_NAME,
  DRIVER_VERSION,
  parseOptions,
} from './driver.ts'
export { createMacosBackend, type ProcessRunner, runProcess } from './macos-backend.ts'

const macos = createDesktopDriver({ backend: createMacosBackend() })
const fake = createDesktopDriver({ backend: fakeBackend() })

/** The driver instance for the node's `backend` option (read from the options the node hands each call). */
const pick = (options: Readonly<Record<string, unknown>>) =>
  options.backend === 'fake' ? fake : macos

export default defineDriver({
  name: DRIVER_NAME,
  version: DRIVER_VERSION,
  capabilities: DESKTOP_CAPABILITIES,
  offered: (options) => macos.offered(options),
  start: (ctx) => pick(ctx.options).start?.(ctx),
  invoke: (call, ctx) => pick(ctx.options).invoke(call, ctx),
})
