import type { ActionSpec, FieldSpec, NoteSpec } from './types.ts'

export type Dialog =
  | { kind: 'menu'; actions: readonly ActionSpec[]; index: number }
  | {
      kind: 'form'
      action: ActionSpec
      values: Record<string, string>
      focus: number
      error: string | undefined
      busy: boolean
    }
  | { kind: 'confirm'; action: ActionSpec; typed: string; error: string | undefined; busy: boolean }
  | { kind: 'note'; note: NoteSpec }

/** An action with neither fields nor a confirmation runs at once, with no dialog. */
export const needsDialog = (action: ActionSpec): boolean =>
  (action.fields?.length ?? 0) > 0 || action.confirm !== undefined

export const initialValues = (fields: readonly FieldSpec[] = []): Record<string, string> =>
  Object.fromEntries(fields.map((f) => [f.id, f.initial ?? f.options?.[0] ?? '']))

/** The dialog an action opens (call only when `needsDialog`). */
export function openAction(action: ActionSpec): Dialog {
  if (action.confirm !== undefined)
    return { kind: 'confirm', action, typed: '', error: undefined, busy: false }
  return {
    kind: 'form',
    action,
    values: initialValues(action.fields),
    focus: 0,
    error: undefined,
    busy: false,
  }
}

export const openMenu = (actions: readonly ActionSpec[]): Dialog | undefined =>
  actions.length === 0 ? undefined : { kind: 'menu', actions, index: 0 }

export function menuMove(d: Dialog, key: 'up' | 'down'): Dialog {
  if (d.kind !== 'menu') return d
  const last = d.actions.length - 1
  return { ...d, index: Math.min(last, Math.max(0, d.index + (key === 'up' ? -1 : 1))) }
}

const fieldsOf = (d: Dialog): readonly FieldSpec[] =>
  d.kind === 'form' ? (d.action.fields ?? []) : []

/** Move the focus between the fields of a form (it stops at both ends). */
export function focusMove(d: Dialog, key: 'up' | 'down'): Dialog {
  if (d.kind !== 'form') return d
  const last = fieldsOf(d).length - 1
  return { ...d, focus: Math.min(last, Math.max(0, d.focus + (key === 'up' ? -1 : 1))) }
}

export function setValue(d: Dialog, id: string, value: string): Dialog {
  if (d.kind !== 'form') return d
  return { ...d, values: { ...d.values, [id]: value }, error: undefined }
}

/** Cycle the choice of the focused field (`←` `→`, space). A text field is left alone. */
export function cycleOption(d: Dialog, step: 1 | -1): Dialog {
  if (d.kind !== 'form') return d
  const field = fieldsOf(d)[d.focus]
  if (field?.options === undefined || field.options.length === 0) return d
  const at = Math.max(0, field.options.indexOf(d.values[field.id] ?? ''))
  const next = field.options[(at + step + field.options.length) % field.options.length] ?? ''
  return setValue(d, field.id, next)
}

/** The first required field that is empty, as a sentence; `undefined` when the form may go. */
export function missingField(
  fields: readonly FieldSpec[],
  values: Readonly<Record<string, string>>,
): string | undefined {
  const bad = fields.find((f) => f.optional !== true && (values[f.id] ?? '').trim() === '')
  return bad === undefined ? undefined : `${bad.label} is required`
}

/** The confirm may go: nothing to type, or the typed word matches. */
export const confirmReady = (action: ActionSpec, typed: string): boolean =>
  action.confirm?.type === undefined || typed === action.confirm.type

/** The same dialog with every secret value dropped (after a submit, or when it fails). */
export function clearSecrets(d: Dialog): Dialog {
  if (d.kind !== 'form') return d
  const secret = new Set((d.action.fields ?? []).filter((f) => f.secret).map((f) => f.id))
  const values = Object.fromEntries(Object.entries(d.values).filter(([id]) => !secret.has(id)))
  return { ...d, values }
}

/** The values to send: every field, secret ones included (the dialog itself is cleared right after). */
export const submitValues = (d: Dialog): Record<string, string> =>
  d.kind === 'form' ? { ...d.values } : {}
