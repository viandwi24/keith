import { describe, expect, test } from 'bun:test'
import { fitLegend } from '@keith/ui'
import { openAction, openMenu } from './dialog-state.ts'
import { dialogHints, logsHints, NAV_HINTS, rowHints } from './legend.ts'
import type { ActionSpec } from './manage-types.ts'

const run = async () => undefined
const add: ActionSpec = { id: 'add', label: 'Add a person', fields: [{ id: 'u', label: 'U' }], run }
const keys = (hints: readonly { key: string; action: string; priority?: number }[]) =>
  hints.map((h) => ({
    key: h.key,
    label: h.action,
    ...(h.priority ? { priority: h.priority } : {}),
  }))

describe('the Manage legend', () => {
  test('the first section action is named under n; a read-only section has no n', () => {
    expect(rowHints(add, true).find((h) => h.key === 'n')?.action).toBe('add a person')
    expect(rowHints(undefined, true).some((h) => h.key === 'n')).toBe(false)
  })

  test('no existing key lost: select, actions, reload, tab, esc, help', () => {
    const k = rowHints(add, false).map((h) => h.key)
    for (const key of ['↑↓', 'enter', 'n', 'r', 'tab', 'esc', '?']) expect(k).toContain(key)
    expect(rowHints(add, false).find((h) => h.key === 'tab')?.action).toBe('next section')
    expect(rowHints(add, true).find((h) => h.key === 'tab')?.action).toBe('list')
  })

  test('a narrow terminal drops reload and tab first and keeps esc, enter and help; never an ellipsis', () => {
    const fit = fitLegend(keys(rowHints(add, true)), 40)
    const kept = fit.keys.map((k) => k.key)
    expect(kept).toContain('esc')
    expect(kept).toContain('?')
    expect(kept).not.toContain('r')
    expect(fit.keys.map((k) => k.label).join('')).not.toContain('…')
  })

  test('every dialog says its keys: menu, form (submit on the last field), confirm, note', () => {
    const menu = openMenu([add])
    if (menu === undefined) throw new Error('no dialog')
    expect(dialogHints(menu).map((h) => h.key)).toEqual(['↑↓', 'enter', 'esc'])
    const form = openAction(add)
    if (form === undefined) throw new Error('no dialog')
    expect(dialogHints(form).find((h) => h.key === 'enter')?.action).toBe('submit')
    const confirm = openAction({ id: 'r', label: 'Remove', confirm: { text: 'sure?' }, run })
    if (confirm === undefined) throw new Error('no dialog')
    expect(dialogHints(confirm).map((h) => h.key)).toEqual(['y', 'n'])
    expect(dialogHints({ kind: 'note', note: { title: 't', lines: [] } })[0]?.key).toBe('enter')
    expect(NAV_HINTS.map((h) => h.key)).toEqual(['↑↓', 'enter', 'esc'])
  })
})

describe('the Logs legend', () => {
  const base = { scope: 'mine' as const, owner: false, wide: false, filtering: false }
  const keysOf = (hints: readonly { key: string }[]) => hints.map((h) => h.key)

  test('the sessions level: select, open, filter, kind, reload, back; the owner also has scope', () => {
    const member = keysOf(logsHints({ ...base, level: 'sessions' }))
    expect(member).toEqual(expect.arrayContaining(['↑↓', 'enter', '/', 'f', 'r', 'esc']))
    expect(member).not.toContain('s')
    const owner = logsHints({ ...base, level: 'sessions', owner: true })
    expect(owner.find((h) => h.key === 's')?.action).toBe('everyone')
    expect(
      logsHints({ ...base, level: 'sessions', owner: true, scope: 'everyone' }).find(
        (h) => h.key === 's',
      )?.action,
    ).toBe('mine')
  })

  test('the generation level names r as the raw JSON; the raw view only scrolls and goes up', () => {
    expect(logsHints({ ...base, level: 'call' }).find((h) => h.key === 'r')?.action).toBe(
      'raw JSON',
    )
    expect(keysOf(logsHints({ ...base, level: 'raw' }))).toEqual(['↑↓', 'tab', 'esc'])
  })

  test('the filter has its own two keys; no level names the trigger key t', () => {
    expect(keysOf(logsHints({ ...base, level: 'sessions', filtering: true }))).toEqual([
      'enter',
      'esc',
    ])
    for (const level of ['sessions', 'session', 'call', 'raw'] as const) {
      expect(keysOf(logsHints({ ...base, level, owner: true }))).not.toContain('t')
    }
  })

  test('tab reads list in two panes and next section in one', () => {
    expect(
      logsHints({ ...base, level: 'session', wide: true }).find((h) => h.key === 'tab')?.action,
    ).toBe('list')
    expect(logsHints({ ...base, level: 'session' }).find((h) => h.key === 'tab')?.action).toBe(
      'next section',
    )
  })
})
