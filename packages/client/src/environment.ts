// The environment of this client (docs/decisions/0033 §2, docs/specs/client.md "Client environment"): the host name, OS,
// architecture, device kind, time zone and locale of the machine the terminal runs on. Detection is best effort. A probe
// that fails leaves its field out, `device` is `unknown` when no probe can tell, and nothing here throws. The probes are
// injectable so the rules can be tested without a real machine.
import { readdirSync, readFileSync } from 'node:fs'
import { arch as osArch, hostname as osHostname, release as osRelease } from 'node:os'
import {
  type ClientDevice,
  type ClientEnvironment,
  ClientEnvironmentSchema,
  type ClientOs,
} from '@keith/contracts'

/** What detection reads from the machine. Each probe may fail (return undefined or throw); the default ones never do. */
export interface EnvironmentProbes {
  hostname(): string
  platform(): string
  /** The kernel release (`os.release()`): the OS version of Linux and Windows, and the Darwin release on macOS. */
  release(): string
  arch(): string
  /** `sw_vers -productVersion` on macOS: the marketing version (`15.2`), not the Darwin release. */
  macosVersion(): Promise<string | undefined>
  /** `pmset -g batt` on macOS: it names `InternalBattery` on a laptop. */
  batteryReport(): Promise<string | undefined>
  /** `scutil --get LocalHostName` on macOS: the Bonjour name (`ana-laptop`), set even when DHCP gives no host name. */
  localHostName(): Promise<string | undefined>
  /** `scutil --get ComputerName` on macOS: the computer name of the Sharing settings. */
  computerName(): Promise<string | undefined>
  /** The content of `/etc/hostname` on Linux. */
  etcHostname(): string | undefined
  /** The entries of `/sys/class/power_supply` on Linux; a laptop has `BAT0` (or `BAT1`). */
  powerSupplies(): string[] | undefined
  timeZone(): string | undefined
  locale(): string | undefined
}

const OS_OF: Record<string, ClientOs> = { darwin: 'macos', linux: 'linux', win32: 'windows' }

/** The OS of a `process.platform` value; anything else is `other`. */
export const osOf = (platform: string): ClientOs => OS_OF[platform] ?? 'other'

/** The host name shown when no probe gives a usable name. */
export const FALLBACK_HOST = 'this computer'

/**
 * The host name as the core keeps it: trimmed, a trailing `.local` dropped, at most 60 characters. Undefined when the name
 * is not usable: empty, `localhost`, or an IP address (IPv4 or IPv6). DHCP can leave `os.hostname()` as an address, and no
 * address may reach the client context (docs/specs/client.md "Client environment").
 */
export const hostOf = (raw: string | undefined): string | undefined => {
  const name = (raw ?? '')
    .trim()
    .replace(/\.local$/i, '')
    .trim()
    .slice(0, 60)
  if (name === '' || name.toLowerCase() === 'localhost') return undefined
  if (name.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return undefined
  return name
}

/**
 * The host name of this machine. `os.hostname()` first; when it is not usable, macOS asks `scutil` for the LocalHostName and
 * then the ComputerName, and Linux reads `/etc/hostname`. Otherwise it is `this computer`. Never throws.
 */
export async function hostNameOf(os: ClientOs, probes: EnvironmentProbes): Promise<string> {
  const own = hostOf(attemptSync(() => probes.hostname()))
  if (own !== undefined) return own
  if (os === 'macos') {
    const local = hostOf(await attempt(() => probes.localHostName()))
    if (local !== undefined) return local
    const computer = hostOf(await attempt(() => probes.computerName()))
    if (computer !== undefined) return computer
  }
  if (os === 'linux') {
    const etc = hostOf(attemptSync(() => probes.etcHostname()))
    if (etc !== undefined) return etc
  }
  return FALLBACK_HOST
}

/**
 * The kind of machine. A MacBook has an internal battery; a Linux laptop has a `BAT*` power supply. A Mac or Linux machine
 * without one is a desktop. Windows and anything else is `unknown`, and so is a probe that failed (a phone is never guessed).
 */
export async function deviceOf(os: ClientOs, probes: EnvironmentProbes): Promise<ClientDevice> {
  if (os === 'macos') {
    const report = await attempt(() => probes.batteryReport())
    if (report === undefined) return 'unknown'
    return report.includes('InternalBattery') ? 'laptop' : 'desktop'
  }
  if (os === 'linux') {
    const names = attemptSync(() => probes.powerSupplies())
    if (names === undefined) return 'unknown'
    return names.some((name) => /^BAT\d*$/.test(name)) ? 'laptop' : 'desktop'
  }
  return 'unknown'
}

/** Reads the environment of this machine, or undefined when the time zone (required) cannot be read. Never throws. */
export async function detectEnvironment(
  probes: EnvironmentProbes = defaultProbes,
): Promise<ClientEnvironment | undefined> {
  try {
    const os = osOf(probes.platform())
    const host = await hostNameOf(os, probes)
    const osVersion = clip(
      (os === 'macos' ? await attempt(() => probes.macosVersion()) : undefined) ?? probes.release(),
      40,
    )
    const arch = clip(probes.arch(), 20)
    const locale = attemptSync(() => probes.locale())
    const checked = ClientEnvironmentSchema.safeParse({
      host,
      os,
      ...(osVersion === undefined ? {} : { osVersion }),
      ...(arch === undefined ? {} : { arch }),
      device: await deviceOf(os, probes),
      timezone: attemptSync(() => probes.timeZone()),
      ...(locale === undefined ? {} : { locale: clip(locale, 20) }),
    })
    return checked.success ? checked.data : undefined
  } catch {
    return undefined
  }
}

const clip = (text: string | undefined, max: number): string | undefined => {
  const cut = text?.trim().slice(0, max)
  return cut === undefined || cut === '' ? undefined : cut
}

async function attempt<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
  try {
    return await read()
  } catch {
    return undefined
  }
}

function attemptSync<T>(read: () => T | undefined): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

/** Runs a command and returns its standard output, or undefined when it cannot run or does not finish in 2 seconds. */
async function run(command: string[]): Promise<string | undefined> {
  if (typeof Bun === 'undefined') return undefined
  try {
    const proc = Bun.spawn(command, { stdout: 'pipe', stderr: 'ignore' })
    const timer = setTimeout(() => proc.kill(), 2_000)
    try {
      const out = await new Response(proc.stdout).text()
      await proc.exited
      return out
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return undefined
  }
}

/** The probes of the running machine. */
export const defaultProbes: EnvironmentProbes = {
  hostname: () => osHostname(),
  platform: () => process.platform,
  release: () => osRelease(),
  arch: () => osArch(),
  macosVersion: () => run(['sw_vers', '-productVersion']),
  batteryReport: () => run(['pmset', '-g', 'batt']),
  localHostName: () => run(['scutil', '--get', 'LocalHostName']),
  computerName: () => run(['scutil', '--get', 'ComputerName']),
  etcHostname: () => readFileSync('/etc/hostname', 'utf8'),
  powerSupplies: () => readdirSync('/sys/class/power_supply'),
  timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  locale: () => Intl.DateTimeFormat().resolvedOptions().locale,
}
