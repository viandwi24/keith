import { hostname } from 'node:os'
import { CAPABILITIES, type DriverAnnouncement, type NodeManifestV2 } from '@keith/contracts'
import { BUILTIN_DRIVERS } from './drivers.ts'

export const NODE_VERSION = '0.1.0'

/** A slug the core accepts, derived from the host name. */
export function defaultNodeName(): string {
  const slug = hostname()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '')
  return slug.length > 0 ? slug : 'node'
}

/** The built-in drivers are always announced; `shell.exec` is refused at call time when the policy is off. */
function builtinDrivers(): DriverAnnouncement[] {
  return [
    {
      name: BUILTIN_DRIVERS[0],
      version: NODE_VERSION,
      capabilities: [{ id: 'system.info', schemaVersion: CAPABILITIES['system.info'].version }],
    },
    {
      name: BUILTIN_DRIVERS[1],
      version: NODE_VERSION,
      capabilities: [{ id: 'shell.exec', schemaVersion: CAPABILITIES['shell.exec'].version }],
    },
  ]
}

/**
 * The manifest a node announces (protocol 3, manifest v2): the built-in drivers plus the installed drivers that loaded
 * (`prepareDrivers` decides which). `policy` is what the node allows; the core decides approval.
 */
export function buildManifest(
  name: string,
  policy: { allowShell: boolean },
  drivers: readonly DriverAnnouncement[] = [],
): NodeManifestV2 {
  return {
    manifestVersion: 2,
    name,
    os: process.platform,
    arch: process.arch,
    version: NODE_VERSION,
    policy: { allowShell: policy.allowShell },
    drivers: [...builtinDrivers(), ...drivers],
  }
}
