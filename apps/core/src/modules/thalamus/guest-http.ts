import { hostname as osHostname } from 'node:os'
import type { GuestSettings } from '@keith/contracts'
import type { Server } from 'bun'
import { createRequestGuard, isForwarded } from './guard.ts'
import { createGuestApp, type GuestAppOptions } from './guest-app.ts'

/** Where the guest listener should be right now (docs/specs/guests.md, "Guest HTTP"). */
export interface GuestListenPlan {
  /** Guests are on and not killed: there is a listener. Otherwise there is none (the port is closed). */
  enabled: boolean
  port: number
  /** `127.0.0.1` when only the loopback zone is allowed, else every interface (the zone check is on the peer). */
  hostname: '127.0.0.1' | '0.0.0.0'
}

export interface GuestHttp {
  /** The listener's `fetch`: Host and Origin first, then the guest app. Nothing of the owner API is behind it. */
  fetch(
    request: Request,
    server?: Pick<Server<unknown>, 'requestIP' | 'timeout' | 'port'>,
  ): Promise<Response>
  plan(): GuestListenPlan
}

export interface GuestHttpOptions extends GuestAppOptions {
  /** Host of the public URL (it is a name the listener serves too). */
  publicUrl: () => string | undefined
  /** The names of this machine (default: its hostname and `<hostname>.local`). Tests inject their own. */
  ownNames?: () => readonly string[]
}

/** The machine's own names a visitor may type besides its IP addresses: `mac`, `mac.local`. */
export function machineNames(): string[] {
  const name = osHostname().toLowerCase()
  if (name === '') return []
  const short = name.split('.')[0] ?? name
  return [...new Set([name, short, `${short}.local`])]
}

export function createGuestHttp(options: GuestHttpOptions): GuestHttp {
  const app = createGuestApp(options)
  const own = options.ownNames ?? machineNames
  // Host values of a LAN visitor: a literal address (it cannot be DNS-rebound) with the guest port, the machine's own
  // names, the owner's `guests.hosts` and the public URL host. Anything else is `421`, for this listener only.
  const guard = createRequestGuard({
    publicUrl: options.publicUrl,
    extraHosts: () => [...options.settings.get().hosts.map((h) => h.toLowerCase()), ...own()],
    literalIps: true,
  })
  return {
    async fetch(request, server) {
      const refused = guard.check(request, server?.port)
      if (refused !== undefined) return refused
      const ip = server?.requestIP(request)?.address
      return app.fetch(request, {
        forwarded: isForwarded(request.headers),
        ...(ip === undefined ? {} : { ip }),
        ...(server === undefined ? {} : { keepAlive: () => server.timeout(request, 0) }),
      })
    },
    plan() {
      const settings: GuestSettings = options.settings.get()
      const loopbackOnly = settings.zones.every((z) => z === 'loopback')
      return {
        enabled: settings.enabled && !options.settings.killed(),
        port: settings.port,
        hostname: loopbackOnly ? '127.0.0.1' : '0.0.0.0',
      }
    },
  }
}
