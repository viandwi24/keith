import type { SignInMethodItem, SignInState } from '@keith/client/browser'
import type { StepField } from '@keith/contracts'
import { G } from '@keith/ui/tokens'

type Flow = Extract<SignInState, { step: 'flow' }>

/** The page speaks plain HTTP to something that is not this machine: a secret typed here crosses the network in the clear. */
export function isPlainLan(page: { protocol: string; hostname: string }): boolean {
  if (page.protocol !== 'http:') return false
  const host = page.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const loopback =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127(\.\d{1,3}){3}$/.test(host)
  return !loopback
}

/** The warning shows on a secret field when the core sees a LAN client or this page is plain HTTP off loopback. */
export const showLanWarning = (flow: Flow, plain: boolean, secret: boolean): boolean =>
  secret &&
  flow.methods.find((m) => m.id === flow.method)?.available === true &&
  (flow.context === 'lan' || plain)

/** The setup hint shows when the sign-in cannot start: the core is unreachable or lists no usable method. */
export function showSetupHint(state: SignInState): boolean {
  if (state.step === 'error') return true
  return state.step === 'flow' && !state.methods.some((m) => m.available)
}

/** A tab's label: a refused method carries `!` (the TUI's `! label`). */
export const tabLabel = (m: SignInMethodItem): string =>
  m.available ? m.label : `${G.warn} ${m.label}`

export const isSecretField = (f: StepField): boolean => f.kind === 'secret' || f.mask === true

/** A digits field takes digits only (a pasted `123 456` loses the space). */
export const cleanFieldValue = (f: StepField, value: string): string =>
  f.kind === 'digits' ? value.replace(/\D/g, '') : value

export interface FieldAttrs {
  type: 'text' | 'password'
  inputmode: 'text' | 'numeric'
  autocomplete: string
  maxlength: number | undefined
  mono: boolean
}

/** How a step field is drawn from its description: no code per method. */
export function fieldAttrs(f: StepField): FieldAttrs {
  return {
    type: isSecretField(f) ? 'password' : 'text',
    inputmode: f.kind === 'digits' ? 'numeric' : 'text',
    autocomplete: f.kind === 'secret' ? 'current-password' : 'off',
    maxlength: f.length,
    mono: f.kind === 'digits' || f.kind === 'code' || f.kind === 'secret',
  }
}

/** The first field still empty, or -1 when every field has a value. */
export const firstEmpty = (
  fields: readonly StepField[],
  values: Readonly<Record<string, string>>,
): number => fields.findIndex((f) => (values[f.name] ?? '') === '')

/** The text of a busy state. */
export const busyText = (state: SignInState): string =>
  state.step === 'working' && state.method !== undefined ? 'signing in …' : 'asking the core …'
