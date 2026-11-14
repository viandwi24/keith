// The persona and the per-person style of the prefrontal region (docs/specs/prefrontal.md, ADR-0029). Re-exported by
// area-runtime.ts. The shapes a person sees and the RPC input and output schemas; the procedures are declared in
// contract.ts. The persona is global and owner-edited; the style is the person's own and never changes a right (ADR-0020 §2).
import { z } from 'zod'

export const PERSONA_TEXT_MAX = 300
export const PERSONA_ADDRESSING_MAX = 200
export const PERSONA_LINE_MAX = 120
export const PERSONA_NOTE_MAX = 200
export const PERSONA_GENTLE_TOPICS_MAX = 5
export const PERSONA_ADDRESS_MAX = 40

/** The humour levels of a persona (ADR-0029 §2). */
export const PersonaHumourSchema = z.enum(['none', 'dry', 'warm'])
export type PersonaHumour = z.infer<typeof PersonaHumourSchema>

/** The built-in templates: data in code, never changed after release (prefrontal.md, "Templates"). */
export const BUILTIN_PERSONA_TEMPLATE_IDS = ['butler', 'friend', 'professional'] as const
export const PersonaTemplateSchema = z.enum(BUILTIN_PERSONA_TEMPLATE_IDS)
export type PersonaTemplate = z.infer<typeof PersonaTemplateSchema>

/** The template a persona carries: a built-in id, or `custom` after an owner edit. */
export const PersonaTemplateIdSchema = z.enum([...BUILTIN_PERSONA_TEMPLATE_IDS, 'custom'])
export type PersonaTemplateId = z.infer<typeof PersonaTemplateIdSchema>

/** The two fixed lines a persona gives: the answer failed, and the guest service is unavailable. Each never claims success. */
export const PersonaLinesSchema = z.object({
  answerFailed: z.string().min(1).max(PERSONA_LINE_MAX),
  guestUnavailable: z.string().min(1).max(PERSONA_LINE_MAX),
})
export type PersonaLines = z.infer<typeof PersonaLinesSchema>

/**
 * The persona body: the document the owner chooses or edits. The name "Keith" and the core rules are not fields
 * (ADR-0029 §2), so no template or edit can change them.
 */
export const PersonaBodySchema = z.object({
  tone: z.string().max(PERSONA_TEXT_MAX),
  attitude: z.string().max(PERSONA_TEXT_MAX),
  humour: PersonaHumourSchema,
  addressing: z.string().max(PERSONA_ADDRESSING_MAX),
  caresAbout: z.string().max(PERSONA_TEXT_MAX),
  lines: PersonaLinesSchema,
})
export type PersonaBody = z.infer<typeof PersonaBodySchema>

/** An owner edit: any subset of the body. An empty patch is refused. */
export const PersonaPatchSchema = z
  .object({
    tone: z.string().max(PERSONA_TEXT_MAX).optional(),
    attitude: z.string().max(PERSONA_TEXT_MAX).optional(),
    humour: PersonaHumourSchema.optional(),
    addressing: z.string().max(PERSONA_ADDRESSING_MAX).optional(),
    caresAbout: z.string().max(PERSONA_TEXT_MAX).optional(),
    lines: z
      .object({
        answerFailed: z.string().min(1).max(PERSONA_LINE_MAX).optional(),
        guestUnavailable: z.string().min(1).max(PERSONA_LINE_MAX).optional(),
      })
      .optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'empty patch' })
export type PersonaPatch = z.infer<typeof PersonaPatchSchema>

/** Why a version was written: a template chosen, an edit, or a restore of an older version. */
export const PersonaVersionReasonSchema = z.enum(['template', 'edit', 'restore'])
export type PersonaVersionReason = z.infer<typeof PersonaVersionReasonSchema>

/** One row of the persona history (`persona_versions`). The history is kept; nothing is pruned. */
export const PersonaVersionSchema = z.object({
  version: z.number().int().min(1),
  templateId: PersonaTemplateIdSchema,
  body: PersonaBodySchema,
  reason: PersonaVersionReasonSchema,
  changedBy: z.string().min(1),
  changedAt: z.number(),
  note: z.string().max(PERSONA_NOTE_MAX).nullable(),
})
export type PersonaVersion = z.infer<typeof PersonaVersionSchema>

/** The current persona as every person who can chat reads it (`persona.get`). */
export const PersonaViewSchema = z.object({
  version: z.number().int().min(1),
  templateId: PersonaTemplateIdSchema,
  body: PersonaBodySchema,
  updatedAt: z.number(),
})
export type PersonaView = z.infer<typeof PersonaViewSchema>

/** The delivery modes of ADR-0029 §5, chosen in code from the channel and the request kind. */
export const PersonaModeSchema = z.enum(['speech', 'chat', 'screen', 'report'])
export type PersonaMode = z.infer<typeof PersonaModeSchema>

/** `persona.setTemplate`: a built-in template id (never `custom`). */
export const PersonaSetTemplateInputSchema = z.object({ templateId: PersonaTemplateSchema })
export type PersonaSetTemplateInput = z.infer<typeof PersonaSetTemplateInputSchema>

/** `persona.edit`: the owner's patch of the body. */
export const PersonaEditInputSchema = z.object({ patch: PersonaPatchSchema })
export type PersonaEditInput = z.infer<typeof PersonaEditInputSchema>

/** `persona.restore`: a version of the history; the restore writes a new version. */
export const PersonaRestoreInputSchema = z.object({ version: z.number().int().min(1) })
export type PersonaRestoreInput = z.infer<typeof PersonaRestoreInputSchema>

/** The languages a person may fix for Keith's replies, a fixed BCP 47 list; `auto` follows the message. */
export const STYLE_LANGUAGES = [
  'en-US',
  'id-ID',
  'es-ES',
  'fr-FR',
  'de-DE',
  'pt-BR',
  'nl-NL',
  'ja-JP',
  'ko-KR',
  'zh-CN',
  'ar',
  'hi-IN',
] as const
export const StyleLanguageSchema = z.enum(['auto', ...STYLE_LANGUAGES])
export type StyleLanguage = z.infer<typeof StyleLanguageSchema>

export const StyleBrevitySchema = z.enum(['short', 'normal', 'full'])
export type StyleBrevity = z.infer<typeof StyleBrevitySchema>

export const StyleFormalitySchema = z.enum(['casual', 'neutral', 'formal'])
export type StyleFormality = z.infer<typeof StyleFormalitySchema>

/** The topics Keith treats gently (a closed list, ADR-0029 §3). */
export const GENTLE_TOPICS = ['money', 'health', 'family', 'work', 'loss'] as const
export const GentleTopicSchema = z.enum(GENTLE_TOPICS)
export type GentleTopic = z.infer<typeof GentleTopicSchema>

/**
 * Words a name may never carry: a directive in an address would read as an instruction (ADR-0029 §3). The check is a
 * guard, not the boundary: the style layer sits under the core rules.
 */
export const ADDRESS_DENY_WORDS: readonly string[] = [
  'never',
  'always',
  'ignore',
  'refuse',
  'pretend',
  'forget',
  'reveal',
  'skip',
  'bypass',
  'instead',
  'rule',
  'rules',
  'must',
]

const ADDRESS_SHAPE = /^[\p{L} '-]{1,40}$/u
/** An address is a name: at most four words. Words are split on spaces, so `Mary-Jane` and `O'Neil` count as one word each. */
const ADDRESS_MAX_WORDS = 4

/**
 * The shared check of an address (the name Keith uses for a person): the name shape (letters, spaces, `-`, `'`, at most 40
 * characters, not blank), at most four words (a sentence is not a name, FR3-03), and no deny word as a whole word,
 * case-insensitive. The core and the TUI call the same function.
 */
export function validateAddress(value: string): boolean {
  if (!ADDRESS_SHAPE.test(value) || value.trim().length === 0) return false
  if (value.trim().split(/\s+/).length > ADDRESS_MAX_WORDS) return false
  const denied = new Set(ADDRESS_DENY_WORDS)
  const words = value.toLowerCase().split(/[^\p{L}]+/u)
  return !words.some((word) => denied.has(word))
}

/** An address as a schema: the shared check, so a refused address is `not-a-style-value` everywhere. */
export const AddressSchema = z.string().refine(validateAddress, { message: 'not-a-style-value' })

/** The style of one person as Keith reads it. `address` null means "the name in the profile". */
export const PersonStyleSchema = z.object({
  address: z.string().nullable(),
  language: StyleLanguageSchema,
  brevity: StyleBrevitySchema,
  formality: StyleFormalitySchema,
  gentleTopics: z.array(GentleTopicSchema).max(PERSONA_GENTLE_TOPICS_MAX),
})
export type PersonStyle = z.infer<typeof PersonStyleSchema>

/** The style of a person with no row (`person_style` absent): every field at its default. */
export const DEFAULT_PERSON_STYLE: PersonStyle = {
  address: null,
  language: 'auto',
  brevity: 'normal',
  formality: 'neutral',
  gentleTopics: [],
}

/** The style fields a change names. Values never leave the core in an event: only these names do. */
export const PERSON_STYLE_FIELDS = [
  'address',
  'language',
  'brevity',
  'formality',
  'gentleTopics',
] as const
export const PersonStyleFieldSchema = z.enum(PERSON_STYLE_FIELDS)
export type PersonStyleField = z.infer<typeof PersonStyleFieldSchema>

/** `persona.style.set`: any subset of the style; `address: null` clears it. An empty patch is refused. */
export const PersonStylePatchSchema = z
  .object({
    address: AddressSchema.nullable().optional(),
    language: StyleLanguageSchema.optional(),
    brevity: StyleBrevitySchema.optional(),
    formality: StyleFormalitySchema.optional(),
    gentleTopics: z
      .array(GentleTopicSchema)
      .max(PERSONA_GENTLE_TOPICS_MAX)
      .refine((topics) => new Set(topics).size === topics.length, { message: 'repeated topic' })
      .optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'empty patch' })
export type PersonStylePatch = z.infer<typeof PersonStylePatchSchema>

export const PersonaStyleSetInputSchema = z.object({ patch: PersonStylePatchSchema })
export type PersonaStyleSetInput = z.infer<typeof PersonaStyleSetInputSchema>

/** `persona.style.read` (owner, audited): the person whose style is read. */
export const PersonaStyleReadInputSchema = z.object({ personId: z.string().min(1).max(100) })
export type PersonaStyleReadInput = z.infer<typeof PersonaStyleReadInputSchema>

/** The activity-feed type of a persona change: one global record with no text (prefrontal.md, "Audit, removal, feed"). */
export const PERSONA_CHANGED = 'persona.changed' as const

/** Payload of `persona.changed`: the new version and why it changed. Holds no persona text. */
export const PersonaChangedRecordSchema = z.object({
  version: z.number().int().min(1),
  reason: PersonaVersionReasonSchema,
})
export type PersonaChangedRecord = z.infer<typeof PersonaChangedRecordSchema>
