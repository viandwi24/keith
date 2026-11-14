// The persona service of the prefrontal region (docs/specs/prefrontal.md, "Persona", "Audit", "Feed"; ADR-0029 §2, ADR-0009).
// First boot seeds the persona from a template; `setTemplate`, `edit` and `restore` each write exactly one version and one
// audit row, then emit `brain.prefrontal.change` and the `persona.changed` record. Every change checks that the caller is the
// owner (`not-owner`) and that a step-up was done (`step-up-required`) before anything is written. No model is involved.

import {
  PERSONA_CHANGED,
  type PersonaBody,
  PersonaBodySchema,
  type PersonaPatch,
  PersonaPatchSchema,
  type PersonaTemplate,
  PersonaTemplateSchema,
  type PersonaVersion,
  type PersonaVersionReason,
  type PersonaView,
} from '@keith/contracts'
import type { AuditVia, PersonaRepo, PersonaVersionRecord } from '@keith/db'
import type { ZodError, ZodIssue } from 'zod'
import type { Audit } from '../audit/index.ts'
import { PeopleError, type PeopleService } from '../people/index.ts'
import { templateToBody } from './templates.ts'

export type PrefrontalErrorCode = 'FORBIDDEN' | 'NOT_FOUND' | 'VALIDATION'
export type PrefrontalRefusal =
  | 'not-owner'
  | 'step-up-required'
  | 'not-a-style-value'
  | 'line-too-long'
  | 'text-too-long'
  | 'empty-line'
  | 'invalid-value'
  | 'empty-patch'

/** A refusal of the prefrontal services. `code` is the RPC code; `reason` names the refusal. */
export class PrefrontalError extends Error {
  constructor(
    readonly code: PrefrontalErrorCode,
    message: string,
    readonly reason?: PrefrontalRefusal,
  ) {
    super(message)
    this.name = 'PrefrontalError'
  }
}

/**
 * Who asks and through which listener. `elevated` is the step-up of the call (the owner's PIN or password over TCP, or the
 * implicit owner of the local socket): the same flag `stepUpDenial` reads from the principal.
 */
export interface PrefrontalCaller {
  by: string
  via: AuditVia
  elevated: boolean
}

/** The caller of a change the core makes on its own (the first boot seed). */
export const SYSTEM_PREFRONTAL_CALLER: PrefrontalCaller = {
  by: 'system',
  via: 'local',
  elevated: true,
}

/** Writes an activity record. `sessionId` null is a global record (no person), as `nodes` and `budget` write theirs. */
export interface PersonaActivity {
  record(sessionId: string | null, type: string, payload: Record<string, unknown>): void
}

/** The owner check, shared with the style service: a person's role from the directory (`NOT_FOUND` reads as no person). */
export interface OwnerCheck {
  find(personId: string): Promise<{ role: string } | undefined>
  isOwner(personId: string): Promise<boolean>
}

export function createOwnerCheck(people: Pick<PeopleService, 'get'>): OwnerCheck {
  const find = async (personId: string) => {
    try {
      return await people.get(personId)
    } catch (error) {
      if (error instanceof PeopleError && error.code === 'NOT_FOUND') return undefined
      throw error
    }
  }
  return {
    find,
    isOwner: async (personId) => (await find(personId))?.role === 'owner',
  }
}

/** The owner's refusal when the caller is a member, else nothing. */
export async function requireOwner(owner: OwnerCheck, caller: PrefrontalCaller): Promise<void> {
  if (!(await owner.isOwner(caller.by)))
    throw new PrefrontalError('FORBIDDEN', 'only the owner may change this', 'not-owner')
}

/** The step-up refusal when the call did not confirm with the PIN or password. */
export function requireStepUp(caller: PrefrontalCaller): void {
  if (!caller.elevated)
    throw new PrefrontalError(
      'FORBIDDEN',
      'confirm with your PIN or password first (step-up)',
      'step-up-required',
    )
}

export interface PersonaServiceOptions {
  persona: PersonaRepo
  people: Pick<PeopleService, 'get' | 'list'>
  audit: Pick<Audit, 'record'>
  activity?: PersonaActivity
}

export interface PersonaService {
  /** The current persona, or undefined before the first boot seeds it. Any person may read it. */
  get(): PersonaView | undefined
  /** First boot: writes version 1 from a template when no persona exists. True when it wrote. */
  seed(templateId?: PersonaTemplate): boolean
  /** The owner's history, newest first. */
  history(caller: PrefrontalCaller, limit?: number): Promise<PersonaVersion[]>
  /** The owner chooses a built-in template (version + 1, reason `template`). Returns the version written. */
  setTemplate(caller: PrefrontalCaller, templateId: PersonaTemplate): Promise<number>
  /** The owner's patch, merged over the current body and validated as a whole (reason `edit`, template `custom`). */
  edit(caller: PrefrontalCaller, patch: PersonaPatch): Promise<number>
  /** The owner restores an old version: a new version with its body (reason `restore`). `NOT_FOUND` when unknown. */
  restore(caller: PrefrontalCaller, version: number): Promise<number>
}

const FALLBACK_BODY = templateToBody('professional')

/** The refusal of a zod error of the persona body: lines are named apart, and an empty patch has its own reason. */
function refusalOf(error: ZodError): PrefrontalError {
  const issue: ZodIssue | undefined = error.issues[0]
  if (issue === undefined)
    return new PrefrontalError('VALIDATION', 'invalid persona', 'invalid-value')
  if (issue.message === 'empty patch')
    return new PrefrontalError('VALIDATION', 'an edit names at least one field', 'empty-patch')
  const tooBig = issue.code === 'too_big'
  if (issue.path[0] === 'lines')
    return tooBig
      ? new PrefrontalError(
          'VALIDATION',
          'a fixed line is longer than 120 characters',
          'line-too-long',
        )
      : new PrefrontalError('VALIDATION', 'a fixed line may not be empty', 'empty-line')
  return tooBig
    ? new PrefrontalError('VALIDATION', `${issue.path.join('.')} is too long`, 'text-too-long')
    : new PrefrontalError('VALIDATION', `${issue.path.join('.')} is not valid`, 'invalid-value')
}

const toView = (row: {
  version: number
  templateId: PersonaView['templateId']
  body: PersonaBody
  updatedAt: number
}): PersonaView => ({
  version: row.version,
  templateId: row.templateId,
  body: row.body,
  updatedAt: row.updatedAt,
})

const toVersion = (row: PersonaVersionRecord): PersonaVersion => ({
  version: row.version,
  templateId: row.templateId,
  body: row.body,
  reason: row.reason,
  changedBy: row.changedBy,
  changedAt: row.changedAt,
  note: row.note,
})

export function createPersonaService(options: PersonaServiceOptions): PersonaService {
  const { persona, audit } = options
  const owner = createOwnerCheck(options.people)

  /** One version was written: its audit row (`kind`), the brain event and the feed record. No text leaves the core. */
  const announce = (
    caller: PrefrontalCaller,
    kind: 'persona.change' | 'persona.restore',
    version: number,
    reason: PersonaVersionReason,
    detail: Record<string, unknown>,
    members: readonly string[],
  ): void => {
    audit.record({
      kind,
      actor: caller.by,
      via: caller.via,
      detail: { version, reason, members: [...members], ...detail },
    })
    options.activity?.record(null, 'brain.prefrontal.change', {
      region: 'prefrontal',
      version,
      reason,
    })
    options.activity?.record(null, PERSONA_CHANGED, { version, reason })
  }

  /** The ids of the active people now: the audience of a global change's audit line (`members`, ids only). */
  const activeMembers = async (): Promise<string[]> =>
    (await options.people.list()).filter((p) => p.status === 'active').map((p) => p.id)

  return {
    get() {
      const row = persona.get()
      return row === undefined ? undefined : toView(row)
    },

    seed(templateId = 'professional') {
      if (persona.get() !== undefined) return false
      const id = PersonaTemplateSchema.parse(templateId)
      const version = persona.write({
        templateId: id,
        body: templateToBody(id),
        reason: 'template',
        changedBy: SYSTEM_PREFRONTAL_CALLER.by,
      })
      // the first boot has no owner to list yet: the seed line names no members (ids only, as every line)
      announce(
        SYSTEM_PREFRONTAL_CALLER,
        'persona.change',
        version,
        'template',
        { templateId: id },
        [],
      )
      return true
    },

    async history(caller, limit) {
      await requireOwner(owner, caller)
      return persona.versions(limit).map(toVersion)
    },

    async setTemplate(caller, templateId) {
      await requireOwner(owner, caller)
      requireStepUp(caller)
      const id = PersonaTemplateSchema.safeParse(templateId)
      if (!id.success) throw new PrefrontalError('VALIDATION', 'no such template', 'invalid-value')
      const version = persona.write({
        templateId: id.data,
        body: templateToBody(id.data),
        reason: 'template',
        changedBy: caller.by,
      })
      announce(
        caller,
        'persona.change',
        version,
        'template',
        { templateId: id.data },
        await activeMembers(),
      )
      return version
    },

    async edit(caller, patch) {
      await requireOwner(owner, caller)
      requireStepUp(caller)
      const checked = PersonaPatchSchema.safeParse(patch)
      if (!checked.success) throw refusalOf(checked.error)
      const base = persona.get()?.body ?? FALLBACK_BODY
      const given = checked.data
      const merged = PersonaBodySchema.safeParse({
        ...base,
        ...Object.fromEntries(
          Object.entries(given).filter(([key, value]) => key !== 'lines' && value !== undefined),
        ),
        lines: { ...base.lines, ...(given.lines ?? {}) },
      })
      if (!merged.success) throw refusalOf(merged.error)
      const version = persona.write({
        templateId: 'custom',
        body: merged.data,
        reason: 'edit',
        changedBy: caller.by,
      })
      announce(
        caller,
        'persona.change',
        version,
        'edit',
        { templateId: 'custom', fields: Object.keys(given) },
        await activeMembers(),
      )
      return version
    },

    async restore(caller, version) {
      await requireOwner(owner, caller)
      requireStepUp(caller)
      const written = persona.restore(version, caller.by)
      if (written === undefined)
        throw new PrefrontalError('NOT_FOUND', `there is no persona version ${version}`)
      announce(
        caller,
        'persona.restore',
        written,
        'restore',
        { restored: version },
        await activeMembers(),
      )
      return written
    },
  }
}
