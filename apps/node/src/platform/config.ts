import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DriverOptionsSchema } from '@keith/contracts'
import { DRIVER_MANIFEST_FILE } from '@keith/driver-sdk'
import { z } from 'zod'

/** Message a node logs and stores for a driver whose files changed after `driver add`. */
export const DRIVER_CHANGED_MESSAGE =
  'driver changed since it was added: run keith-node driver add again'

/**
 * One driver installed with `keith-node driver add` (docs/specs/node-drivers.md, "Node config").
 * `path` is the folder of a `path` driver; a `bundled` driver is found by its name in the checkout.
 */
export const DriverEntrySchema = z
  .object({
    name: z
      .string()
      .max(32)
      .regex(/^[a-z][a-z0-9]*$/),
    source: z.enum(['bundled', 'path']),
    path: z.string().min(1).max(4096).optional(),
    /** sha256 of `keith-driver.json` and the entry module, taken at install time. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** Public facts only (`allowInput`, `network`, `runtime`); never a secret. The same bounds as the manifest. */
    options: DriverOptionsSchema.default({}),
  })
  .refine((d) => d.source === 'bundled' || (d.path !== undefined && isAbsolute(d.path)), {
    message: 'a path driver needs an absolute path',
  })
  .refine((d) => d.source === 'path' || d.path === undefined, {
    message: 'a bundled driver has no path',
  })
export type DriverEntry = z.infer<typeof DriverEntrySchema>

/** `~/.keith/node.json`: written by `join`, read by `run` and `status`. */
export const NodeConfigSchema = z.object({
  core: z.string().url(),
  nodeId: z.string(),
  token: z.string(),
  name: z.string(),
  policy: z.object({
    allowShell: z.boolean().default(false),
    workdir: z.string(),
  }),
  /** Drivers installed on this node. A config written before drivers existed has none. */
  drivers: z.array(DriverEntrySchema).max(16).default([]),
})
export type NodeConfig = z.infer<typeof NodeConfigSchema>

/** The entry path a manifest names, when it stays inside the driver folder. */
function entryOf(dir: string, manifest: Uint8Array): string | undefined {
  let entry: unknown
  try {
    entry = (JSON.parse(new TextDecoder().decode(manifest)) as { entry?: unknown }).entry
  } catch {
    return undefined
  }
  if (typeof entry !== 'string' || isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
    return undefined
  }
  const full = resolve(dir, entry)
  return relative(dir, full).startsWith('..') ? undefined : full
}

/**
 * sha256 over `keith-driver.json` and the entry module of a driver folder: the bytes the node
 * would run. Throws when the manifest is missing.
 */
export async function driverFingerprint(dir: string): Promise<string> {
  const manifest = await Bun.file(join(dir, DRIVER_MANIFEST_FILE)).bytes()
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(manifest)
  const entry = entryOf(dir, manifest)
  if (entry !== undefined && (await Bun.file(entry).exists())) {
    hasher.update(await Bun.file(entry).bytes())
  }
  return hasher.digest('hex')
}

/** Throws `DRIVER_CHANGED_MESSAGE` when the driver folder no longer matches the stored hash. */
export async function verifyDriverFingerprint(entry: DriverEntry, dir: string): Promise<void> {
  if ((await driverFingerprint(dir)) !== entry.sha256) throw new Error(DRIVER_CHANGED_MESSAGE)
}

/** `KEITH_HOME` as an absolute path; unset or empty means `undefined`. */
function keithHome(): string | undefined {
  const home = z.string().min(1).optional().catch(undefined).parse(process.env.KEITH_HOME)
  return home ? resolve(home) : undefined
}

/**
 * Config file location: `--config` flag, `KEITH_NODE_CONFIG`, `$KEITH_HOME/node.json`, then
 * `~/.keith/node.json`.
 */
export function resolveConfigPath(flag?: string): string {
  if (flag) return flag
  const fromEnv = process.env.KEITH_NODE_CONFIG
  if (fromEnv) return fromEnv
  const home = keithHome()
  return home ? join(home, 'node.json') : join(homedir(), '.keith', 'node.json')
}

/** `$KEITH_HOME/workspace` when `KEITH_HOME` is set, else `~/.keith/workspace`. */
export function defaultWorkdir(): string {
  const home = keithHome()
  return home ? join(home, 'workspace') : join(homedir(), '.keith', 'workspace')
}

/** Environment given to shell commands: nothing but PATH, HOME and LANG. */
export function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? homedir(),
  }
  env.LANG = process.env.LANG ?? 'C.UTF-8'
  return env
}

export async function loadConfig(path: string): Promise<NodeConfig> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new Error(`no node config at ${path}; run \`join\` first`)
  }
  const parsed = NodeConfigSchema.safeParse(await file.json())
  if (!parsed.success) throw new Error(`invalid node config at ${path}: ${parsed.error.message}`)
  return parsed.data
}

/**
 * Write the config with the directory at 0700 and the file at 0600. The write goes to a temp file
 * beside it, which is renamed over the old one, so a crash leaves either the old config or the new
 * one (a rotated token is never half written).
 */
export async function saveConfig(path: string, config: NodeConfig): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    await chmod(temp, 0o600)
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
