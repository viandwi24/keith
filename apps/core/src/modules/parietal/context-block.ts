// The "Where the person is now" block of the front agent's turn reminder (docs/decisions/0033 §5, docs/specs/prefrontal.md,
// "Front turn"). It is built from the person's own clients only: the host, OS, device, network and local time of the client
// in use. It is not a location: a host name says where a machine is named, not where the person sits. Every text it holds
// comes from a client, so it is cleaned and cut before it reaches the model.
import {
  type ClientKind,
  type ClientRecord,
  type PresenceWhere,
  stripControlText,
} from '@keith/contracts'
import type { ParietalService } from './service.ts'

/** The first line of the block (the block is at most six lines). */
export const CLIENT_CONTEXT_HEADING =
  'Where the person is now (facts their app reported; a host name is not a place, and this is not a location):'

const KIND_NAME: Record<ClientKind, string> = {
  tui: 'the terminal app',
  web: 'the web app',
  mobile: 'the mobile app',
}

/** The words of the `where` hint (ADR-0034 §5): what the facts suggest, never a place. `unknown` says nothing. */
export const WHERE_HINT: Record<PresenceWhere, string | undefined> = {
  desk: 'Hint: the person is probably at a computer (the app runs on this machine or its network); a guess, not a place.',
  mobile:
    'Hint: the person is probably on a phone or away from the local network; a guess, not a place.',
  out: 'Hint: the person said they are out, away from their desk; their own words, not a place.',
  unknown: undefined,
}

/** Text from a client, in a reminder: no control characters, no quotes or angle brackets, cut to `max` characters. */
const plain = (text: string, max: number): string =>
  stripControlText(text).replace(/["<>]/g, '').slice(0, max)

/** The clock of a time zone as the person sees it (`Thu 14:32`), or undefined when the zone does not work. */
export function localClockOf(timeZone: string, now: number): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(now))
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
    return `${get('weekday')} ${get('hour')}:${get('minute')}`.trim()
  } catch {
    return undefined
  }
}

/** The client in use: the presence's active client first, then the most recently active, then the most recently seen. */
export function activeClientOf(
  clients: readonly ClientRecord[],
  activeClient: string | null,
): ClientRecord | undefined {
  return clients
    .filter((c) => c.online)
    .sort(
      (a, b) =>
        Number(b.id === activeClient) - Number(a.id === activeClient) ||
        (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) ||
        b.lastSeenAt - a.lastSeenAt,
    )[0]
}

export interface ClientContextFacts {
  /** The person's clients (`parietal.list`); only those that are online count. */
  clients: readonly ClientRecord[]
  /** The presence's active client id, or null. */
  activeClient: string | null
  now: number
  /** The presence's `where` hint (ADR-0034 §5), or undefined when presence did not give one. */
  where?: PresenceWhere | undefined
}

/**
 * The block for one turn, or undefined when no client of the person is online. It names the active client, its host, OS,
 * device, network and local time, and says what is unknown. Client context is always on: there is no setting (ADR-0033 §4,
 * amended Nov 12, 2026).
 */
export function clientContextBlock(facts: ClientContextFacts): string | undefined {
  const active = activeClientOf(facts.clients, facts.activeClient)
  if (active === undefined) return undefined
  const kind = KIND_NAME[active.kind]

  const env = active.environment
  const lines = [CLIENT_CONTEXT_HEADING]
  const machine = env === undefined ? '' : `, host "${plain(env.host, 60)}"`
  const osText =
    env === undefined ? '' : [env.os, env.osVersion, env.arch].filter(Boolean).join(' ')
  const device = env === undefined || env.device === 'unknown' ? '' : `, a ${env.device}`
  lines.push(
    `- App: ${kind} "${plain(active.label, 40)}"${machine}${osText === '' ? '' : `, ${plain(osText, 80)}`}${device}.`,
  )
  if (active.network !== undefined) lines.push(`- Network: ${active.network}.`)
  const clock = env === undefined ? undefined : localClockOf(env.timezone, facts.now)
  if (env !== undefined && clock !== undefined)
    lines.push(`- Local time: ${clock} (${plain(env.timezone, 60)}).`)
  const hint = facts.where === undefined ? undefined : WHERE_HINT[facts.where]
  if (hint !== undefined) lines.push(`- ${hint}`)
  const sensor = facts.clients.some((c) => c.online && c.capabilities.includes('location.share'))
  if (!sensor)
    lines.push(
      'No location sensor is online; for where the person is, answer from what the host, the network and the time zone show (a time zone may name its region), never name a city, address or building as a fact, and say plainly that the exact place is not known.',
    )
  return lines.join('\n')
}

/** The block of one person now, read from the parietal service (the front agent's reminder calls it each turn). */
export function clientContextFor(
  service: Pick<ParietalService, 'list' | 'presence'>,
  personId: string,
  now: number = Date.now(),
): string | undefined {
  const presence = service.presence(personId)
  return clientContextBlock({
    clients: service.list(personId),
    activeClient: presence.activeClient,
    now,
    where: presence.where,
  })
}
