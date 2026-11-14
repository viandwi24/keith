import { Dialog, Field, G, ListRow, Notice, PulseGlyph, Txt } from '@keith/ui'
import { Box } from 'ink'
import type { Dialog as DialogState } from './dialog-state.ts'
import type { ActionSpec, NoteSpec } from './manage-types.ts'

type Of<K extends DialogState['kind']> = Extract<DialogState, { kind: K }>

/** Columns of a dialog's rows: the frame's two sides and one column of padding on each. */
const innerOf = (width: number): number => Math.max(10, width - 4)

/** The row a dialog shows while its action runs (its keys are off). */
function Working() {
  return (
    <Box>
      <PulseGlyph />
      <Txt tone="muted"> working</Txt>
    </Box>
  )
}

/** A failure inside a dialog: one glyph-led row, never a second frame. */
const Failure = ({ text }: { text: string }) => (
  <Box marginTop={1}>
    <Notice level="error" rows={[text]} />
  </Box>
)

/** The actions that apply to the selected row (and the section), one per line. */
export function MenuDialog({ dialog, width }: { dialog: Of<'menu'>; width: number }) {
  return (
    <Dialog title="Actions" focused={false} tone="none" flush width={width}>
      {dialog.actions.map((a: ActionSpec, i) => (
        <ListRow
          key={a.id + a.label}
          selected={i === dialog.index}
          width={innerOf(width)}
          columns={[
            { text: a.label, width: Math.min(24, Math.max(8, innerOf(width) - 14)) },
            { text: a.hint ?? '', flex: true, tone: 'muted' },
          ]}
        />
      ))}
    </Dialog>
  )
}

export interface FormDialogProps {
  dialog: Of<'form'>
  width: number
  onChange(id: string, value: string): void
  /** Enter in a text field: the field's text, since keys can outrun the render. */
  onSubmit(id: string, value: string): void
}

/** An action form: one row per field, the focused one is live. Secrets are hidden. */
export function FormDialog({ dialog, width, onChange, onSubmit }: FormDialogProps) {
  const fields = dialog.action.fields ?? []
  const inner = innerOf(width)
  return (
    <Dialog title={dialog.action.label} focused={false} tone="none" flush width={width}>
      {fields.map((f, i) => (
        <Field
          key={f.id}
          label={f.label}
          value={dialog.values[f.id] ?? ''}
          focused={i === dialog.focus && !dialog.busy}
          width={inner}
          secret={f.secret === true}
          {...(f.options === undefined ? {} : { options: f.options })}
          {...(f.placeholder === undefined ? {} : { placeholder: f.placeholder })}
          onChange={(v) => onChange(f.id, v)}
          onSubmit={(v) => onSubmit(f.id, v)}
        />
      ))}
      {dialog.busy === true && <Working />}
      {dialog.error !== undefined && <Failure text={dialog.error} />}
    </Dialog>
  )
}

export interface ConfirmDialogProps {
  dialog: Of<'confirm'>
  width: number
  onChange(value: string): void
  onSubmit(value: string): void
}

/** Ask before a destructive action. A word to type (transfer owner) or `y`. */
export function ConfirmDialog({ dialog, width, onChange, onSubmit }: ConfirmDialogProps) {
  const confirm = dialog.action.confirm
  const word = confirm?.type
  return (
    <Dialog title={dialog.action.label} focused tone="warning" flush width={width}>
      <Txt tone="warning">{`${G.warn} ${confirm?.text ?? ''}`}</Txt>
      {word !== undefined && (
        <Box flexDirection="column" marginTop={1}>
          <Txt tone="muted">{`Type ${word} to confirm.`}</Txt>
          <Field
            label="Username"
            value={dialog.typed}
            focused={!dialog.busy}
            width={innerOf(width)}
            onChange={onChange}
            onSubmit={onSubmit}
          />
        </Box>
      )}
      {dialog.busy === true && <Working />}
      {dialog.error !== undefined && <Failure text={dialog.error} />}
    </Dialog>
  )
}

/** A result to read: a token or pairing code is shown once. */
export function NoteDialog({ note, width }: { note: NoteSpec; width: number }) {
  return (
    <Dialog title={note.title} focused={false} tone="none" flush width={width}>
      {note.once === true && (
        <Txt tone="warning">{`${G.warn} Shown once. Copy it now: it cannot be shown again.`}</Txt>
      )}
      <Box flexDirection="column" marginTop={note.once === true ? 1 : 0}>
        {note.lines.map((line, i) => (
          <Txt
            key={i}
            {...(i === 0 && note.once === true ? { bold: true, tone: 'accent' as const } : {})}
          >
            {line}
          </Txt>
        ))}
      </Box>
    </Dialog>
  )
}
