import { arch, cpus, freemem, hostname, release, totalmem, type, uptime } from 'node:os'
import { CAPABILITIES } from '@keith/contracts'
import type { DriverDefinition } from '@keith/driver-sdk'
import { NODE_VERSION } from '../manifest.ts'

export interface DiskUsage {
  totalKb: number
  usedKb: number
  availKb: number
}

export interface SystemInfo {
  os: string
  platform: string
  release: string
  arch: string
  hostname: string
  cpus: { count: number; model: string }
  memory: { totalBytes: number; freeBytes: number }
  uptimeSeconds: number
  disk: DiskUsage | null
}

/** Parse `df -k <path>` output; null when the shape is not recognised. */
export function parseDf(output: string): DiskUsage | null {
  const lines = output.trim().split('\n')
  if (lines.length < 2) return null
  // A long filesystem name can wrap the row onto a second line.
  const tokens = lines.slice(1).join(' ').trim().split(/\s+/)
  const [total, used, avail] = [tokens[1], tokens[2], tokens[3]].map(Number)
  if (total === undefined || used === undefined || avail === undefined) return null
  if ([total, used, avail].some((n) => !Number.isFinite(n))) return null
  return { totalKb: total, usedKb: used, availKb: avail }
}

async function diskUsage(path: string): Promise<DiskUsage | null> {
  try {
    const proc = Bun.spawn(['df', '-k', path], { stdout: 'pipe', stderr: 'ignore' })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    return parseDf(text)
  } catch {
    return null
  }
}

export async function systemInfo(workdir: string): Promise<SystemInfo> {
  const cpuList = cpus()
  return {
    os: type(),
    platform: process.platform,
    release: release(),
    arch: arch(),
    hostname: hostname(),
    cpus: { count: cpuList.length, model: cpuList[0]?.model ?? 'unknown' },
    memory: { totalBytes: totalmem(), freeBytes: freemem() },
    uptimeSeconds: Math.round(uptime()),
    disk: await diskUsage(workdir),
  }
}

/** The built-in driver `system` (`system.info`): not subject to `allowShell`. */
export const systemDriver: DriverDefinition = {
  name: 'system',
  version: NODE_VERSION,
  capabilities: [{ id: 'system.info', schemaVersion: CAPABILITIES['system.info'].version }],
  async invoke(_call, ctx) {
    return { ok: true, output: await systemInfo(ctx.workdir) }
  },
}
