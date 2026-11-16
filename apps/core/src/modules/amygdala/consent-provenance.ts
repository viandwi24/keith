// Where the targets of a call came from (ADR-0039 §2), computed by code from the person's own messages in the restricted transcript,
// never from a tool output: a URL, a recipient or a command the person wrote is their choice, even if a page was read in between. Pure.
import type { GuardTranscriptEntry } from 'eharness'

export interface ProvenanceInput {
  targets: readonly string[] | undefined
  /** `url`: compared by host; `text` (default): the target's text appears in a message. */
  kind?: 'url' | 'text'
  transcript: readonly GuardTranscriptEntry[]
  /** `any`: every message of the person in the transcript; `newest`: only the latest (a command typed long ago is no request now). */
  scope: 'any' | 'newest'
}

const URL_IN_TEXT = /\b(?:https?:\/\/|\/\/)[^\s<>"'`)\]]+/gi
const DOMAIN_IN_TEXT = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()
const bare = (host: string): string =>
  host
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '')

/** The host of a URL-ish target (`https://x/y`, `//x/y`, `x.com/y`), or undefined. */
function hostOf(target: string): string | undefined {
  const t = target.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t.replace(/^\/\//, '')}`
  try {
    const u = new URL(withScheme)
    return u.hostname === '' ? undefined : bare(u.hostname)
  } catch {
    return undefined
  }
}

/** Every host the person wrote: in full URLs and as bare domains (`detik.com`). */
function hostsIn(text: string): Set<string> {
  const hosts = new Set<string>()
  for (const m of text.match(URL_IN_TEXT) ?? []) {
    const h = hostOf(m)
    if (h !== undefined) hosts.add(h)
  }
  for (const m of text.match(DOMAIN_IN_TEXT) ?? []) hosts.add(bare(m))
  return hosts
}

/** True when there is at least one target and every target is the person's. */
export function targetsFromPerson(input: ProvenanceInput): boolean {
  const targets = (input.targets ?? []).filter((t) => t.trim() !== '')
  if (targets.length === 0) return false
  const messages = input.transcript.flatMap((e) => (e.role === 'user' ? [e.text] : []))
  const said = input.scope === 'newest' ? messages.slice(-1) : messages
  if (said.length === 0) return false
  if (input.kind === 'url') {
    const hosts = new Set<string>()
    for (const text of said) for (const h of hostsIn(text)) hosts.add(h)
    return targets.every((t) => {
      const h = hostOf(t)
      if (h === undefined) return false
      for (const p of hosts) if (h === p || h.endsWith(`.${p}`)) return true
      return false
    })
  }
  const texts = said.map(squash)
  return targets.every((t) => {
    const needle = squash(t)
    return texts.some((text) => text.includes(needle))
  })
}
