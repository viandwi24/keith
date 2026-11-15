// The per-person style of the prefrontal region (docs/specs/prefrontal.md, "Per-person style and its guard"; ADR-0029 §3,
// ADR-0020 §4). A person reads and sets only their own row; the closed enums and the address guard come from the contracts,
// so the core and the TUI refuse the same values. A change writes one `persona.style.set` row with the field names only
// (never a value) and one `brain.prefrontal.style` event (the person and the changed field names). The owner may read another
// person's style only through `readStyleAs`, which is audited (`persona.style.read` and `acl.owner-access`); anyone else gets
// `NOT_FOUND`, so a member's style is invisible to another member.
import {
  DEFAULT_PERSON_STYLE,
  PERSON_STYLE_FIELDS,
  type PersonStyle,
  type PersonStyleField,
  type PersonStylePatch,
  PersonStylePatchSchema,
  validateAddress,
} from '@keith/contracts'
import type { PersonStyleRepo } from '@keith/db'
import { type FrontGenerationOf, frontSessionId } from '../../platform/sessions.ts'
import type { AclAudit, Audit } from '../audit/index.ts'
import type { PeopleService } from '../people/index.ts'
import {
  createOwnerCheck,
  type PersonaActivity,
  type PrefrontalCaller,
  PrefrontalError,
} from './service.ts'

/** The ACL read bit (`r` = 4): what the owner's read of a person's style is (`acl.owner-access`). */
const READ_BIT = 4
/** The resource kind of a person's style in the owner-access audit row. */
export const PERSON_STYLE_KIND = 'persona-style'

export interface PersonStyleServiceOptions {
  styles: PersonStyleRepo
  people: Pick<PeopleService, 'get'>
  audit: Pick<Audit, 'record'>
  aclAudit: Pick<AclAudit, 'ownerAccess'>
  activity?: PersonaActivity
  /** The current front generation of each person (ADR-0030 §2): the session the person's events go to. */
  generations: FrontGenerationOf
}

export interface PersonStyleService {
  /** The caller's own style; every default when no row exists. */
  get(caller: PrefrontalCaller): PersonStyle
  /** Whether the caller has a stored style row (false: every value is a default and onboarding has not ended). */
  has(caller: PrefrontalCaller): boolean
  /**
   * Stores the caller's style row with the defaults when none exists ("skip" of onboarding); audited like a change with no
   * fields. Returns the style. A person who already has a row is left as is.
   */
  ensure(caller: PrefrontalCaller): PersonStyle
  /** Merges the patch over the caller's own style. A refused value changes nothing. Returns the style after the change. */
  set(caller: PrefrontalCaller, patch: PersonStylePatch): PersonStyle
  /**
   * The owner's read of another person's style (audited). A member asking for anyone else, or an unknown person, gets
   * `NOT_FOUND`. Reading one's own style is never audited.
   */
  readStyleAs(caller: PrefrontalCaller, personId: string): Promise<PersonStyle>
}

/** The values of a style as the change compares them (topics as a list, so order and content both count). */
const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** The style fields whose value differs between two styles. */
const changedFields = (before: PersonStyle, after: PersonStyle): PersonStyleField[] =>
  PERSON_STYLE_FIELDS.filter((field) => !sameValue(before[field], after[field]))

/** The refusal of a style patch: the address check first (same function as the TUI), then the closed enums and lists. */
function checkPatch(patch: PersonStylePatch): PersonStylePatch {
  const address = patch.address
  if (typeof address === 'string' && !validateAddress(address))
    throw new PrefrontalError(
      'VALIDATION',
      'that address is not a name Keith can use',
      'not-a-style-value',
    )
  const checked = PersonStylePatchSchema.safeParse(patch)
  if (checked.success) return checked.data
  const empty = checked.error.issues.some((issue) => issue.message === 'empty patch')
  if (empty)
    throw new PrefrontalError(
      'VALIDATION',
      'a style change names at least one field',
      'empty-patch',
    )
  throw new PrefrontalError('VALIDATION', 'a style value is not in its list', 'not-a-style-value')
}

export function createPersonStyleService(options: PersonStyleServiceOptions): PersonStyleService {
  const { styles, audit, aclAudit, generations } = options
  const owner = createOwnerCheck(options.people)

  const current = (personId: string): PersonStyle =>
    styles.get(personId)?.style ?? DEFAULT_PERSON_STYLE

  const store = (caller: PrefrontalCaller, patch: PersonStylePatch, fields: PersonStyleField[]) => {
    const after = styles.upsert(caller.by, patch, caller.by).style
    audit.record({
      kind: 'persona.style.set',
      actor: caller.by,
      via: caller.via,
      detail: { subject: caller.by, fields },
    })
    options.activity?.record(
      frontSessionId(caller.by, generations.current(caller.by)),
      'brain.prefrontal.style',
      { region: 'prefrontal', personId: caller.by, fields },
    )
    return after
  }

  const ensure = (caller: PrefrontalCaller): PersonStyle =>
    styles.get(caller.by) !== undefined
      ? current(caller.by)
      : store(caller, { language: DEFAULT_PERSON_STYLE.language }, [])

  return {
    get(caller) {
      return current(caller.by)
    },

    has: (caller) => styles.get(caller.by) !== undefined,

    ensure,

    set(caller, patch) {
      const given = checkPatch(patch)
      const before = current(caller.by)
      const defined = Object.fromEntries(
        Object.entries(given).filter(([, value]) => value !== undefined),
      )
      const wanted = { ...before, ...defined } as PersonStyle
      const fields = changedFields(before, wanted)
      // a change that changes nothing writes nothing: no audit line, no event. A person with no row still gets one
      // (the defaults, `fields: []`), so a first answer equal to a default ends onboarding
      if (fields.length === 0) return styles.get(caller.by) === undefined ? ensure(caller) : before
      return store(caller, given, fields)
    },

    async readStyleAs(caller, personId) {
      if (personId === caller.by) return current(personId)
      // a member reads nobody else's style: the same answer as a person who does not exist
      if (!(await owner.isOwner(caller.by)))
        throw new PrefrontalError('NOT_FOUND', 'there is no such person')
      if ((await owner.find(personId)) === undefined)
        throw new PrefrontalError('NOT_FOUND', 'there is no such person')
      aclAudit.ownerAccess(caller, {
        kind: PERSON_STYLE_KIND,
        bits: READ_BIT,
        resources: [{ id: personId, owner: personId }],
      })
      audit.record({
        kind: 'persona.style.read',
        actor: caller.by,
        via: caller.via,
        detail: { subject: personId },
      })
      return current(personId)
    },
  }
}
