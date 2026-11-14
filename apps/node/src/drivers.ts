// The drivers installed on this node: where each lives, whether its files still match the hash taken at `driver add`,
// and whether it loads (docs/specs/node-drivers.md, "Driver package" and "Announcement and executor").
import { join, resolve } from 'node:path'
import {
  CAPABILITIES,
  type DriverAnnouncement,
  MANIFEST_CAPABILITIES_MAX,
  MANIFEST_DRIVERS_MAX,
} from '@keith/contracts'
import {
  DRIVER_MANIFEST_FILE,
  type DriverCapability,
  type DriverContext,
  type DriverDefinition,
  type DriverLogger,
  type LoadedDriver,
  loadDriver,
} from '@keith/driver-sdk'
import { type DriverEntry, verifyDriverFingerprint } from './platform/config.ts'
import type { Logger } from './platform/logger.ts'

/** Drivers the node provides itself; always announced, and a config entry may not take their names. */
export const BUILTIN_DRIVERS = ['system', 'shell'] as const
/** Drivers shipped in this checkout (`packages/driver-<name>`), addable by name with `driver add`. */
export const BUNDLED_DRIVERS = ['desktop', 'sandbox'] as const
/** The `packages/` folder of this checkout, found from `apps/node/src`. */
export const CHECKOUT_PACKAGES = resolve(import.meta.dir, '..', '..', '..', 'packages')

export interface DriverSources {
  /** Where bundled drivers live; the checkout's `packages/` by default (tests point it at fixtures). */
  readonly packagesRoot?: string
}

export function bundledDir(name: string, packagesRoot = CHECKOUT_PACKAGES): string {
  return join(packagesRoot, `driver-${name}`)
}

const readJson = (file: string): Promise<unknown> =>
  Bun.file(file)
    .json()
    .catch(() => undefined)

/**
 * A bundled driver ships its source; its entry is built by the driver's own `build` script (`bun run build` in its
 * folder, through Bun.spawn with an argument array). Without `force` the build runs only when the entry is missing (list);
 * with `force` it always runs, so `driver add` installs what the checkout holds, never a stale dist.
 * Resolves to the reason it could not be built, or undefined when the entry exists afterwards (or the folder is not there:
 * the caller reports that).
 */
export async function ensureBundledBuilt(
  name: string,
  sources: DriverSources = {},
  options: { force?: boolean } = {},
): Promise<string | undefined> {
  const dir = bundledDir(name, sources.packagesRoot)
  const manifest = (await readJson(join(dir, DRIVER_MANIFEST_FILE))) as
    | { entry?: unknown }
    | undefined
  if (typeof manifest?.entry !== 'string') return undefined
  const entry = join(dir, manifest.entry)
  if (!options.force && (await Bun.file(entry).exists())) return undefined
  const pkg = (await readJson(join(dir, 'package.json'))) as
    | { scripts?: { build?: unknown } }
    | undefined
  if (typeof pkg?.scripts?.build !== 'string') {
    return (await Bun.file(entry).exists())
      ? undefined
      : `${name} has no build script, so ${manifest.entry} cannot be made`
  }
  const proc = Bun.spawn([process.execPath, 'run', 'build'], {
    cwd: dir,
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) {
    const tail = stderr.trim().split('\n').slice(-3).join(' ')
    return `building ${name} failed (bun run build): ${tail}`
  }
  return (await Bun.file(entry).exists())
    ? undefined
    : `building ${name} did not write ${manifest.entry}`
}

/** The folder of an installed driver. */
export function driverDir(entry: DriverEntry, sources: DriverSources = {}): string {
  return entry.source === 'bundled'
    ? bundledDir(entry.name, sources.packagesRoot)
    : (entry.path ?? '')
}

export type DriverState =
  | { readonly entry: DriverEntry; readonly ok: true; readonly driver: LoadedDriver }
  | { readonly entry: DriverEntry; readonly ok: false; readonly message: string }

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Checks one installed driver: the hash first (a changed driver is never imported), then the manifest, the platform and
 * the entry. Never throws; a failure is the state's message.
 */
export async function inspectDriver(
  entry: DriverEntry,
  sources: DriverSources = {},
): Promise<DriverState> {
  const dir = driverDir(entry, sources)
  const fail = (error: unknown): DriverState => ({ entry, ok: false, message: errorText(error) })
  try {
    await verifyDriverFingerprint(entry, dir)
  } catch (error) {
    return fail(error)
  }
  try {
    const driver = await loadDriver(dir)
    if (driver.manifest.name !== entry.name) {
      return fail(`the folder holds ${driver.manifest.name}, not ${entry.name}`)
    }
    return { entry, ok: true, driver }
  } catch (error) {
    return fail(error)
  }
}

/**
 * Every installed driver's state, in config order. A name that is a built-in, or that repeats an earlier entry, fails
 * with its reason; the rest are unaffected.
 */
export async function loadInstalledDrivers(
  entries: readonly DriverEntry[],
  sources: DriverSources = {},
): Promise<DriverState[]> {
  const seen = new Set<string>(BUILTIN_DRIVERS)
  const states: DriverState[] = []
  for (const entry of entries) {
    if (BUILTIN_DRIVERS.some((name) => name === entry.name)) {
      states.push({ entry, ok: false, message: `${entry.name} is a built-in driver name` })
      continue
    }
    if (seen.has(entry.name)) {
      states.push({ entry, ok: false, message: `${entry.name} is listed twice in the config` })
      continue
    }
    seen.add(entry.name)
    states.push(await inspectDriver(entry, sources))
  }
  return states
}

export interface PrepareOptions extends DriverSources {
  /** The node's work folder, given to each driver's `start`. */
  readonly workdir: string
  readonly logger: Logger
  /** Given to each driver's `start`; a fresh signal when absent. */
  readonly signal?: AbortSignal
}

/** A driver that announced and started: what the executor calls for its capabilities. */
export interface RunnableDriver {
  readonly driver: DriverDefinition
  /** The driver's options from the config (`driver add`). */
  readonly options: Readonly<Record<string, unknown>>
  readonly logger: DriverLogger
}

export interface PreparedDrivers {
  /** What the manifest announces: the drivers that loaded and started, within the manifest limits. */
  readonly announced: DriverAnnouncement[]
  /** The same drivers, as the executor calls them (in announcement order). */
  readonly runnable: RunnableDriver[]
  /** Drivers left out, each with its reason (also logged). */
  readonly left: readonly { readonly name: string; readonly message: string }[]
}

function driverLogger(name: string, logger: Logger): DriverLogger {
  return {
    info: (message) => logger.info(`driver ${name}: ${message}`),
    warn: (message) => logger.warn(`driver ${name}: ${message}`),
    error: (message) => logger.error(`driver ${name}: ${message}`),
  }
}

/**
 * Loads and starts the installed drivers and returns what to announce. A driver that fails to load (changed files, bad
 * manifest, platform) or throws in `start` is logged and left out; the node still runs. The built-in drivers take part
 * of the manifest limits, so the announced set never makes the manifest invalid.
 */
export async function prepareDrivers(
  entries: readonly DriverEntry[],
  options: PrepareOptions,
): Promise<PreparedDrivers> {
  const signal = options.signal ?? new AbortController().signal
  const states = await loadInstalledDrivers(entries, options)
  const driverRoom = MANIFEST_DRIVERS_MAX - BUILTIN_DRIVERS.length
  const capabilityRoom = MANIFEST_CAPABILITIES_MAX - Object.keys(CAPABILITIES).length
  const announced: DriverAnnouncement[] = []
  const runnable: RunnableDriver[] = []
  const left: { name: string; message: string }[] = []
  let capabilities = 0
  for (const state of states) {
    const name = state.entry.name
    if (!state.ok) {
      left.push({ name, message: state.message })
      continue
    }
    const { driver, manifest } = state.driver
    const offered = state.driver.driver.offered?.(state.entry.options) ?? manifest.capabilities
    const announcedCaps = manifest.capabilities.filter((cap) =>
      offered.some((item: DriverCapability) => item.id === cap.id),
    )
    if (announcedCaps.length === 0) {
      left.push({ name, message: 'offers no capability with these options' })
      continue
    }
    try {
      await state.driver.driver.start?.({
        logger: driverLogger(name, options.logger),
        workdir: options.workdir,
        options: state.entry.options,
        signal,
        progress: () => {},
      } satisfies DriverContext)
    } catch (error) {
      left.push({ name, message: `start failed: ${errorText(error)}` })
      continue
    }
    if (announced.length >= driverRoom || capabilities + announcedCaps.length > capabilityRoom) {
      left.push({ name, message: 'over the manifest limit (16 drivers, 64 capabilities)' })
      continue
    }
    capabilities += announcedCaps.length
    runnable.push({
      driver: state.driver.driver,
      options: state.entry.options,
      logger: driverLogger(name, options.logger),
    })
    announced.push({
      name,
      version: driver.version,
      capabilities: announcedCaps.map((c) => ({
        id: c.id,
        schemaVersion: c.schemaVersion,
      })),
      ...(Object.keys(state.entry.options).length > 0 ? { options: state.entry.options } : {}),
    })
  }
  for (const item of left) options.logger.warn(`driver ${item.name} left out: ${item.message}`)
  return { announced, runnable, left }
}
