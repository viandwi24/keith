import type { Dialog, LogsLevel, LogsScope } from '@keith/app-model/manage'
import type { Hint } from '@keith/ui'
import type { ActionSpec } from './manage-types.ts'

/** Priorities of the Manage legend: on a narrow terminal the lowest goes first, never a cut label. */
const KEEP = { esc: 90, enter: 80, move: 70, action: 60, tab: 30, reload: 20 } as const

/** The legend while the section list has the keys. */
export const NAV_HINTS: readonly Hint[] = [
  { key: '↑↓', action: 'section', priority: KEEP.move },
  { key: 'enter', action: 'open', priority: KEEP.enter },
  { key: 'esc', action: 'back', priority: KEEP.esc },
]

/**
 * The legend while a section's rows have the keys: select, the action menu, the first section
 * action under `n` (named, `[n] add a person`), reload, the way back to the list, help.
 */
export function rowHints(first: ActionSpec | undefined, wide: boolean): readonly Hint[] {
  return [
    { key: '↑↓', action: 'select', priority: KEEP.move },
    { key: 'enter', action: 'actions', priority: KEEP.enter },
    ...(first === undefined
      ? []
      : [{ key: 'n', action: first.label.toLowerCase(), priority: KEEP.action }]),
    { key: 'r', action: 'reload', priority: KEEP.reload },
    { key: 'tab', action: wide ? 'list' : 'next section', priority: KEEP.tab },
    { key: 'esc', action: 'back', priority: KEEP.esc },
    { key: '?', action: 'help' },
  ]
}

/** The legend of an open dialog. */
export function dialogHints(dialog: Dialog): readonly Hint[] {
  if (dialog.kind === 'menu')
    return [
      { key: '↑↓', action: 'choose', priority: KEEP.move },
      { key: 'enter', action: 'run', priority: KEEP.enter },
      { key: 'esc', action: 'close', priority: KEEP.esc },
    ]
  if (dialog.kind === 'form') {
    const last = dialog.focus === (dialog.action.fields?.length ?? 0) - 1
    return [
      { key: 'enter', action: last ? 'submit' : 'next', priority: KEEP.enter },
      { key: 'tab', action: 'next field', priority: KEEP.tab },
      { key: '←→', action: 'choose', priority: KEEP.tab + 5 },
      { key: 'esc', action: 'cancel', priority: KEEP.esc },
    ]
  }
  if (dialog.kind === 'confirm')
    return dialog.action.confirm?.type === undefined
      ? [
          { key: 'y', action: 'confirm', priority: KEEP.enter },
          { key: 'n', action: 'cancel', priority: KEEP.esc },
        ]
      : [
          { key: 'enter', action: 'confirm', priority: KEEP.enter },
          { key: 'esc', action: 'cancel', priority: KEEP.esc },
        ]
  return [{ key: 'enter', action: 'close', priority: KEEP.enter }]
}

export interface LogsLegendState {
  level: LogsLevel
  scope: LogsScope
  /** The owner may switch the scope (`logs.read`). */
  owner: boolean
  /** The screen is two panes: `tab` goes back to the section list. */
  wide: boolean
  /** The `/` filter is open: its own two keys. */
  filtering: boolean
}

/** The Logs legend, per level (activity-logs.md "TUI"). `esc` goes up one level; at the top it closes the screen. */
export function logsHints(s: LogsLegendState): readonly Hint[] {
  if (s.filtering)
    return [
      { key: 'enter', action: 'apply', priority: KEEP.enter },
      { key: 'esc', action: 'cancel', priority: KEEP.esc },
    ]
  const tab = { key: 'tab', action: s.wide ? 'list' : 'next section', priority: KEEP.tab }
  if (s.level === 'sessions')
    return [
      { key: '↑↓', action: 'select', priority: KEEP.move },
      { key: 'enter', action: 'open', priority: KEEP.enter },
      { key: '/', action: 'filter', priority: KEEP.action },
      { key: 'f', action: 'kind', priority: 40 },
      ...(s.owner
        ? [{ key: 's', action: s.scope === 'mine' ? 'everyone' : 'mine', priority: 40 }]
        : []),
      { key: 'r', action: 'reload', priority: KEEP.reload },
      tab,
      { key: 'esc', action: 'back', priority: KEEP.esc },
    ]
  if (s.level === 'session')
    return [
      { key: '↑↓', action: 'select', priority: KEEP.move },
      { key: 'enter', action: 'open', priority: KEEP.enter },
      { key: 'r', action: 'reload', priority: KEEP.reload },
      tab,
      { key: 'esc', action: 'up', priority: KEEP.esc },
    ]
  if (s.level === 'call')
    return [
      { key: '↑↓', action: 'scroll', priority: KEEP.move },
      { key: 'r', action: 'raw JSON', priority: KEEP.action },
      tab,
      { key: 'esc', action: 'up', priority: KEEP.esc },
    ]
  return [
    { key: '↑↓', action: 'scroll', priority: KEEP.move },
    tab,
    { key: 'esc', action: 'up', priority: KEEP.esc },
  ]
}
