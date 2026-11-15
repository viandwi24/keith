import {
  AUDIT_MINE_MAX,
  AUDIT_SUBJECT_FIELDS,
  type MyAuditEvent,
  type MyAuditResource,
} from '@keith/contracts'
import type { AuditEventRecord, AuditRepo } from '@keith/db'
import { ACTIVITY_LOG_HIDDEN, ACTIVITY_LOG_SUMMARIES } from './activity-logs/summaries.ts'

/**
 * The member view of the audit log (`admin.audit.mine`, ADR-0027 §6, docs/specs/auth.md "Audit"). A line is built
 * from the row's kind and a few detail fields: an English summary, who did it and what it touched. Never the
 * address, the listener or the raw detail.
 *
 * Every kind of `AUDIT_SUBJECT_FIELDS` has a summary here or is listed as hidden. A plan that writes a kind with a
 * subject adds it to both places in its own audit step (the test in `mine.test.ts` fails when one is missing).
 */
export type MySummary = (detail: Record<string, unknown>, viewer: string) => string | undefined

const summaries = new Map<string, MySummary>()
/** Kinds that name a person but are never shown to them (the person is gone, or the row is noise). */
const hidden = new Set<string>()

/** Register the summary of a kind. A later registration replaces the earlier one. */
export function registerMySummary(kind: string, summary: MySummary): void {
  summaries.set(kind, summary)
  hidden.delete(kind)
}

/** The kind has a subject but no line: its rows are found and dropped. */
export function hideFromMine(kind: string): void {
  hidden.add(kind)
  summaries.delete(kind)
}

export const mySummaryKinds = (): string[] => [...summaries.keys()].sort()
export const hiddenMineKinds = (): string[] => [...hidden].sort()

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const count = (v: unknown): number => (typeof v === 'number' && v >= 1 ? v : 1)
/** A resource kind in a sentence, in the plural when more than one. */
const things = (kind: unknown, n: number): string => {
  const k = text(kind) ?? 'item'
  return n === 1 ? `1 ${k}` : `${n} ${k}s`
}
const aKind = (kind: unknown): string => text(kind) ?? 'item'
/** A day of an epoch ms, in UTC (`2026-12-03`). */
const day = (v: unknown): string =>
  typeof v === 'number' ? new Date(v).toISOString().slice(0, 10) : 'a later day'
const reasonOf = (d: Record<string, unknown>): string => {
  const r = text(d.reason) ?? text(d.by)
  return r === undefined ? '' : ` (${r})`
}

registerMySummary('person.create', () => 'created your account')
registerMySummary('settings.budget.cap', (d) =>
  d.usd === null || d.usd === undefined
    ? 'removed your monthly spending cap'
    : `set your monthly spending cap to ${String(d.usd)} USD`,
)
registerMySummary('person.update', () => 'changed your profile')
registerMySummary('person.role', (d) =>
  text(d.from) !== undefined && text(d.to) !== undefined
    ? `changed your role from ${text(d.from)} to ${text(d.to)}`
    : 'changed your role',
)
registerMySummary('person.status', (d) =>
  text(d.to) !== undefined ? `set your account to ${text(d.to)}` : 'changed your account status',
)
registerMySummary('person.link', () => 'linked a sign-in account to you')
registerMySummary('person.unlink', () => 'unlinked a sign-in account from you')
registerMySummary('person.pair', () => 'paired a device with your account')
registerMySummary('person.alias.add', (d) => `added a ${text(d.kind) ?? 'sign-in'} alias to you`)
registerMySummary(
  'person.alias.remove',
  (d) => `removed a ${text(d.kind) ?? 'sign-in'} alias from you`,
)
registerMySummary('person.secret.set', (d) => `set your ${text(d.kind) ?? 'secret'}`)
registerMySummary('person.secret.cleared', (d) => `cleared your ${text(d.kind) ?? 'secret'}`)
registerMySummary('person.secret.unlock', () => 'unlocked your sign-in')
registerMySummary('person.grant', (d) =>
  text(d.capability) === undefined ? undefined : `granted you ${text(d.capability)}`,
)
registerMySummary('person.grant.revoked', (d) =>
  text(d.capability) === undefined ? undefined : `took ${text(d.capability)} back from you`,
)
registerMySummary(
  'person.sessions.revoked',
  (d) => `signed you out of ${things('session', count(d.count))}${reasonOf(d)}`,
)
const credential = (d: Record<string, unknown>): string => {
  const k = text(d.credentialKind)
  return k === undefined ? 'credential' : `${k} credential`
}
registerMySummary('credential.created', (d) => `created a ${credential(d)} for you`)
registerMySummary('credential.revoked', (d) => `revoked a ${credential(d)} of yours${reasonOf(d)}`)
registerMySummary('person.exported', () => 'the owner exported your data')
registerMySummary('person.login.set', (d) =>
  d.canLogin === false ? 'the owner turned your sign-in off' : 'the owner turned your sign-in on',
)
registerMySummary('acl.owner-access', (d) => {
  // the owner's read of a person's reply style has its own line (`persona.style.read`): no second line here
  if (d.kind === 'persona-style') return undefined
  if (d.reason === 'export') return 'the owner exported your memory, workspace and conversations'
  if (d.kind === 'presence') return 'the owner read your presence in detail'
  const n = d.ids === undefined ? 1 : count(d.count)
  return `looked at ${n === 1 ? 'one' : n} of your ${aKind(d.kind)}s`
})
registerMySummary('plugin.reminders.cancelled-by-owner', (d, viewer) =>
  viewer === d.recipient
    ? 'the owner cancelled your reminder'
    : 'the owner cancelled a reminder you set',
)
registerMySummary('client.registered', (d) => `connected a ${aKind(d.kind)} app of yours`)
registerMySummary('client.removed', () => 'removed one of your connected apps')
registerMySummary('client.call', (d) =>
  d.ok === true
    ? `Keith asked one of your apps to ${text(d.capability) ?? 'do something'}`
    : `Keith asked your apps to ${text(d.capability) ?? 'do something'}, and none answered`,
)
registerMySummary('workspace.file.send', (d) =>
  text(d.path) === undefined
    ? 'Keith sent one of your files to a machine to work on'
    : `Keith sent your file ${text(d.path)} to a machine to work on`,
)
registerMySummary('presence.read', () => 'the owner read your presence in the console')
// HISTORY ONLY: no code writes `settings.client-context` since the switch was removed (ADR-0033, amended Nov 12, 2026).
// The rows written before that stay in the audit and must keep reading in "Privacy".
registerMySummary('settings.client-context', (d) =>
  d.share === false
    ? 'turned off sharing of your app, device, network and time zone with Keith'
    : 'turned on sharing of your app, device, network and time zone with Keith',
)
registerMySummary('presence.disclosure.set', (d) =>
  text(d.audience) === undefined || text(d.level) === undefined
    ? 'changed who may see your presence'
    : `set who may see your presence (${text(d.audience)}) to ${text(d.level)}`,
)
registerMySummary('presence.status.set', (d) =>
  d.busy === false
    ? 'cleared your status'
    : d.kind === 'out'
      ? 'set your status to out'
      : 'set your status to busy',
)
registerMySummary('protocol.create', () => 'created one of your protocols')
registerMySummary('protocol.update', () => 'changed one of your protocols')
registerMySummary('protocol.delete', () => 'deleted one of your protocols')
registerMySummary('protocol.pause', (d) =>
  typeof d.until === 'number' ? 'paused one of your protocols' : 'turned off one of your protocols',
)
registerMySummary('protocol.resume', () => 'turned back on one of your protocols')
registerMySummary('protocol.approve', () => 'approved an action of one of your protocols')
registerMySummary('protocol.proposal.create', () => 'Keith proposed a protocol for you')
registerMySummary('protocol.proposal.confirm', () => 'confirmed a protocol proposal of yours')
registerMySummary('protocol.proposal.dismiss', () => 'dismissed a protocol proposal of yours')
registerMySummary('protocol.answer', () => 'answered a question one of your protocols asked')
registerMySummary('protocol.run.start', () => 'one of your protocols started')
registerMySummary('protocol.run.step', (d) =>
  text(d.outcome) === undefined
    ? 'a step of one of your protocols ran'
    : `a step of one of your protocols ended: ${text(d.outcome)}`,
)
registerMySummary('protocol.run.end', (d) =>
  text(d.status) === undefined
    ? 'one of your protocols ended'
    : `one of your protocols ended (${text(d.status)})`,
)
registerMySummary('protocol.run.refused', (d) =>
  text(d.reason) === undefined
    ? 'one of your protocols did not run'
    : `one of your protocols did not run (${text(d.reason)})`,
)
registerMySummary(
  'protocol.act',
  (d) =>
    `Keith ran ${text(d.capability) ?? text(d.operation) ?? 'an action'} for one of your protocols`,
)
// the succession settings (docs/specs/succession.md, "Audit"): the owner sees what they changed, the heir sees that they were named
registerMySummary('owner.heir.set', (d, viewer) =>
  viewer === d.heir ? 'the owner named you their heir' : 'you set the heir of this Keith',
)
registerMySummary('owner.heir.clear', (d, viewer) => {
  if (viewer === d.heir)
    return d.reason === 'owner'
      ? 'the owner removed you as heir'
      : `you stopped being the heir (${text(d.reason) ?? 'changed'})`
  return 'you cleared the heir of this Keith'
})
registerMySummary(
  'owner.succession.window',
  (d) => `changed the succession window to ${count(d.to)} days`,
)
registerMySummary(
  'owner.succession.pause',
  (d) => `paused the succession checks until ${day(d.until)}`,
)
registerMySummary('owner.succession.resume', () => 'ended the succession pause early')
registerMySummary('owner.succession.start', (d, viewer) =>
  viewer === d.heir
    ? `the owner has been silent: a grace period started, you may claim from ${day(typeof d.graceStartedAt === 'number' ? d.graceStartedAt + 7 * 86_400_000 : undefined)}`
    : 'a succession grace period started',
)
registerMySummary('owner.succession.claimable', (d, viewer) =>
  viewer === d.heir
    ? 'you may claim ownership of this Keith now'
    : 'your heir may claim ownership now',
)
registerMySummary(
  'owner.succession.cancel',
  (d) => `the succession stopped (${text(d.reason) ?? 'cancelled'})`,
)
// the claim (succession.md, "The claim"): the heir sees that they took ownership, the previous owner that it moved
registerMySummary('owner.succession', (d, viewer) =>
  viewer === d.heir
    ? 'you claimed ownership of this Keith'
    : 'your heir claimed ownership of this Keith, and your sign-in is suspended',
)
registerMySummary('acl.create', (d) => `created a ${aKind(d.kind)} of yours`)
registerMySummary('acl.remove', (d) => `removed a ${aKind(d.kind)} of yours`)
registerMySummary('acl.share', (d) =>
  text(d.subject) === undefined
    ? `shared your ${aKind(d.kind)}`
    : `shared your ${aKind(d.kind)} with ${text(d.subject)}`,
)
registerMySummary('acl.unshare', (d) =>
  text(d.subject) === undefined
    ? `stopped sharing your ${aKind(d.kind)}`
    : `stopped sharing your ${aKind(d.kind)} with ${text(d.subject)}`,
)
registerMySummary('acl.chmod', (d) => `changed the access mode of your ${aKind(d.kind)}`)
registerMySummary('acl.chgrp', (d) => `changed the group of your ${aKind(d.kind)}`)
registerMySummary('acl.chown', (d, viewer) =>
  d.to === viewer
    ? `handed a ${aKind(d.kind)} over to you`
    : `handed your ${aKind(d.kind)} over to someone else`,
)
registerMySummary('acl.group.add', (d) => `added you to the group ${text(d.group) ?? ''}`.trim())
registerMySummary('acl.group.remove', (d) =>
  `removed you from the group ${text(d.group) ?? ''}`.trim(),
)
hideFromMine('person.delete')
// node rows name no person: the owner reads them in the audit log
hideFromMine('node.drivers')
hideFromMine('node.capability.refused')
hideFromMine('person.resources.moved')
hideFromMine('person.removed.kept')
hideFromMine('person.removed.purged')
hideFromMine('person.notice.seen')
// a delivery's own lines are the plugin's (the reminder); the creator reads the notice that it could not be delivered
hideFromMine('delivery.sent')
hideFromMine('delivery.retry')
hideFromMine('delivery.failed')
hideFromMine('delivery.held')
hideFromMine('delivery.push')
registerMySummary('push.subscribed', () => 'turned on push notifications on a device')
registerMySummary('push.unsubscribed', () => 'turned off push notifications on a device')
registerMySummary('push.preview.set', (d) =>
  d.preview === true
    ? 'turned on message previews in push notifications'
    : 'turned off message previews in push notifications',
)
registerMySummary('delivery.reported', () => 'a message you set could not be delivered')
registerMySummary('delivery.test_notice', () => 'the owner sent you a test notice')

// shared rooms (docs/specs/corpus-callosum.md, "Audit"): a line about a person, never the text of a room
registerMySummary('room.create', () => 'started a room with Keith')
registerMySummary('room.invite', () => 'was invited to a room with Keith')
registerMySummary('room.accept', () => 'joined a room with Keith')
registerMySummary('room.decline', () => 'declined an invitation to a room')
registerMySummary('room.leave', (d) =>
  d.reason === 'empty' ? 'left a room, and the room ended' : 'left a room',
)
registerMySummary('room.remove', (d) =>
  d.reason === 'suspended'
    ? 'was removed from a room because your access was suspended'
    : 'was removed from a room',
)
registerMySummary('room.end', () => 'a room you started ended')
// the initiator sees "started"; a member the row names (`members`) sees "were in"
registerMySummary('room.owner-end', (d, viewer) =>
  viewer === text(d.subject)
    ? 'the owner ended a room you started'
    : 'the owner ended a room you were in',
)
registerMySummary('room.read', (d, viewer) =>
  viewer === text(d.owner)
    ? 'the owner read the transcript of a room you started'
    : 'the owner read the transcript of a room you were in',
)
registerMySummary('room.handoff', () => 'asked Keith in your own chat about a room')
registerMySummary('room.post', () => 'shared a result with a room')
registerMySummary('room.turn.refused', (d) =>
  text(d.tool) === undefined
    ? 'a request of yours in a room was refused'
    : `a ${text(d.tool)} request of yours in a room was refused`,
)

// the persona and the reply style (docs/specs/prefrontal.md, "Audit"): the global change reads the same to every member; a
// style change names the fields only, never a value
registerMySummary('persona.change', () => "the owner changed Keith's persona")
registerMySummary(
  'persona.restore',
  () => "the owner restored an earlier version of Keith's persona",
)
registerMySummary('persona.style.set', (d) => {
  const fields = Array.isArray(d.fields) ? d.fields.map(String).join(', ') : ''
  return fields === ''
    ? 'changed how Keith replies to you'
    : `changed how Keith replies to you (${fields})`
})
registerMySummary('persona.style.read', () => 'the owner read how Keith replies to you')

// a context reset and a compaction of the person's own front session (docs/specs/chat-context.md, "Audit"): the generation and
// whether the lasting facts were saved first, never any text
registerMySummary('chat.context.new', (d) =>
  d.flushed === true
    ? 'started a new conversation context (earlier facts were saved first)'
    : 'started a new conversation context (without saving earlier facts)',
)
registerMySummary('chat.context.compact', (d) =>
  d.flushed === true
    ? 'shortened your conversation context (earlier facts were saved first)'
    : 'shortened your conversation context (without saving earlier facts)',
)

// the memory dreaming of the person's own memory (docs/specs/dreaming.md, "Audit"): counts and modes only, never the text of a
// candidate, an entry or a diary line
registerMySummary('dream.run', (d) => {
  if (d.status !== 'done') return 'a memory review did not run (no changes were made)'
  const promoted = typeof d.promoted === 'number' ? d.promoted : 0
  const merged = typeof d.merged === 'number' ? d.merged : 0
  const superseded = typeof d.superseded === 'number' ? d.superseded : 0
  const dropped = typeof d.dropped === 'number' ? d.dropped : 0
  const written =
    d.applied === true ? 'written to your memory' : 'kept as a proposal for you to apply'
  return `reviewed your memory: ${promoted} kept, ${merged} merged, ${superseded} replaced, ${dropped} dropped (${written})`
})
registerMySummary(
  'dream.apply',
  (d) =>
    `applied a proposed memory review (${typeof d.applied === 'number' ? d.applied : 0} changes)`,
)
registerMySummary(
  'dream.undo',
  (d) =>
    `undid a memory review (${typeof d.restored === 'number' ? d.restored : 0} files restored)`,
)
registerMySummary('dream.mode', (d) => `changed how Keith reviews your memory to ${String(d.to)}`)

// the activity logs of the person (docs/specs/activity-logs.md): the owner's reads and purges name the person; the settings do not
for (const [kind, summary] of Object.entries(ACTIVITY_LOG_SUMMARIES))
  registerMySummary(kind, summary)
for (const kind of ACTIVITY_LOG_HIDDEN) hideFromMine(kind)

const resourceOf = (detail: Record<string, unknown>): MyAuditResource | undefined => {
  const kind = text(detail.kind)
  if (kind === undefined || !('id' in detail || 'ids' in detail || 'count' in detail))
    return undefined
  const id = text(detail.id)
  const n = typeof detail.count === 'number' && detail.count >= 1 ? detail.count : undefined
  return { kind, ...(id === undefined ? {} : { id }), ...(n === undefined ? {} : { count: n }) }
}

/** One audit row as the person may read it, or undefined when the kind has no line. */
export function toMyEvent(
  row: AuditEventRecord,
  viewer: string,
  nameOf: (actor: string) => string,
): MyAuditEvent | undefined {
  const summary = summaries.get(row.kind)?.(row.detail, viewer)
  if (summary === undefined) return undefined
  const resource = row.kind.startsWith('acl.') ? resourceOf(row.detail) : undefined
  return {
    id: row.id,
    at: row.at,
    kind: row.kind,
    actorName: nameOf(row.actor),
    summary,
    ...(resource === undefined ? {} : { resource }),
  }
}

/** The kinds that name a person: what `AuditRepo.listFor` reads. */
export const subjectKinds = (): string[] => Object.keys(AUDIT_SUBJECT_FIELDS)

/**
 * The lines about a person, newest first, up to `limit` (default 50), older than `before`. Looks again past the
 * scan bound of one `listFor` page (at most 4 pages) so a quiet person is not answered with a short page.
 */
export function listMine(
  repo: Pick<AuditRepo, 'listFor'>,
  personId: string,
  options: { limit?: number | undefined; before?: number | undefined },
  nameOf: (actor: string) => string,
): MyAuditEvent[] {
  const limit = Math.min(options.limit ?? 50, AUDIT_MINE_MAX)
  const out: MyAuditEvent[] = []
  let before = options.before
  for (let page = 0; page < 4 && out.length < limit; page++) {
    const { rows, next } = repo.listFor(personId, {
      limit: limit - out.length,
      ...(before === undefined ? {} : { before }),
    })
    for (const row of rows) {
      const line = toMyEvent(row, personId, nameOf)
      if (line !== undefined) out.push(line)
    }
    if (next === undefined) break
    before = next
  }
  return out
}
