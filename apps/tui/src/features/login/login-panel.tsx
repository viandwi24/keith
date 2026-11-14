import type { SignIn } from '@keith/client'
import { FramePanel } from '@keith/ui'
import { Fragment } from 'react'
import { SignInBody } from './sign-in-body.tsx'
import { hasCountdown, type LoginResult, useClock, useDone, useSignInState } from './use-sign-in.ts'

export interface LoginPanelProps {
  /** The sign-in controller, already pointed at the core (the panel never builds it). */
  signIn: SignIn
  /** Cells, borders included. */
  width: number
  /** Signed in: swap the connection to `result.core`. */
  onDone(result: LoginResult): void
  /** Offer "remember this device" (an http core: default off; the socket never keeps a login). */
  offerRemember?: boolean
  /** Clock for the countdowns (default `Date.now`); tests inject a fake one. */
  now?: () => number
  /** Countdown tick in ms (default 1000). */
  tickMs?: number
  /** How long the `done` line stays before `onDone` (default 700 ms). */
  doneMs?: number
}

const systemNow = (): number => Date.now()

/**
 * Home's login panel (tui-design 5.16, tui-login.md): a `FramePanel` labelled `Sign in` that
 * renders the same controller states as the Sign in screen, with no address step. Its legend is
 * the one the step on screen asked for (`useFooter`); Home draws it.
 */
export function LoginPanel({
  signIn,
  width,
  onDone,
  offerRemember = false,
  now = systemNow,
  tickMs = 1000,
  doneMs = 700,
}: LoginPanelProps) {
  const state = useSignInState(signIn)
  const clock = useClock(now, tickMs, hasCountdown(state))
  useDone(state, doneMs, onDone)
  return (
    <FramePanel width={width} top={[{ text: 'Sign in' }]} padX={1}>
      <Fragment key={state.step}>
        <SignInBody
          signIn={signIn}
          state={state}
          width={Math.max(20, width - 4)}
          now={clock}
          embedded
          offerRemember={offerRemember}
          onCancel={() => signIn.back()}
          onSocket={(address) => onDone({ core: address })}
        />
      </Fragment>
    </FramePanel>
  )
}
