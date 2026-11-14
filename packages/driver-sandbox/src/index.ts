// First-party `sandbox` driver (docs/specs/node-drivers.md, "Driver sandbox"): the entry `keith-driver.json` names.
// Built to dist/index.js; the node imports it through loadDriver. Importing this module runs no runtime program.
import { createSandboxDriver } from './driver.ts'
import { spawnRuntime } from './process.ts'

export {
  CONTAINER_USER,
  containerName,
  killArgv,
  runArgv,
  WORK_DIR,
} from './argv.ts'
export {
  createSandboxDriver,
  DRIVER_NAME,
  DRIVER_VERSION,
  SANDBOX_CAPABILITIES,
  type SandboxDeps,
} from './driver.ts'
export { DEFAULT_IMAGES, IMAGE_LANGUAGES, type ImageLanguage, LANGUAGE_COMMAND } from './images.ts'
export {
  DEFAULT_TIMEOUT_MS,
  type Parsed,
  parseRunInput,
  parseSandboxOptions,
  type RunRequest,
  type SandboxOptions,
} from './options.ts'
export { OUTPUT_CAP, OutputCollector } from './output.ts'
export { type RuntimeProcess, type SpawnFn, type SpawnOptions, spawnRuntime } from './process.ts'
export {
  type Choice,
  chooseRuntime,
  INSTALL_HINT,
  pullArgv,
  RUNTIMES,
  type RuntimeName,
  type WhichFn,
} from './runtime.ts'
export { resolveSandboxSetup, type SandboxSetup, type SetupOption } from './setup.ts'

export default createSandboxDriver({
  spawn: spawnRuntime,
  which: (name) => Bun.which(name) ?? undefined,
})
