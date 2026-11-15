// The persona screen's state, as plain functions (docs/specs/tui.md, "Persona"). The owner edits a draft of the body, the screen shows the
// template, the text and the history, and a save sends only the fields that differ from the saved persona. Every limit is the contract's
// (`PersonaPatchSchema`), so the form refuses what the core refuses. No React and no I/O here.
import {
  BUILTIN_PERSONA_TEMPLATE_IDS,
  PERSONA_ADDRESSING_MAX,
  PERSONA_LINE_MAX,
  PERSONA_TEXT_MAX,
  type PersonaBody,
  PersonaHumourSchema,
  type PersonaPatch,
  PersonaPatchSchema,
  type PersonaTemplate,
  type PersonaVersion,
  type PersonaVersionReason,
  type PersonaView,
} from '@keith/contracts'

/** The editable fields of the persona, in the order the form shows them. `answerFailed` and `guestUnavailable` are the two fixed lines. */
export const PERSONA_FIELDS = [
  'tone',
  'attitude',
  'humour',
  'addressing',
  'caresAbout',
  'answerFailed',
  'guestUnavailable',
] as const
export type PersonaField = (typeof PERSONA_FIELDS)[number]

export const PERSONA_FIELD_LABELS: Record<PersonaField, string> = {
  tone: 'Tone',
  attitude: 'Attitude',
  humour: 'Humour',
  addressing: 'Addressing',
  caresAbout: 'Cares about',
  answerFailed: 'Line: failed answer',
  guestUnavailable: 'Line: guest unavailable',
}

/** The longest text one field may hold (the contract's limit for that field). */
export const PERSONA_FIELD_MAX: Partial<Record<PersonaField, number>> = {
  tone: PERSONA_TEXT_MAX,
  attitude: PERSONA_TEXT_MAX,
  addressing: PERSONA_ADDRESSING_MAX,
  caresAbout: PERSONA_TEXT_MAX,
  answerFailed: PERSONA_LINE_MAX,
  guestUnavailable: PERSONA_LINE_MAX,
}

/** The draft: every field as the form holds it (the humour as its enum word). */
export type PersonaDraft = Record<PersonaField, string>

/** The draft of a saved body: every field starts at its saved value. */
export function draftOf(body: PersonaBody): PersonaDraft {
  return {
    tone: body.tone,
    attitude: body.attitude,
    humour: body.humour,
    addressing: body.addressing,
    caresAbout: body.caresAbout,
    answerFailed: body.lines.answerFailed,
    guestUnavailable: body.lines.guestUnavailable,
  }
}

/** One field of the draft changed. */
export function setDraftField(
  draft: PersonaDraft,
  field: PersonaField,
  value: string,
): PersonaDraft {
  return { ...draft, [field]: value }
}

/** The fields whose draft differs from the saved body, in form order. */
export function dirtyFieldsOf(body: PersonaBody, draft: PersonaDraft): PersonaField[] {
  const saved = draftOf(body)
  return PERSONA_FIELDS.filter((field) => draft[field] !== saved[field])
}

/** A problem with one field of the draft, as the form shows it under the field. */
export interface PersonaProblem {
  field: PersonaField
  message: string
}

/**
 * The patch a save sends: only the dirty fields, in the shape of `persona.edit`. `undefined` when nothing changed (the save is off).
 * The patch is the one `PersonaPatchSchema` checks, so a value the core would refuse is reported here as a problem and the patch is
 * not built (`problems` is then not empty).
 */
export function patchOf(
  body: PersonaBody,
  draft: PersonaDraft,
): { patch: PersonaPatch | undefined; problems: PersonaProblem[] } {
  const dirty = dirtyFieldsOf(body, draft)
  if (dirty.length === 0) return { patch: undefined, problems: [] }
  const patch: Record<string, unknown> = {}
  const lines: Record<string, string> = {}
  for (const field of dirty) {
    if (field === 'answerFailed' || field === 'guestUnavailable') lines[field] = draft[field]
    else if (field === 'humour') patch.humour = draft.humour
    else patch[field] = draft[field]
  }
  if (Object.keys(lines).length > 0) patch.lines = lines
  const checked = PersonaPatchSchema.safeParse(patch)
  if (checked.success) return { patch: checked.data, problems: [] }
  return { patch: undefined, problems: problemsOf(checked.error.issues) }
}

/** The form's problems from the schema's issues: a line left empty, a text over its limit, a humour that is not one of the words. */
function problemsOf(
  issues: readonly { path: PropertyKey[]; code: string; message: string }[],
): PersonaProblem[] {
  const out: PersonaProblem[] = []
  for (const issue of issues) {
    const name = issue.path[issue.path.length - 1]
    const field = PERSONA_FIELDS.find((f) => f === name)
    if (field === undefined) continue
    const message =
      field === 'humour'
        ? `choose one of: ${PersonaHumourSchema.options.join(', ')}`
        : issue.code === 'too_small'
          ? 'cannot be empty'
          : `at most ${PERSONA_FIELD_MAX[field]} characters`
    out.push({ field, message })
  }
  return out
}

/** A built-in template the owner can choose (never `custom`). */
export function templateChoices(): readonly PersonaTemplate[] {
  return BUILTIN_PERSONA_TEMPLATE_IDS
}

/** The one-line summary of the persona: `professional · version 3`, or `custom (edited) · version 4` after an owner edit. */
export function summaryOf(view: Pick<PersonaView, 'templateId' | 'version'>): string {
  const template = view.templateId === 'custom' ? 'custom (edited)' : view.templateId
  return `${template} · version ${view.version}`
}

const REASON_LABEL: Record<PersonaVersionReason, string> = {
  template: 'template chosen',
  edit: 'edited',
  restore: 'restored',
}

/** One row of the history, newest first. `restorable` is every version but the current one (restore writes a new version). */
export interface PersonaHistoryRow {
  version: number
  label: string
  reason: PersonaVersionReason
  changedBy: string
  changedAt: number
  current: boolean
  restorable: boolean
}

export function historyRowsOf(
  versions: readonly PersonaVersion[],
  currentVersion: number,
): PersonaHistoryRow[] {
  return [...versions]
    .sort((a, b) => b.version - a.version)
    .map((v) => ({
      version: v.version,
      label: `${v.templateId === 'custom' ? 'custom' : v.templateId} · ${REASON_LABEL[v.reason]}`,
      reason: v.reason,
      changedBy: v.changedBy,
      changedAt: v.changedAt,
      current: v.version === currentVersion,
      restorable: v.version !== currentVersion,
    }))
}

/** The whole state of the screen: what it shows, the draft, what changed and what a save would send. */
export interface PersonaScreenState {
  summary: string
  templateId: PersonaView['templateId']
  version: number
  /** The saved body's text by field (what the form shows when nothing is being edited). */
  saved: PersonaDraft
  draft: PersonaDraft
  dirty: PersonaField[]
  problems: PersonaProblem[]
  /** The patch a save sends, or `undefined` when there is nothing to save or a field is refused. */
  patch: PersonaPatch | undefined
  history: PersonaHistoryRow[]
}

/** The screen state from the saved view, its history and the owner's draft (`draft` defaults to the saved body). */
export function personaScreenOf(input: {
  view: PersonaView
  history: readonly PersonaVersion[]
  draft?: PersonaDraft
}): PersonaScreenState {
  const saved = draftOf(input.view.body)
  const draft = input.draft ?? saved
  const { patch, problems } = patchOf(input.view.body, draft)
  return {
    summary: summaryOf(input.view),
    templateId: input.view.templateId,
    version: input.view.version,
    saved,
    draft,
    dirty: dirtyFieldsOf(input.view.body, draft),
    problems,
    patch,
    history: historyRowsOf(input.history, input.view.version),
  }
}
