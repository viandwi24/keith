import { mkdir } from 'node:fs/promises'
import { type JoinRequest, JoinResponseSchema } from '@keith/contracts'
import { checkCoreUrl } from './core-url.ts'
import { prepareDrivers } from './drivers.ts'
import { buildManifest, defaultNodeName } from './manifest.ts'
import {
  type DriverEntry,
  defaultWorkdir,
  loadConfig,
  type NodeConfig,
  saveConfig,
} from './platform/config.ts'

export interface JoinOptions {
  core: string
  code: string
  name?: string
  allowShell?: boolean
  workdir?: string
  configPath: string
  /** Accept plain http to a host that is not loopback or Tailscale. */
  insecure?: boolean
  /** Called with the warning when `insecure` let a risky URL through. */
  warn?: (message: string) => void
  fetch?: typeof fetch
}

/** Exchange a pairing code for credentials and save them. Returns the saved config. */
export async function joinNode(options: JoinOptions): Promise<NodeConfig> {
  const core = options.core.replace(/\/+$/, '')
  const checked = checkCoreUrl(core, options.insecure === true)
  if (!checked.ok) throw new Error(checked.error)
  if (checked.warning !== undefined) options.warn?.(checked.warning)
  const allowShell = options.allowShell ?? false
  const workdir = options.workdir ?? defaultWorkdir()
  const name = options.name ?? defaultNodeName()
  // The drivers already installed here are announced when they load and start; the rest are logged and left out.
  const installed = await installedDrivers(options.configPath)
  const prepared = await prepareDrivers(installed, {
    workdir,
    logger: { info() {}, warn: (m) => options.warn?.(m), error: (m) => options.warn?.(m) },
  })
  const body: JoinRequest = {
    code: options.code,
    manifest: buildManifest(name, { allowShell }, prepared.announced),
  }

  const res = await (options.fetch ?? fetch)(`${core}/nodes/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`join failed (${res.status}): ${text.slice(0, 300)}`)
  }
  const reply = JoinResponseSchema.parse(await res.json())

  await mkdir(workdir, { recursive: true })
  const config: NodeConfig = {
    core,
    nodeId: reply.nodeId,
    token: reply.token,
    name,
    policy: { allowShell, workdir },
    // a re-join keeps the drivers installed on this node
    drivers: installed,
  }
  await saveConfig(options.configPath, config)
  return config
}

/** Drivers of the config already at `path` (none when there is no readable config). */
async function installedDrivers(path: string): Promise<DriverEntry[]> {
  try {
    return (await loadConfig(path)).drivers
  } catch {
    return []
  }
}
