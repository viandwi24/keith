// The "Me" style form's state, as plain functions (docs/specs/tui.md, "Persona"). The person edits their own style: an address, a
// language, brevity, formality and the gentle topics. The address check is the contract's own (`validateAddress`, `AddressSchema`),
// so the form refuses the same names the core refuses (ADR-0029 §3). A blank address is not a value: it clears the name (null).
import {
  ADDRESS_DENY_WORDS,
  GENTLE_TOPICS,
  type GentleTopic,
  PERSONA_GENTLE_TOPICS_MAX,
  type PersonStyle,
  type PersonStylePatch,
  PersonStylePatchSchema,
  STYLE_LANGUAGES,
  type StyleBrevity,
  StyleBrevitySchema,
  type StyleFormality,
  StyleFormalitySchema,
  type StyleLanguage,
  validateAddress,
} from '@keith/contracts'

/** The style fields the form edits, in form order. */
export const STYLE_FIELDS = ['address', 'language', 'brevity', 'formality', 'gentleTopics'] as const
export type StyleField = (typeof STYLE_FIELDS)[number]

export const STYLE_FIELD_LABELS: Record<StyleField, string> = {
  address: 'Address (the name Keith uses)',
  language: 'Language',
  brevity: 'Brevity',
  formality: 'Formality',
  gentleTopics: 'Gentle topics',
}

/** The choices of the enum fields, in the order the form lists them. */
export const LANGUAGE_CHOICES: readonly StyleLanguage[] = ['auto', ...STYLE_LANGUAGES]
export const BREVITY_CHOICES: readonly StyleBrevity[] = StyleBrevitySchema.options
export const FORMALITY_CHOICES: readonly StyleFormality[] = StyleFormalitySchema.options
export const TOPIC_CHOICES: readonly GentleTopic[] = GENTLE_TOPICS

/** The draft: the address as typed (an empty string is "no name"), the enums as chosen, the topics as checked. */
export interface StyleDraft {
  address: string
  language: StyleLanguage
  brevity: StyleBrevity
  formality: StyleFormality
  gentleTopics: GentleTopic[]
}

/** The draft of a saved style: every field starts at its saved value. */
export function styleDraftOf(style: PersonStyle): StyleDraft {
  return {
    address: style.address ?? '',
    language: style.language,
    brevity: style.brevity,
    formality: style.formality,
    gentleTopics: [...style.gentleTopics],
  }
}

/** The address check the form runs on each change. `value` is what a save sends (`null` clears the name). */
export type AddressCheck = { ok: true; value: string | null } | { ok: false; message: string }

/**
 * The form's check of an address, the same as the core's: a blank input clears the name; anything else must pass `validateAddress`
 * as typed (no trimming, so a value the core would refuse is refused here). The message names the deny word when that is the cause.
 */
export function checkAddress(raw: string): AddressCheck {
  if (raw.length === 0) return { ok: true, value: null }
  if (validateAddress(raw)) return { ok: true, value: raw }
  const word = raw
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .find((w) => ADDRESS_DENY_WORDS.includes(w))
  return {
    ok: false,
    message:
      word === undefined
        ? "use a name: letters, spaces, - or ' (40 characters and four words at most)"
        : `"${word}" is not allowed in a name`,
  }
}

/** Topics checked, up to the limit. Checking a seventh is refused (the form keeps the topic list as it was). */
export function toggleTopic(draft: StyleDraft, topic: GentleTopic): StyleDraft {
  if (draft.gentleTopics.includes(topic)) {
    return { ...draft, gentleTopics: draft.gentleTopics.filter((t) => t !== topic) }
  }
  if (draft.gentleTopics.length >= PERSONA_GENTLE_TOPICS_MAX) return draft
  return { ...draft, gentleTopics: [...draft.gentleTopics, topic] }
}

/** The fields whose draft differs from the saved style, in form order. */
export function dirtyStyleFieldsOf(style: PersonStyle, draft: StyleDraft): StyleField[] {
  const saved = styleDraftOf(style)
  const sameTopics =
    saved.gentleTopics.length === draft.gentleTopics.length &&
    saved.gentleTopics.every((t) => draft.gentleTopics.includes(t))
  return STYLE_FIELDS.filter((field) => {
    if (field === 'gentleTopics') return !sameTopics
    return saved[field] !== draft[field]
  })
}

/** A problem with one field of the style form. */
export interface StyleProblem {
  field: StyleField
  message: string
}

/**
 * The patch a save sends (`persona.style.set`): only the changed fields. `patch` is `undefined` when nothing changed or a field is
 * refused; `problems` says which. The final check is `PersonStylePatchSchema`, the core's own schema.
 */
export function stylePatchOf(
  style: PersonStyle,
  draft: StyleDraft,
): { patch: PersonStylePatch | undefined; problems: StyleProblem[] } {
  const dirty = dirtyStyleFieldsOf(style, draft)
  if (dirty.length === 0) return { patch: undefined, problems: [] }
  const problems: StyleProblem[] = []
  const patch: Record<string, unknown> = {}
  for (const field of dirty) {
    if (field === 'address') {
      const checked = checkAddress(draft.address)
      if (checked.ok) patch.address = checked.value
      else problems.push({ field, message: checked.message })
    } else {
      patch[field] = draft[field]
    }
  }
  if (problems.length > 0) return { patch: undefined, problems }
  const checked = PersonStylePatchSchema.safeParse(patch)
  if (checked.success) return { patch: checked.data, problems: [] }
  const field = dirty.find((f) => f === checked.error.issues[0]?.path[0]) ?? 'gentleTopics'
  return {
    patch: undefined,
    problems: [{ field, message: checked.error.issues[0]?.message ?? 'refused' }],
  }
}
