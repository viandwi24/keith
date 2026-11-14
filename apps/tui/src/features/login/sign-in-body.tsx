import type { SignIn, SignInState } from '@keith/client'
import { FlowStep, IdentifyStep } from './login-form.tsx'
import { AddressStep, Busy, DeviceStep, DoneStep, ErrorStep, SocketStep } from './login-steps.tsx'

export interface SignInBodyProps {
  signIn: SignIn
  state: SignInState
  /** Content width (columns minus the gutter). */
  width: number
  /** The clock, ticking while a countdown is on screen. */
  now: number
  /** The address the field starts with when the controller has none. */
  initialCore?: string
  /** Home's panel: the identifier box has no step behind it, and the socket is never asked. */
  embedded?: boolean
  /** Offer "remember this device" on a method that can be remembered (not on the socket). */
  offerRemember?: boolean
  /** `esc` on the address step. */
  onCancel(): void
  /** Continue on the local socket step. */
  onSocket(address: string): void
}

/**
 * One step of the sign-in controller as a component, shared by the Sign in screen and Home's panel.
 * A step is a new component: its fields start fresh and never carry a secret over.
 */
export function SignInBody({
  signIn,
  state,
  width,
  now,
  initialCore = '',
  embedded = false,
  offerRemember = false,
  onCancel,
  onSocket,
}: SignInBodyProps) {
  const common = { signIn, width, now, embedded }
  switch (state.step) {
    case 'address':
      return <AddressStep {...common} state={state} initial={initialCore} onCancel={onCancel} />
    case 'socket':
      return (
        <SocketStep state={state} onContinue={() => onSocket(state.address)} onCancel={onCancel} />
      )
    case 'checking':
      return <Busy signIn={signIn} text="asking the core ..." />
    case 'identify':
      return <IdentifyStep {...common} state={state} />
    case 'working':
      return (
        <Busy
          signIn={signIn}
          text={state.method === undefined ? 'asking the core ...' : 'signing in ...'}
        />
      )
    case 'flow':
      return <FlowStep {...common} state={state} offerRemember={offerRemember} />
    case 'device':
      return <DeviceStep {...common} state={state} />
    case 'done':
      return <DoneStep state={state} />
    case 'error':
      return <ErrorStep {...common} state={state} />
  }
}
