// The Manage "Persona" section (owner; docs/specs/tui.md, "Persona"). The section is a section body, so a client draws the rows, the
// action menu and the dialogs, and runs every action through its guard: a save the core refuses for a step-up opens the PIN prompt first
// and then runs again. The actions only call the RPC; they never wrap the guard themselves.
import {
  BUILTIN_PERSONA_TEMPLATE_IDS,
  type PersonaBody,
  type PersonaVersion,
  type PersonaView,
} from '@keith/contracts'
import { stampOf } from './logs-format.ts'
import {
  PERSONA_FIELD_LABELS,
  PERSONA_FIELDS,
  type PersonaDraft,
  type PersonaField,
  patchOf,
  summaryOf,
  templateChoices,
} from './persona-state.ts'
import type { ActionSpec, FieldSpec, Row, SectionEnv, SectionModel } from './types.ts'

/** The fields that hold a few sentences (the web draws a text area for them). */
const LONG_FIELDS: ReadonlySet<PersonaField> = new Set(['tone', 'attitude', 'caresAbout'])
const HUMOUR_CHOICES = ['none', 'dry', 'warm'] as const

/** A text cut at `max` cells, with an ellipsis, so one field is one line of the section. */
export const clipText = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

/** The section's info lines: the summary, then each field's saved text (cut to one line). */
export function personaLinesOf(view: PersonaView): string[] {
  const body = view.body
  const saved: Record<PersonaField, string> = {
    tone: body.tone,
    attitude: body.attitude,
    humour: body.humour,
    addressing: body.addressing,
    caresAbout: body.caresAbout,
    answerFailed: body.lines.answerFailed,
    guestUnavailable: body.lines.guestUnavailable,
  }
  return [
    `persona   ${summaryOf(view)}`,
    ...PERSONA_FIELDS.map(
      (field) => `${PERSONA_FIELD_LABELS[field].padEnd(24)} ${clipText(saved[field], 48)}`,
    ),
  ]
}

/** The draft the edit form starts from: each field at its saved value (the form's own field ids). */
export function editFieldsOf(body: PersonaBody): FieldSpec[] {
  const saved: Record<PersonaField, string> = {
    tone: body.tone,
    attitude: body.attitude,
    humour: body.humour,
    addressing: body.addressing,
    caresAbout: body.caresAbout,
    answerFailed: body.lines.answerFailed,
    guestUnavailable: body.lines.guestUnavailable,
  }
  return PERSONA_FIELDS.map((field) =>
    field === 'humour'
      ? {
          id: field,
          label: PERSONA_FIELD_LABELS[field],
          options: HUMOUR_CHOICES,
          initial: body.humour,
        }
      : {
          id: field,
          label: PERSONA_FIELD_LABELS[field],
          initial: saved[field],
          optional: true,
          ...(LONG_FIELDS.has(field) ? { multiline: true } : {}),
        },
  )
}

/** The values the edit form submits, read back as the persona draft (a missing value keeps the saved one). */
export function draftOfValues(
  body: PersonaBody,
  values: Readonly<Record<string, string>>,
): PersonaDraft {
  const fallback = editFieldsOf(body)
  const draft: Record<string, string> = {}
  for (const field of fallback) draft[field.id] = values[field.id] ?? field.initial ?? ''
  return draft as PersonaDraft
}

/** The history rows: newest first; every version but the current one can be restored (restore writes a new version). */
export function personaRowsOf(
  history: readonly PersonaVersion[],
  current: number,
  actions: (v: number) => ActionSpec[],
): Row[] {
  return [...history]
    .sort((a, b) => b.version - a.version)
    .map((v) => {
      const label = `${v.templateId === 'custom' ? 'custom' : v.templateId} · ${
        v.reason === 'template' ? 'template chosen' : v.reason === 'edit' ? 'edited' : 'restored'
      }`
      return {
        id: `v${v.version}`,
        cells: [
          `${v.version}${v.version === current ? ' (current)' : ''}`,
          label,
          stampOf(v.changedAt),
          v.changedBy,
        ],
        actions: v.version === current ? [] : actions(v.version),
      }
    })
}

/** What the section reads: the saved persona and its history. */
export interface PersonaLoaded {
  view: PersonaView
  history: PersonaVersion[]
}

/** Manage's "Persona" section: the current persona, its history with restore, the template picker and the field editor. */
export function personaSection(env: SectionEnv): SectionModel<PersonaLoaded> {
  const { client } = env
  return {
    load: async () => {
      const [view, history] = await Promise.all([client.persona.get(), client.persona.history()])
      return { view, history }
    },
    build: (loaded) => {
      const view = loaded?.view
      const restore = (version: number): ActionSpec => ({
        id: `persona.restore.${version}`,
        label: `Restore version ${version}`,
        hint: 'writes a new version',
        confirm: { text: `Restore version ${version} as a new version of the persona?` },
        run: async () => {
          const next = await client.persona.restore({ version })
          return { message: `Restored version ${version} as version ${next.version}.` }
        },
      })
      const template: ActionSpec = {
        id: 'persona.template',
        label: 'Choose template',
        hint: BUILTIN_PERSONA_TEMPLATE_IDS.join(' · '),
        fields: [
          {
            id: 'templateId',
            label: 'Template',
            options: templateChoices(),
            ...(view === undefined || view.templateId === 'custom'
              ? {}
              : { initial: view.templateId }),
          },
        ],
        run: async (values) => {
          const templateId = BUILTIN_PERSONA_TEMPLATE_IDS.find((t) => t === values.templateId)
          if (templateId === undefined) throw new Error('choose one of the built-in templates')
          const next = await client.persona.setTemplate({ templateId })
          return { message: `Persona is now ${summaryOf(next)}.` }
        },
      }
      const edit: ActionSpec = {
        id: 'persona.edit',
        label: 'Edit persona',
        hint: 'fields and the two fixed lines',
        fields: view === undefined ? [] : editFieldsOf(view.body),
        run: async (values) => {
          if (view === undefined) throw new Error('the persona is not loaded yet')
          const { patch, problems } = patchOf(view.body, draftOfValues(view.body, values))
          if (problems.length > 0)
            throw new Error(
              problems.map((p) => `${PERSONA_FIELD_LABELS[p.field]}: ${p.message}`).join('; '),
            )
          if (patch === undefined) return { message: 'Nothing changed.' }
          const next = await client.persona.edit({ patch })
          return { message: `Persona saved · version ${next.version}.` }
        },
      }
      return {
        lines: view === undefined ? [] : personaLinesOf(view),
        header: ['ver', 'change', 'when (UTC)', 'by'],
        widths: [14, 28, 18],
        rows:
          loaded === undefined
            ? []
            : personaRowsOf(loaded.history, loaded.view.version, (v) => [restore(v)]),
        empty: 'No history yet.',
        actions: view === undefined ? [] : [template, edit],
      }
    },
  }
}
