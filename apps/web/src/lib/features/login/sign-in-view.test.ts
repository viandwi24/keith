import { describe, expect, test } from 'bun:test'
import type { SignInState } from '@keith/client/browser'
import type { StepField } from '@keith/contracts'
import {
  busyText,
  cleanFieldValue,
  fieldAttrs,
  firstEmpty,
  isPlainLan,
  showLanWarning,
  showSetupHint,
  tabLabel,
} from './sign-in-view.ts'

const flow = (over: Partial<Extract<SignInState, { step: 'flow' }>> = {}) =>
  ({
    step: 'flow',
    core: 'http://x',
    info: { version: '1', sha: 'a' },
    identifier: 'ana',
    context: 'public',
    methods: [
      {
        id: 'pin',
        label: 'PIN',
        available: true,
        assurance: 1,
        interaction: 'form',
        firstStep: { id: 'pin', fields: [] },
      },
    ],
    method: 'pin',
    current: { id: 'pin', fields: [] },
    ...over,
  }) as Extract<SignInState, { step: 'flow' }>

describe('isPlainLan', () => {
  test('plain HTTP off loopback only', () => {
    expect(isPlainLan({ protocol: 'http:', hostname: '192.168.1.5' })).toBe(true)
    expect(isPlainLan({ protocol: 'http:', hostname: 'keith.lan' })).toBe(true)
    expect(isPlainLan({ protocol: 'https:', hostname: 'keith.example' })).toBe(false)
    for (const hostname of ['localhost', '127.0.0.1', '[::1]', 'dev.localhost'])
      expect(isPlainLan({ protocol: 'http:', hostname })).toBe(false)
  })
})

describe('warnings and hints', () => {
  test('the LAN warning needs a secret and a usable method', () => {
    expect(showLanWarning(flow(), true, true)).toBe(true)
    expect(showLanWarning(flow({ context: 'lan' }), false, true)).toBe(true)
    expect(showLanWarning(flow(), false, true)).toBe(false)
    expect(showLanWarning(flow(), true, false)).toBe(false)
  })
  test('the setup hint shows on an error or when no method is usable', () => {
    expect(
      showSetupHint({
        step: 'error',
        core: 'x',
        reason: 'unreachable',
        message: 'm',
        retryable: true,
      }),
    ).toBe(true)
    expect(showSetupHint(flow())).toBe(false)
    const none = flow()
    expect(
      showSetupHint({ ...none, methods: none.methods.map((m) => ({ ...m, available: false })) }),
    ).toBe(true)
    expect(showSetupHint({ step: 'checking', core: 'x' })).toBe(false)
  })
  test('tab labels mark a refused method', () => {
    const m = flow().methods[0]
    if (m === undefined) throw new Error('method')
    expect(tabLabel(m)).toBe('PIN')
    expect(tabLabel({ ...m, available: false })).toBe('! PIN')
  })
  test('busy text', () => {
    expect(busyText({ step: 'working', core: 'x', method: 'pin' })).toBe('signing in …')
    expect(busyText({ step: 'checking', core: 'x' })).toBe('asking the core …')
  })
})

describe('step fields', () => {
  const pin: StepField = { name: 'pin', label: 'PIN', kind: 'digits', mask: true, length: 6 }
  const code: StepField = { name: 'code', label: 'Code', kind: 'code' }
  test('drawn from their description', () => {
    expect(fieldAttrs(pin)).toMatchObject({
      type: 'password',
      inputmode: 'numeric',
      maxlength: 6,
      mono: true,
    })
    expect(fieldAttrs(code)).toMatchObject({ type: 'text', inputmode: 'text', mono: true })
    expect(fieldAttrs({ name: 'p', label: 'Password', kind: 'secret' })).toMatchObject({
      type: 'password',
      autocomplete: 'current-password',
    })
  })
  test('digits lose non-digits; other fields are untouched', () => {
    expect(cleanFieldValue(pin, '123 456')).toBe('123456')
    expect(cleanFieldValue(code, 'KT-4')).toBe('KT-4')
  })
  test('first empty field', () => {
    expect(firstEmpty([pin, code], { pin: '1' })).toBe(1)
    expect(firstEmpty([pin, code], { pin: '1', code: 'x' })).toBe(-1)
  })
})
