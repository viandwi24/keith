// The Manage "Persona" section (owner; docs/specs/tui.md, "Persona"). The section is a `SectionData`, so the Manage host draws the
// rows, the action menu and the dialogs, and runs every action through `env.guard`: a save the core refuses for a step-up opens the
// PIN prompt first and then runs again. The actions only call the RPC; they never wrap the guard themselves.
import { watchPersona } from '@keith/client'
import {
  BUILTIN_PERSONA_TEMPLATE_IDS,
  type PersonaBody,
  type PersonaVersion,
  type PersonaView,
} from '@keith/contracts'
import { useCallback, useEffect, useState } from 'react'
import type { ActionSpec, FieldSpec, ManageEnv, Row, SectionData } from '../manage/manage-types.ts'
import {
  PERSONA_FIELD_LABELS,
  PERSONA_FIELDS,
  type PersonaDraft,
  type PersonaField,
  patchOf,
  summaryOf,
  templateChoices,
} from './persona-state.ts'

const HUMOUR_CHOICES = ['none', 'dry', 'warm'] as const

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** A text cut at `max` cells, with an ellipsis, so one field is one line of the section. */
export const clipText = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

/** The date of a version as `2026-11-11 09:41` (UTC): the history reads the same on every machine. */
export const stampOf = (at: number): string =>
  new Date(at).toISOString().slice(0, 16).replace('T', ' ')

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
      : { id: field, label: PERSONA_FIELD_LABELS[field], initial: saved[field], optional: true },
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

/** Manage's "Persona" section: the current persona, its history with restore, the template picker and the field editor. */
export function usePersonaSection(env: ManageEnv): SectionData {
  const { client } = env
  const [loaded, setLoaded] = useState<
    { view: PersonaView; history: PersonaVersion[] } | undefined
  >()
  const [error, setError] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all([client.persona.get(), client.persona.history()]).then(
      ([view, history]) => {
        if (!alive) return
        setLoaded({ view, history })
        setError(undefined)
        setLoading(false)
      },
      (e: unknown) => {
        if (!alive) return
        setError(messageOf(e))
        setLoading(false)
      },
    )
    return () => {
      alive = false
    }
  }, [client, tick])

  // a change made by anyone (another owner session, or this one) reads the persona again
  useEffect(() => watchPersona({ feed: client.feed(), refetch: reload }), [client, reload])

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
        ...(view === undefined || view.templateId === 'custom' ? {} : { initial: view.templateId }),
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
    error,
    loading,
    reload,
  }
}
