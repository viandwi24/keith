import { FramePanel, type FrameTag, type Hint, windowOf } from '@keith/ui'
import { useEffect, useRef, useState } from 'react'
import { useGuardedInput as useInput } from '../activity/index.ts'
import {
  clearSecrets,
  confirmReady,
  cycleOption,
  type Dialog,
  focusMove,
  menuMove,
  missingField,
  needsDialog,
  openAction,
  openMenu,
  setValue,
  submitValues,
} from './dialog-state.ts'
import { ConfirmDialog, FormDialog, MenuDialog, NoteDialog } from './dialogs.tsx'
import { dialogHints, rowHints } from './legend.ts'
import { clampRow, moveRow } from './manage-state.ts'
import type { ActionSpec, ManageEnv, SectionDef } from './manage-types.ts'
import { SectionView } from './section-view.tsx'

export interface SectionHostProps {
  section: SectionDef
  env: ManageEnv
  /** Cells of the pane, its frame included; `height` is the rows its frame may take. */
  width: number
  height: number
  /** The frame of the pane: the section's title as its label, `2/8` at the right, a muted tag below. */
  count?: string
  bottom?: string
  /** Two panes (the section list stands at the left): `tab` goes back to the list. */
  wide: boolean
  /** The content pane has the keys. */
  focus: boolean
  /** The screen is on and no step-up prompt covers it. */
  active: boolean
  /** The screen's one legend: the section says what its keys are now. */
  onLegend(hints: readonly Hint[]): void
  onNav(key: 'tab' | 'left' | 'right'): void
  onClose(): void
}

type Said = { level: 'info' | 'warning' | 'error'; text: string }

const HELP_ROWS = [
  '↑↓ select a row · enter lists what you can do with it',
  'n runs the first action · r reads the list again',
  'tab moves between the section list and the rows',
  'In a form: tab or ↑↓ change field, ← → a choice,',
  'enter next or submit, esc cancels. esc goes back.',
]

const failure = (error: unknown): Said => {
  const text = error instanceof Error ? error.message : String(error)
  const cancelled = error instanceof Error && error.name === 'StepUpCancelled'
  return { level: cancelled ? 'warning' : 'error', text }
}

/** One section: its rows, the action menu and the dialogs. Owns the keys while it has the focus. */
export function SectionHost({
  section,
  env,
  width,
  height,
  focus,
  active,
  count,
  bottom,
  wide,
  onLegend,
  onNav,
  onClose,
}: SectionHostProps) {
  const data = section.use(env)
  const [selected, setSelected] = useState(0)
  const [dialog, setDialogState] = useState<Dialog | undefined>()
  const [said, setSaid] = useState<Said | undefined>()
  const [working, setWorking] = useState(false)
  const [help, setHelp] = useState(false)
  // keys can arrive faster than renders: handlers read the dialog from a ref
  const ref = useRef<Dialog | undefined>(undefined)
  const setDialog = (next: Dialog | undefined): void => {
    ref.current = next
    setDialogState(next)
  }
  const busy = useRef(false)
  const reloadRef = useRef(data.reload)
  reloadRef.current = data.reload

  const rows = data.rows
  const at = clampRow(selected, rows.length)
  const row = rows[at]
  const menu = (): readonly ActionSpec[] => [...(row?.actions ?? []), ...data.actions]

  const execute = async (action: ActionSpec, values: Record<string, string>): Promise<void> => {
    if (busy.current) return
    busy.current = true
    setWorking(true)
    const before = ref.current
    // the secrets leave state now; the call keeps its own copy until it settles
    if (before !== undefined && before.kind === 'form')
      setDialog({ ...(clearSecrets(before) as typeof before), busy: true })
    else if (before !== undefined && before.kind === 'confirm') setDialog({ ...before, busy: true })
    try {
      const out = await env.guard(() => action.run(values))
      busy.current = false
      setWorking(false)
      setSaid(out?.message === undefined ? undefined : { level: 'info', text: out.message })
      setDialog(out?.note === undefined ? undefined : { kind: 'note', note: out.note })
      reloadRef.current()
    } catch (error) {
      busy.current = false
      setWorking(false)
      const current = ref.current
      const failed = failure(error)
      if (current !== undefined && current.kind === 'form') {
        // the secrets are gone: put the focus back on the first one so they can be typed again
        const secret = (current.action.fields ?? []).findIndex((f) => f.secret === true)
        setDialog({ ...current, busy: false, error: failed.text, focus: Math.max(0, secret) })
      } else if (current !== undefined && current.kind === 'confirm')
        setDialog({ ...current, busy: false, error: failed.text })
      else {
        setDialog(undefined)
        setSaid(failed)
      }
      // a refused or conflicting call may have changed the core: read the rows again
      reloadRef.current()
    }
  }

  const start = (action: ActionSpec): void => {
    if (!needsDialog(action)) {
      setDialog(undefined)
      void execute(action, {})
      return
    }
    setDialog(openAction(action))
  }

  const submitForm = (d: Extract<Dialog, { kind: 'form' }>): void => {
    const missing = missingField(d.action.fields ?? [], d.values)
    if (missing !== undefined) setDialog({ ...d, error: missing })
    else void execute(d.action, submitValues(d))
  }

  /** Enter in a field: store its text, go to the next field, or submit from the last one. */
  const advance = (id: string, value: string): void => {
    const current = ref.current
    if (current === undefined || current.kind !== 'form' || current.busy) return
    const d = setValue(current, id, value) as typeof current
    const last = (d.action.fields?.length ?? 0) - 1
    if (d.focus < last) {
      setDialog(focusMove(d, 'down'))
      return
    }
    setDialog(d)
    submitForm(d)
  }

  useInput(
    (input, key) => {
      const d = ref.current
      if (working || (d !== undefined && 'busy' in d && d.busy)) return
      if (d === undefined) {
        if (key.escape) return help ? setHelp(false) : onClose()
        if (key.upArrow) return setSelected(moveRow(at, 'up', rows.length))
        if (key.downArrow) return setSelected(moveRow(at, 'down', rows.length))
        if (key.return) return setDialog(openMenu(menu()))
        if (key.tab) return onNav('tab')
        if (key.leftArrow) return onNav('left')
        if (key.rightArrow) return onNav('right')
        if (input === '?') return setHelp((v) => !v)
        if (input === 'r') return data.reload()
        if (input === 'n' && data.actions[0] !== undefined) return start(data.actions[0])
        return
      }
      if (d.kind === 'note') {
        if (key.return || key.escape) setDialog(undefined)
        return
      }
      if (d.kind === 'menu') {
        if (key.escape) return setDialog(undefined)
        if (key.upArrow) return setDialog(menuMove(d, 'up'))
        if (key.downArrow) return setDialog(menuMove(d, 'down'))
        const picked = d.actions[d.index]
        if (key.return && picked !== undefined) start(picked)
        return
      }
      if (d.kind === 'confirm') {
        if (key.escape) return setDialog(undefined)
        const plain = d.action.confirm?.type === undefined
        if (plain && (input === 'n' || input === 'N')) return setDialog(undefined)
        if (plain && input === 'y') void execute(d.action, {})
        return
      }
      // form
      if (key.escape) return setDialog(undefined)
      if (key.upArrow) return setDialog(focusMove(d, 'up'))
      if (key.downArrow || key.tab) return setDialog(focusMove(d, 'down'))
      if (key.leftArrow) return setDialog(cycleOption(d, -1))
      if (key.rightArrow) return setDialog(cycleOption(d, 1))
      const field = d.action.fields?.[d.focus]
      if (field?.options !== undefined) {
        if (input === ' ') return setDialog(cycleOption(d, 1))
        if (key.return) advance(field.id, d.values[field.id] ?? '')
      }
    },
    { isActive: active && focus },
  )

  const hints = dialog === undefined ? rowHints(data.actions[0], wide) : dialogHints(dialog)
  const legendKey = JSON.stringify(hints)
  useEffect(() => {
    onLegend(hints)
  }, [legendKey])

  const inner = Math.max(10, width - 4)
  const listRows = Math.max(
    3,
    height -
      2 -
      (data.lines.length > 0 ? data.lines.length + 1 : 0) -
      (data.header === undefined ? 0 : 1) -
      (data.loading || working ? 1 : 0) -
      (row?.detail === undefined ? 0 : 2) -
      (said === undefined ? 0 : 2) -
      (help ? 1 + HELP_ROWS.length : 0) -
      (data.error === undefined ? 0 : 2),
  )
  const win = windowOf(at, rows.length, listRows)
  const dialogWidth = width

  if (dialog?.kind === 'menu') return <MenuDialog dialog={dialog} width={dialogWidth} />
  if (dialog?.kind === 'form')
    return (
      <FormDialog
        dialog={dialog}
        width={dialogWidth}
        onChange={(id, value) => {
          const c = ref.current
          if (c !== undefined) setDialog(setValue(c, id, value))
        }}
        onSubmit={advance}
      />
    )
  if (dialog?.kind === 'confirm')
    return (
      <ConfirmDialog
        dialog={dialog}
        width={dialogWidth}
        onChange={(typed) => {
          const c = ref.current
          if (c !== undefined && c.kind === 'confirm') setDialog({ ...c, typed, error: undefined })
        }}
        onSubmit={(typed) => {
          const c = ref.current
          if (c === undefined || c.kind !== 'confirm' || c.busy) return
          if (!confirmReady(c.action, typed))
            return setDialog({ ...c, typed, error: 'That does not match.' })
          void execute(c.action, {})
        }}
      />
    )
  if (dialog?.kind === 'note') return <NoteDialog note={dialog.note} width={dialogWidth} />
  const topRight: readonly FrameTag[] = count === undefined ? [] : [{ text: count }]
  return (
    <FramePanel
      width={width}
      top={[{ text: section.title }]}
      topRight={topRight}
      {...(bottom === undefined ? {} : { bottom: [{ text: bottom }] })}
      padX={1}
      grow
    >
      <SectionView
        data={data}
        rows={rows}
        start={win.start}
        end={win.end}
        at={at}
        focus={focus}
        working={working}
        said={said}
        help={help ? HELP_ROWS : undefined}
        width={inner}
      />
    </FramePanel>
  )
}
