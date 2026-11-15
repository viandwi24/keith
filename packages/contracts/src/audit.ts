import { z } from 'zod'

/**
 * What a person may read about the owner and others touching their things (docs/specs/auth.md, "Audit";
 * ADR-0027 §6). A line says who did what to what: never an address, never the listener, never the raw detail.
 */
export const MyAuditResourceSchema = z.object({
  kind: z.string(),
  id: z.string().optional(),
  count: z.number().int().min(1).optional(),
})
export type MyAuditResource = z.infer<typeof MyAuditResourceSchema>

export const MyAuditEventSchema = z.object({
  id: z.number(),
  at: z.number(),
  kind: z.string(),
  /** The display name of who did it ("Keith" for the system). */
  actorName: z.string(),
  /** English, from the kind ("looked at 3 of your notes"). */
  summary: z.string(),
  resource: MyAuditResourceSchema.optional(),
})
export type MyAuditEvent = z.infer<typeof MyAuditEventSchema>

/** The one notice of the audit area: shown once per person at their first sign-in (ADR-0027 §6). */
export const AUDIT_PRIVACY_NOTICE = 'audit-privacy'
/** Its text (English; a front agent may translate it, the stored text stays English). */
export const AUDIT_PRIVACY_NOTICE_TEXT =
  'The owner of this Keith can read what you keep in it. Each time they look, Keith writes it down: see Manage > Privacy.'

export const AuditNoticeSchema = z.object({
  notice: z.literal(AUDIT_PRIVACY_NOTICE),
  text: z.string(),
  /** This person has already acknowledged it (on any device). */
  seen: z.boolean(),
})
export type AuditNotice = z.infer<typeof AuditNoticeSchema>

/** The most lines one `audit.mine` call returns. */
export const AUDIT_MINE_MAX = 200

export const AuditMineInputSchema = z.object({
  limit: z.number().int().min(1).max(AUDIT_MINE_MAX).optional(),
  /** Page cursor: only lines older than this id (the `id` of the last line of the previous page). */
  before: z.number().int().min(1).optional(),
  /** The owner reads the lines of another person (`keith-core audit mine <person>`); anyone else may name only themselves. */
  person: z.string().min(1).max(100).optional(),
})
export type AuditMineInput = z.infer<typeof AuditMineInputSchema>

/**
 * Which fields of an audit row's detail name the person the row is about, per kind. This is data, not a
 * convention: `AuditRepo.listFor` reads it (the table has no subject column, ADR-0027 §6) and the core keeps a
 * twin summary per kind (`registerMySummary`, `modules/audit/mine.ts`). A plan that writes a new kind with a
 * subject adds it here and there; a test fails when one is missing.
 *
 * A field may hold one person id or an array of person ids (`members` of a room row): the reader matches either.
 *
 * Rows made before `subject` existed are still found through `personId` (person rows) and `owner`
 * (owner-access rows): `personId` is read for every kind listed here.
 */
export const AUDIT_SUBJECT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'person.create': ['subject'],
  'person.update': ['subject'],
  'person.role': ['subject'],
  'person.status': ['subject'],
  'person.delete': ['subject'],
  'person.link': ['subject'],
  'person.unlink': ['subject'],
  'person.pair': ['subject'],
  'person.alias.add': ['subject'],
  'person.alias.remove': ['subject'],
  'person.secret.set': ['subject'],
  'person.secret.cleared': ['subject'],
  'person.secret.unlock': ['subject'],
  'person.grant': ['subject'],
  'person.grant.revoked': ['subject'],
  'person.sessions.revoked': ['subject'],
  'person.resources.moved': ['subject'],
  'person.removed.kept': ['subject'],
  'person.removed.purged': ['subject'],
  'person.exported': ['subject'],
  'person.login.set': ['subject'],
  'person.notice.seen': ['subject'],
  'credential.created': ['subject'],
  'credential.revoked': ['subject'],
  'acl.owner-access': ['owner'],
  // a node's driver set changed between two connections, and a capability a node announced was refused: a node names
  // no person, so no field holds one (the owner reads them in the audit log; `mine` hides them)
  'node.drivers': [],
  'node.capability.refused': [],
  // a reminder between two other people that the owner cancelled (ADR-0027 §18): both people see the line
  'plugin.reminders.cancelled-by-owner': ['creator', 'recipient'],
  'acl.create': ['resourceOwner', 'owner'],
  'acl.remove': ['resourceOwner'],
  'acl.share': ['resourceOwner'],
  'acl.unshare': ['resourceOwner'],
  'acl.chmod': ['resourceOwner'],
  'acl.chgrp': ['resourceOwner'],
  'acl.chown': ['resourceOwner', 'to'],
  'acl.group.add': ['person'],
  'acl.group.remove': ['person'],
  'settings.budget.cap': ['person'],
  // a delivery to a person (docs/specs/delivery.md, "Audit"): the recipient, or the creator who got the failure notice
  'delivery.sent': ['to'],
  'delivery.retry': ['to'],
  'delivery.failed': ['to'],
  'delivery.reported': ['to'],
  // a delivery kept for the return digest (ADR-0034 §7): the recipient and the reason, never the text
  'delivery.held': ['to'],
  // a Web Push sent for a delivery (docs/specs/push.md, "Audit"): the recipient and the subscription id, never the endpoint or the text
  'delivery.push': ['to'],
  // the person's own push subscriptions and setting (docs/specs/push.md, "Audit")
  'push.subscribed': ['subject'],
  'push.unsubscribed': ['subject'],
  'push.preview.set': ['subject'],
  // the owner's test notice (`keith-core notify`, docs/specs/delivery.md, "Audit"): the recipient, the outcome, never the text
  'delivery.test_notice': ['to'],
  // presence of the person's own clients and status (docs/specs/parietal.md, "Settings, audit, errors")
  'client.registered': ['subject'],
  'client.removed': ['subject'],
  // an ecosystem call of the front agent (`client_call`, docs/specs/node-drivers.md): the person, the capability, the outcome
  'client.call': ['person'],
  // a file of the person leaves Keith by reference (ADR-0021 §2): the path and the size, never the content
  'workspace.file.send': ['person'],
  'presence.status.set': ['subject'],
  'presence.read': ['subject'],
  'presence.disclosure.set': ['subject'],
  // the person's old setting for client context (docs/decisions/0033 §4, removed Nov 12, 2026): no code writes it any more;
  // the rows written before the removal stay in the audit and still read in "Privacy" (apps/core/.../audit/mine.ts)
  'settings.client-context': ['subject'],
  // a protocol of a person (docs/specs/hypothalamus.md, "Audit"): the owner's change of it is visible to the owner
  'protocol.create': ['subject'],
  'protocol.update': ['subject'],
  'protocol.delete': ['subject'],
  'protocol.pause': ['subject'],
  'protocol.resume': ['subject'],
  'protocol.approve': ['subject'],
  'protocol.proposal.create': ['subject'],
  'protocol.proposal.confirm': ['subject'],
  'protocol.proposal.dismiss': ['subject'],
  // a run of a person's protocol and the `act` it ran (the run's person is the subject; the owner's own rows too)
  'protocol.run.start': ['subject'],
  'protocol.run.step': ['subject'],
  'protocol.run.end': ['subject'],
  'protocol.run.refused': ['subject'],
  'protocol.act': ['subject'],
  // the person answered a question their own run asked (the answer text is never audited)
  'protocol.answer': ['subject'],
  // a shared room (docs/specs/corpus-callosum.md, "Audit"): the rows about a person are visible to that person
  'room.create': ['subject'],
  'room.invite': ['subject'],
  'room.accept': ['subject'],
  'room.decline': ['subject'],
  'room.leave': ['subject'],
  'room.remove': ['subject'],
  'room.end': ['subject'],
  // an end by the owner, and the owner's read of a room they are not in: the initiator (`owner`) and every
  // member who was active at that moment (`members`, person ids, no text) see the row
  'room.owner-end': ['subject', 'members'],
  'room.read': ['owner', 'members'],
  'room.handoff': ['subject'],
  'room.post': ['subject'],
  'room.turn.refused': ['speaker'],
  // the owner-absence succession (docs/specs/succession.md, "Audit"): the owner and the heir see the rows about them
  'owner.heir.set': ['owner', 'heir'],
  'owner.heir.clear': ['owner', 'heir'],
  'owner.succession.window': ['owner'],
  'owner.succession.pause': ['owner'],
  'owner.succession.resume': ['owner'],
  'owner.succession.start': ['owner', 'heir'],
  'owner.succession.claimable': ['owner', 'heir'],
  'owner.succession.cancel': ['owner', 'heir'],
  'owner.succession': ['owner', 'heir'],
  // the persona and the reply style (docs/specs/prefrontal.md, "Audit"): a person's own style change names the field names
  // only; the owner's read of a person's style is visible to that person. The owner's change of the global persona is a line
  // for every active member at the time (`members`, ids only, no text): "the owner changed Keith's persona"
  'persona.style.set': ['subject'],
  'persona.style.read': ['subject'],
  'persona.change': ['members'],
  'persona.restore': ['members'],
  // a context reset and a compaction of a person's own front session (docs/specs/chat-context.md, "Audit"): the subject only,
  // with the generation and the flush flag, never text (ADR-0030 §9)
  'chat.context.new': ['subject'],
  'chat.context.compact': ['subject'],
  // the memory dreaming of a person (docs/specs/dreaming.md, "Audit", ADR-0031 §8): the subject only, with the mode and counts,
  // never text, candidate or entry; the owner reads the same rows about a member through the audited read
  'dream.run': ['subject'],
  'dream.apply': ['subject'],
  'dream.undo': ['subject'],
  'dream.mode': ['subject'],
  // the activity logs of a person (docs/specs/activity-logs.md, "Audit", ADR-0032 §8): the owner's read of a member's session,
  // call or raw JSON, and a purge, name the person; the owner's change of the settings is instance-wide and names no person
  // (hidden from `audit.mine`, the owner reads it in the audit log)
  'logs.owner-read': ['subject'],
  'logs.purge': ['subject'],
  'logs.settings': [],
}

/** Legacy detail key of the person rows written before `subject` existed. */
export const AUDIT_LEGACY_SUBJECT_FIELD = 'personId'
