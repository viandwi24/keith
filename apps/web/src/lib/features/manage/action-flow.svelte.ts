import {
  type ActionSpec,
  clearSecrets,
  confirmReady,
  type Dialog,
  missingField,
  type NoteSpec,
  needsDialog,
  openAction,
  setValue,
  submitValues,
} from '@keith/app-model/manage'
import { isStepUpCancelled, stepUp } from '../stepup/index.ts'
import { toasts } from '../toasts/index.ts'

/**
 * What happens when a person picks an action of a section: no dialog for a plain one, a form for its fields, a confirmation for a
 * destructive one (the word to type when the action asks for it). The call runs through the step-up guard; a secret leaves the dialog's
 * state the moment it is sent, and a note shown once is dropped when it is closed.
 */
export class ActionFlow {
  dialog = $state.raw<Dialog | undefined>(undefined)
  note = $state.raw<NoteSpec | undefined>(undefined)
  /** The form was submitted once: every required field shows its problem. */
  attempted = $state(false)

  constructor(private readonly done: () => void) {}

  start(action: ActionSpec): void {
    this.attempted = false
    if (!needsDialog(action)) {
      void this.execute(action, {})
      return
    }
    this.dialog = openAction(action)
  }

  set(id: string, value: string): void {
    if (this.dialog !== undefined) this.dialog = setValue(this.dialog, id, value)
  }

  type(typed: string): void {
    const d = this.dialog
    if (d?.kind === 'confirm') this.dialog = { ...d, typed, error: undefined }
  }

  async submit(): Promise<void> {
    const d = this.dialog
    if (d === undefined || d.kind === 'note' || d.kind === 'menu' || d.busy) return
    if (d.kind === 'confirm') {
      if (!confirmReady(d.action, d.typed)) return
      await this.execute(d.action, {})
      return
    }
    this.attempted = true
    const missing = missingField(d.action.fields ?? [], d.values)
    if (missing !== undefined) {
      this.dialog = { ...d, error: missing }
      return
    }
    await this.execute(d.action, submitValues(d))
  }

  /** Close the dialog (not while a call is out); the secrets it held go with it. */
  cancel(): void {
    const d = this.dialog
    if (d === undefined || (d.kind !== 'note' && d.kind !== 'menu' && d.busy)) return
    // dropping the dialog drops its values, the secrets with them
    this.dialog = undefined
  }

  closeNote(): void {
    this.note = undefined
  }

  private async execute(action: ActionSpec, values: Record<string, string>): Promise<void> {
    const before = this.dialog
    // the secrets leave state now; the call keeps its own copy until it settles
    if (before?.kind === 'form')
      this.dialog = { ...(clearSecrets(before) as typeof before), busy: true }
    else if (before?.kind === 'confirm') this.dialog = { ...before, busy: true }
    try {
      const out = await stepUp.guard(() => action.run(values))
      this.dialog = undefined
      if (out?.message !== undefined) toasts.push(out.message, { level: 'success' })
      if (out?.note !== undefined) this.note = out.note
    } catch (error) {
      const text = isStepUpCancelled(error)
        ? 'Not confirmed.'
        : error instanceof Error
          ? error.message
          : String(error)
      const current = this.dialog
      if (current?.kind === 'form') this.dialog = { ...current, busy: false, error: text }
      else if (current?.kind === 'confirm') this.dialog = { ...current, busy: false, error: text }
      else toasts.push(text, { level: isStepUpCancelled(error) ? 'warning' : 'error' })
    }
    // a refused or conflicting call may have changed the core: read the rows again either way
    this.done()
  }
}
