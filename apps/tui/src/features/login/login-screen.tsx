import type { SignIn } from '@keith/client'
import { FooterProvider, GUTTER, ScreenFrame, useFooterContent } from '@keith/ui'
import { Fragment, type ReactNode } from 'react'
import { SignInBody } from './sign-in-body.tsx'
import { hasCountdown, type LoginResult, useClock, useDone, useSignInState } from './use-sign-in.ts'

export type { LoginResult } from './use-sign-in.ts'

export interface LoginScreenProps {
  /** The sign-in controller (`createSignIn` from `@keith/client`); the screen never builds it. */
  signIn: SignIn
  /** The address the field starts with when the controller has none. */
  initialCore?: string
  /** Signed in (or the socket chosen): swap the connection to `result.core`. */
  onDone(result: LoginResult): void
  /** Offer "remember this device" (ctrl+r) on a method that can be remembered. */
  offerRemember?: boolean
  /** `esc` on the first step. */
  onCancel(): void
  /** Terminal width (default 100; at least 60 is drawn well). */
  columns?: number
  /** Clock for the countdowns (default `Date.now`); tests inject a fake one. */
  now?: () => number
  /** Countdown tick in ms (default 1000). */
  tickMs?: number
  /** How long the `done` line stays before `onDone` (default 700 ms). */
  doneMs?: number
}

/** The frame of the screen; the legend is whatever the step on screen asked for (`useFooter`). */
export function Framed({
  columns,
  label = 'Sign in',
  children,
}: {
  columns: number
  label?: string
  children: ReactNode
}) {
  const legend = useFooterContent()
  return (
    <ScreenFrame width={columns} label={label} {...(legend === undefined ? {} : { legend })}>
      {children}
    </ScreenFrame>
  )
}

const systemNow = (): number => Date.now()

/**
 * The Sign in screen (docs/specs/tui-login.md): renders the sign-in controller one step at a time.
 * Secrets live only in the field being typed; the controller never holds them either.
 */
export function LoginScreen({
  signIn,
  initialCore = '',
  onDone,
  onCancel,
  offerRemember = false,
  columns = 100,
  now = systemNow,
  tickMs = 1000,
  doneMs = 700,
}: LoginScreenProps) {
  const state = useSignInState(signIn)
  const clock = useClock(now, tickMs, hasCountdown(state))
  useDone(state, doneMs, onDone)
  const width = Math.max(40, columns - GUTTER)
  // a step is a new component: its fields start fresh and never carry a secret over
  return (
    <FooterProvider>
      <Framed columns={columns}>
        <Fragment key={state.step}>
          <SignInBody
            signIn={signIn}
            state={state}
            width={width}
            now={clock}
            initialCore={initialCore}
            offerRemember={offerRemember}
            onCancel={onCancel}
            onSocket={(address) => onDone({ core: address })}
          />
        </Fragment>
      </Framed>
    </FooterProvider>
  )
}
