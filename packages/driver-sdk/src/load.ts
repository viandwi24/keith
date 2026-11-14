// `loadDriver(folder)`: reads and checks a driver folder before the node imports its entry.
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type DriverDefinition, driverProblems } from './define.ts'
import { DRIVER_MANIFEST_FILE, type DriverManifest, DriverManifestSchema } from './manifest.ts'

export type DriverLoadErrorCode =
  | 'manifest-missing'
  | 'manifest-invalid'
  | 'platform-unsupported'
  | 'entry-missing'
  | 'entry-invalid'
  | 'entry-mismatch'

/** Why a driver folder cannot be loaded. The node logs it and leaves the driver out. */
export class DriverLoadError extends Error {
  readonly code: DriverLoadErrorCode

  constructor(code: DriverLoadErrorCode, message: string) {
    super(message)
    this.name = 'DriverLoadError'
    this.code = code
  }
}

/** A driver folder whose manifest and entry path are checked; its entry is not imported. */
export interface DriverFolder {
  readonly manifest: DriverManifest
  /** Absolute path of the driver folder. */
  readonly dir: string
  /** Absolute path of the entry module. */
  readonly entry: string
}

export interface LoadedDriver extends DriverFolder {
  readonly driver: DriverDefinition
}

export interface LoadDriverOptions {
  /** The platform to check `platforms` against; defaults to `process.platform`. */
  readonly platform?: string
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Validates `keith-driver.json` in `dir`, checks the platform and that the entry file exists inside
 * the folder. Nothing of the driver runs: the entry is not imported. Throws `DriverLoadError`.
 */
export async function readDriverManifest(
  dir: string,
  options: LoadDriverOptions = {},
): Promise<DriverFolder> {
  const root = resolve(dir)
  const manifestFile = Bun.file(resolve(root, DRIVER_MANIFEST_FILE))
  if (!(await manifestFile.exists())) {
    throw new DriverLoadError('manifest-missing', `no ${DRIVER_MANIFEST_FILE} in ${root}`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(await manifestFile.text())
  } catch (error) {
    throw new DriverLoadError(
      'manifest-invalid',
      `${DRIVER_MANIFEST_FILE} is not JSON: ${errorMessage(error)}`,
    )
  }
  const parsed = DriverManifestSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.map(String).join('.') || '(root)'
      return `${path} ${issue.message}`
    })
    throw new DriverLoadError('manifest-invalid', `${DRIVER_MANIFEST_FILE}: ${issues.join('; ')}`)
  }
  const manifest = parsed.data

  const platform = options.platform ?? process.platform
  if (!manifest.platforms.some((supported) => supported === platform)) {
    throw new DriverLoadError(
      'platform-unsupported',
      `${manifest.name} runs on ${manifest.platforms.join(', ')}, not on ${platform}`,
    )
  }

  const entry = resolve(root, manifest.entry)
  const inside = relative(root, entry)
  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new DriverLoadError('entry-invalid', `entry ${manifest.entry} is outside ${root}`)
  }
  if (!(await Bun.file(entry).exists())) {
    throw new DriverLoadError('entry-missing', `entry ${manifest.entry} not found in ${root}`)
  }
  return { manifest, dir: root, entry }
}

/**
 * `readDriverManifest`, then imports the entry and checks that the entry's driver matches the
 * manifest (name, version, capabilities). Importing runs the driver's code: call it only when the
 * owner has agreed to run the driver. Throws `DriverLoadError`.
 */
export async function loadDriver(
  dir: string,
  options: LoadDriverOptions = {},
): Promise<LoadedDriver> {
  const { manifest, dir: root, entry } = await readDriverManifest(dir, options)

  let loaded: Record<string, unknown>
  try {
    loaded = (await import(pathToFileURL(entry).href)) as Record<string, unknown>
  } catch (error) {
    throw new DriverLoadError(
      'entry-invalid',
      `entry ${manifest.entry} failed to import: ${errorMessage(error)}`,
    )
  }
  const problems = driverProblems(loaded.default)
  if (problems.length > 0) {
    throw new DriverLoadError('entry-invalid', `entry ${manifest.entry}: ${problems.join('; ')}`)
  }
  const driver = loaded.default as DriverDefinition

  const declared = manifest.capabilities.map((c) => `${c.id}@${c.schemaVersion}`).sort()
  const exported = driver.capabilities.map((c) => `${c.id}@${c.schemaVersion}`).sort()
  const same =
    driver.name === manifest.name &&
    driver.version === manifest.version &&
    declared.length === exported.length &&
    declared.every((item, index) => item === exported[index])
  if (!same) {
    throw new DriverLoadError(
      'entry-mismatch',
      `the entry's driver (${driver.name} ${driver.version}, ${exported.join(', ')}) does not match ${DRIVER_MANIFEST_FILE} (${manifest.name} ${manifest.version}, ${declared.join(', ')})`,
    )
  }
  return { manifest, driver, dir: root, entry }
}
