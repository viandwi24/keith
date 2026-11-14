import { describe, expect, test } from 'bun:test'
import {
  clearSecrets,
  confirmReady,
  cycleOption,
  focusMove,
  initialValues,
  menuMove,
  missingField,
  needsDialog,
  openAction,
  openMenu,
  setValue,
  submitValues,
} from './dialog-state.ts'
import type { ActionSpec } from './manage-types.ts'

const run = async () => undefined
const form: ActionSpec = {
  id: 'x',
  label: 'Set password',
  fields: [
    { id: 'role', label: 'Role', options: ['member', 'owner'] },
    { id: 'password', label: 'Password', secret: true },
    { id: 'note', label: 'Note', optional: true },
  ],
  run,
}

describe('opening', () => {
  test('an action with fields or a confirmation opens a dialog; a bare one runs at once', () => {
    expect(needsDialog(form)).toBe(true)
    expect(needsDialog({ id: 'c', label: 'Remove', confirm: { text: 'sure?' }, run })).toBe(true)
    expect(needsDialog({ id: 'u', label: 'Unlock', run })).toBe(false)
  })

  test('a form starts with the initial values, else the first choice, else empty', () => {
    expect(initialValues(form.fields)).toEqual({ role: 'member', password: '', note: '' })
    expect(initialValues([{ id: 'a', label: 'A', initial: 'x', options: ['y', 'x'] }])).toEqual({
      a: 'x',
    })
    const d = openAction(form)
    expect(d.kind).toBe('form')
    expect(openAction({ id: 'c', label: 'Remove', confirm: { text: 's' }, run }).kind).toBe(
      'confirm',
    )
  })

  test('the menu opens only with something in it and stays inside the list', () => {
    expect(openMenu([])).toBeUndefined()
    let d = openMenu([form, form])
    expect(d?.kind).toBe('menu')
    if (d === undefined) return
    d = menuMove(d, 'up')
    expect(d.kind === 'menu' && d.index).toBe(0)
    d = menuMove(menuMove(d, 'down'), 'down')
    expect(d.kind === 'menu' && d.index).toBe(1)
  })
})

describe('form', () => {
  test('focus moves between the fields and stops at both ends', () => {
    let d = openAction(form)
    d = focusMove(d, 'up')
    expect(d.kind === 'form' && d.focus).toBe(0)
    d = focusMove(focusMove(focusMove(d, 'down'), 'down'), 'down')
    expect(d.kind === 'form' && d.focus).toBe(2)
  })

  test('a choice cycles with wrap; a text field ignores the cycle', () => {
    let d = openAction(form)
    d = cycleOption(d, 1)
    expect(d.kind === 'form' && d.values.role).toBe('owner')
    d = cycleOption(d, 1)
    expect(d.kind === 'form' && d.values.role).toBe('member')
    d = cycleOption(d, -1)
    expect(d.kind === 'form' && d.values.role).toBe('owner')
    const text = focusMove(focusMove(d, 'down'), 'down')
    expect(cycleOption(text, 1)).toBe(text)
  })

  test('required fields must be filled; optional ones may stay empty', () => {
    expect(missingField(form.fields ?? [], { role: 'member', password: '', note: '' })).toBe(
      'Password is required',
    )
    expect(missingField(form.fields ?? [], { role: 'member', password: 'x', note: '' })).toBe(
      undefined,
    )
    expect(missingField(form.fields ?? [], { role: 'member', password: '  ', note: '' })).toBe(
      'Password is required',
    )
  })

  test('secrets are dropped from state, the rest stays; the values to send still hold them', () => {
    let d = setValue(openAction(form), 'password', 'hunter2-hunter2')
    d = setValue(d, 'note', 'hello')
    expect(submitValues(d).password).toBe('hunter2-hunter2')
    const cleared = clearSecrets(d)
    expect(cleared.kind === 'form' && cleared.values).toEqual({ role: 'member', note: 'hello' })
    expect(JSON.stringify(cleared)).not.toContain('hunter2')
  })
})

describe('confirm', () => {
  test('a typed word must match exactly', () => {
    const transfer: ActionSpec = {
      id: 't',
      label: 'Transfer',
      confirm: { text: 'sure?', type: 'ana' },
      run,
    }
    expect(confirmReady(transfer, 'an')).toBe(false)
    expect(confirmReady(transfer, 'Ana')).toBe(false)
    expect(confirmReady(transfer, 'ana')).toBe(true)
    expect(confirmReady({ id: 'r', label: 'R', confirm: { text: 's' }, run }, '')).toBe(true)
  })
})
