import type { SignIn, SignInPerson, SignInState } from '@keith/client'
import { useEffect, useState } from 'react'

export interface LoginResult {
  /** The core the app should now use (address as the controller normalized it). */
  core: string
  /** Who signed in; missing for the local socket and when the core did not say. */
  person?: SignInPerson | undefined
  /** A warning to show with the sign-in (the login it replaced could not be revoked). */
  note?: string | undefined
}

/** The controller's state, kept in React (a resync after subscribing catches an early change). */
export function useSignInState(signIn: SignIn): SignInState {
  const [state, setState] = useState<SignInState>(() => signIn.get())
  useEffect(() => {
    setState(signIn.get())
    return signIn.subscribe(setState)
  }, [signIn])
  return state
}

/** A countdown is on screen: a device code, or a throttled answer that tells when to try again. */
export const hasCountdown = (s: SignInState): boolean =>
  (s.step === 'device' && s.expiresAt !== undefined) ||
  ((s.step === 'identify' || s.step === 'flow') && s.problem?.retryAt !== undefined)

/** A clock that ticks every `tickMs` while `live` (a countdown shows), else rests. */
export function useClock(now: () => number, tickMs: number, live: boolean): number {
  const [t, setT] = useState(() => now())
  useEffect(() => {
    if (!live) return undefined
    setT(now())
    const timer = setInterval(() => setT(now()), tickMs)
    return () => clearInterval(timer)
  }, [live, now, tickMs])
  return t
}

/** After `done` shows for `doneMs`, tell the app (once per `done`). */
export function useDone(
  state: SignInState,
  doneMs: number,
  onDone: (result: LoginResult) => void,
): void {
  const done = state.step === 'done' ? state : undefined
  useEffect(() => {
    if (done === undefined) return undefined
    const timer = setTimeout(
      () =>
        onDone({
          core: done.core,
          ...(done.person === undefined ? {} : { person: done.person }),
          ...(done.note === undefined ? {} : { note: done.note }),
        }),
      doneMs,
    )
    return () => clearTimeout(timer)
    // onDone is read once per `done`: a new callback identity must not restart the wait
  }, [done, doneMs])
}
